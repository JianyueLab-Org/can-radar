<script setup lang="ts">
/**
 * The live map.
 *
 * Two things it deliberately does NOT do, both learned from the previous
 * version and from how vatsim-radar draws its map:
 *
 * 1. It never tears the map down to redraw it. Markers, boundary polygons and
 *    the tile layer are created once and then *updated in place* every poll —
 *    so tiles never re-fetch and a 30-second refresh costs a few `setLatLng`
 *    calls instead of rebuilding several thousand DOM nodes and re-parsing
 *    2 MB of GeoJSON.
 * 2. It draws no detail panels of its own. Clicking anything selects it, and
 *    RadarDetails renders the details beside the map; the only HTML this
 *    builds is the one-line hover label, and the network text in it still goes
 *    through `escapeHtml`.
 *
 * Colour carries altitude (the viridis ramp vatsim-radar uses), so the traffic
 * picture reads without opening anything.
 */
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { airportAt, loadAirports } from "@/lib/airports";
import { getFacilityName } from "@/lib/facilities";
import {
  altitudeColor,
  distanceNm,
  escapeHtml,
  facilityColor,
  facilityLetter,
  facilityRank,
  flightLevel,
  greatCircle,
  isOnGround,
  stationAirport,
  type LatLon,
} from "@/lib/radar";
import type { Controller, Pilot, AtisData } from "@/lib/radarTypes";
import type { RadarSettings } from "@/lib/radarState";

const props = defineProps<{
  controllers: Controller[];
  pilots: Pilot[];
  atis: AtisData[];
  theme: "dark" | "light";
  /** `pilot:<cid>` / `atc:<callsign>`, kept in sync with the traffic list. */
  selected?: string | null;
  /** The viewer's own preferences — basemap and which layers are drawn. */
  settings: RadarSettings;
  /** Centre and zoom to open at, from a shared link. Read once, on setup. */
  initialView?: { lat: number | null; lon: number | null; zoom: number | null };
}>();

const emit = defineEmits<{
  (e: "select", key: string | null): void;
  /** Reported so the parent can put the viewport in the URL. */
  (e: "move", view: { lat: number; lon: number; zoom: number }): void;
}>();

/** Below this zoom, parked and taxiing aircraft are hidden — at world scale a
 *  busy apron is one illegible blob and the airborne picture is what matters. */
const GROUND_TRAFFIC_MIN_ZOOM = 6;
/** Points asked of /api/v1/track. The endpoint caps this at 2000; 1200 is
 *  several hours of a sampled track, more than any one flight needs. */
const TRACK_POINTS = 1200;
/** A controller's `visual_range` is in nautical miles; absurd values (an FSS
 *  filing 1500nm) would swamp the map, so the ring is clamped. */
const MAX_RANGE_NM = 400;

const TILES: Record<"dark" | "light", string> = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

/**
 * 卫星底图。
 *
 * 单独一条而不是并进 TILES，因为它和深浅两套不是同一个维度：深浅跟着主题走，卫
 * 星是人主动选的。它也没有 `{s}` 子域和 `{r}` 高清后缀 —— 照抄 CARTO 的模板会得
 * 到一片 404。
 */
const SATELLITE_TILE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const SATELLITE_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";

/** 当前该用哪张底图。auto 跟主题，其余听设置的。 */
function tileUrl(): string {
  switch (props.settings.basemap) {
    case "satellite":
      return SATELLITE_TILE;
    case "dark":
      return TILES.dark;
    case "light":
      return TILES.light;
    default:
      return TILES[props.theme];
  }
}

/** 卫星图的子域和高清后缀都不支持，所以选项要跟着底图换。 */
function tileOptions(): { subdomains: string; maxZoom: number } {
  return props.settings.basemap === "satellite"
    ? { subdomains: "", maxZoom: 18 }
    : { subdomains: "abcd", maxZoom: 18 };
}

const mapContainer = ref<HTMLDivElement | null>(null);

let map: L.Map | null = null;
let tileLayer: L.TileLayer | null = null;
let airborneLayer: L.LayerGroup | null = null;
let groundLayer: L.LayerGroup | null = null;
let atcLayer: L.LayerGroup | null = null;
let rangeLayer: L.LayerGroup | null = null;
let boundariesLayer: L.LayerGroup | null = null;
let quietBoundariesLayer: L.LayerGroup | null = null;
let routeLayer: L.LayerGroup | null = null;
/** The flown track: one polyline per run of same-altitude points, so the line
 *  itself carries the vertical profile. */
let trailLayer: L.LayerGroup | null = null;
let resizeObserver: ResizeObserver | null = null;

/** A recorded position: where, and how high. */
type TrailPoint = [lat: number, lon: number, altitude: number];

/** Aircraft markers, keyed the same way as `props.selected`. */
const pilotMarkers = new Map<string, L.Marker>();
/** Airport tags, keyed by airport code — one tag carries every position
 *  working that field, so it cannot be keyed by a single callsign. */
const atcMarkers = new Map<string, L.Marker>();
/** Sector tags for the CTR/FSS positions, keyed by `props.selected`'s key. */
const sectorMarkers = new Map<string, L.Marker>();
/** Icon inputs a marker was last drawn with, so we only rebuild its DOM when
 *  something visible actually changed. */
const iconSignatures = new Map<string, string>();
/** Latest datum per key — the details panel and `focus()` read through this. */
const pilotData = new Map<string, Pilot>();
const atcData = new Map<string, Controller>();
/** Coverage rings for the positions that have a point on the map. */
const rangeCircles = new Map<string, L.Circle>();
/** The selected flight's track, as recorded by can-fsd. Nothing is
 *  accumulated in the browser — see loadTrack. */
let track: TrailPoint[] = [];
let trackKey: string | null = null;

/** Boundary polygons, built once from the GeoJSON and restyled thereafter. */
const boundaryShapes = new Map<string, L.GeoJSON[]>();
let boundaryControllers = new Map<string, Controller[]>();
let activeBoundaries = new Set<string>();

let didInitialFit = false;

const pilotKey = (p: Pilot) => `pilot:${p.cid || p.callsign}`;
const atcKey = (c: Controller) => `atc:${c.callsign}`;

/* ------------------------------------------------------------------ *
 * Controller ↔ boundary matching (unchanged behaviour, kept verbatim)
 * ------------------------------------------------------------------ */

/**
 * Every boundary id the loaded GeoJSON actually carries, lowercased.
 *
 * A split sector is only a split sector if VATSpy draws one — see `sectorOf`.
 */
const knownBoundaryIds = new Set<string>();

/**
 * The boundary id a split-sector callsign names, or "" if it names none.
 *
 * `RJDG_S_CTR` → `rjdg-s`. Only the middle segment of a three-part callsign is
 * read this way, and only when it is short: `ZSSS_APP` has no middle segment,
 * and `RJTG_OCEANIC_CTR` names a job rather than a sector.
 *
 * The reading also has to be confirmed against the data. `HKG_W_CTR` has the
 * shape of a split sector but there is no `HKG-W` polygon — Hong Kong is one
 * undivided `VHHK`, reached through the short-code mapping further down. Left
 * unchecked, the sector rule claimed that callsign and then matched nothing,
 * so working the west sector drew no airspace at all.
 */
function sectorOf(callsign: string): string {
  const parts = callsign.split("_");
  if (parts.length !== 3) return "";

  const [fir, sector] = parts;
  if (!fir || sector.length > 2 || !/^[a-z0-9]+$/.test(sector)) return "";
  if (sector === "o") return ""; // oceanic, handled separately

  const id = `${fir}-${sector}`;
  return knownBoundaryIds.has(id) ? id : "";
}

function matchControllerToBoundary(
  controllerCallsign: string,
  boundaryId: string,
): boolean {
  const shortCodeToIcaoMapping: { [key: string]: string } = {
    lax: "kzla",
    hkg: "vhhk",
    tpe: "rcaa",
  };

  const prcFssAreas = [
    "zysh",
    "zbpe",
    "zsha",
    "zhwh",
    "zgzu",
    "zpkm",
    "zlhw",
    "zwuq",
    "zjsa",
  ];

  if (!controllerCallsign || !boundaryId) return false;

  const controller = controllerCallsign.toLowerCase();
  const boundary = boundaryId.toLowerCase();

  if (controller === boundary) return true;

  // Split sectors are decided before anything else, because the generic rules
  // below cannot tell them apart from their parent.
  //
  // VATSpy spells a sector as `RJDG-S`, and a controller spells the same thing
  // as `RJDG_S_CTR`. On the old rules that callsign matched the *parent* FIR
  // (`RJDG` is a prefix of `rjdg_s_ctr`), so working Okinawa lit the whole of
  // Japan and hung the label over Osaka — while `RJDG-S`, the polygon that was
  // actually wanted, matched nothing at all.
  const sector = sectorOf(controller);
  if (sector) return boundary === sector;

  // A controller without a sector suffix works the whole FIR, so they take the
  // parent polygon and none of its subdivisions.
  if (boundary.includes("-")) {
    const parent = boundary.slice(0, boundary.indexOf("-"));
    if (controller.startsWith(parent + "_") || controller === parent)
      return false;
  }

  if (
    controller.startsWith(boundary + "_") ||
    boundary.startsWith(controller + "_")
  )
    return true;

  if (controller === "prc_fss") {
    const boundaryCode = boundary.substring(0, 4).toLowerCase();
    return prcFssAreas.includes(boundaryCode);
  }

  const controllerParts = controller.split("_");
  const boundaryParts = boundary.split("_");

  if (controllerParts.length >= 2 && boundaryParts.length >= 1) {
    const mappedIcao = shortCodeToIcaoMapping[controllerParts[0]];
    if (mappedIcao && boundaryParts[0].startsWith(mappedIcao)) {
      if (controllerParts.length >= 3 && boundaryParts.length >= 2) {
        return (
          controllerParts[controllerParts.length - 1] ===
          boundaryParts[boundaryParts.length - 1]
        );
      }
      return true;
    }
  }

  if (boundaryParts.length >= 2 && controllerParts.length >= 1) {
    const mappedIcao = shortCodeToIcaoMapping[boundaryParts[0]];
    if (mappedIcao && controllerParts[0].startsWith(mappedIcao)) {
      if (controllerParts.length >= 2 && boundaryParts.length >= 3) {
        return (
          controllerParts[controllerParts.length - 1] ===
          boundaryParts[boundaryParts.length - 1]
        );
      }
      return true;
    }
  }

  for (const controllerPart of controllerParts) {
    for (const boundaryPart of boundaryParts) {
      if (controllerPart === boundaryPart && controllerPart.length >= 3) {
        return true;
      }
    }
  }

  return false;
}

/** CTR/FSS positions own an area rather than a point on the map. */
function ownsAirspace(controller: Controller): boolean {
  return (
    controller.facility === 6 ||
    controller.facility === 7 ||
    (controller.facility === 1 &&
      controller.callsign.toLowerCase() === "prc_fss")
  );
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

function iconScale(): number {
  const zoom = map?.getZoom() ?? 6;
  if (zoom <= 4) return 20;
  if (zoom <= 6) return 24;
  if (zoom <= 8) return 28;
  if (zoom <= 10) return 32;
  return 36;
}

/** Everything a pilot marker's appearance depends on. An unchanged signature
 *  means the marker's DOM can stay exactly as it is. */
function pilotSignature(pilot: Pilot, selected: boolean): string {
  return [
    isOnGround(pilot) ? "g" : "a",
    Math.round(pilot.heading),
    altitudeColor(pilot.altitude, props.theme),
    iconScale(),
    selected ? "s" : "",
  ].join("|");
}

/**
 * An aircraft: the same silhouette on the ground as in the air, rotated to its
 * heading.
 *
 * A taxiing aircraft used to be a square dot, which threw away the one thing a
 * ground picture is read for — which way the nose is pointing. It is drawn a
 * little smaller and a little softer than an airborne one instead, so the apron
 * stays legible without pretending the aircraft has no direction.
 *
 * The silhouette points up-right in its own viewBox, hence the 45° offset
 * before the heading is applied.
 */
function aircraftIcon(pilot: Pilot, selected: boolean): L.DivIcon {
  const color = altitudeColor(pilot.altitude, props.theme);
  const onGround = isOnGround(pilot);

  const size = onGround
    ? Math.max(16, Math.round(iconScale() * 0.72))
    : iconScale();
  const anchor = size / 2;
  const svgSize = size - 4;

  return L.divIcon({
    className: "aircraft-marker",
    html: `
      <div style="
        width:${size}px;height:${size}px;
        transform: rotate(${pilot.heading - 45}deg);
        display:flex;align-items:center;justify-content:center;
        ${selected ? "border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.7);" : ""}
      ">
        <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 24 24" fill="none"
          stroke="${color}" stroke-width="${onGround ? 2.4 : 2}"
          stroke-linecap="round" stroke-linejoin="round"
          style="opacity:${onGround ? 0.8 : 1};filter: drop-shadow(0 1px 3px rgba(0,0,0,.45));">
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
        </svg>
      </div>
      <span class="aircraft-label">${escapeHtml(pilot.callsign)}</span>
    `,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

/**
 * A coverage ring, for the positions that have nothing better.
 *
 * CTR/FSS are drawn as their FIR polygon and approach as its SimAware TRACON;
 * the ring is only for what neither covers — an approach at a field SimAware
 * has not mapped, mostly. It is `visual_range`, the radius FSD uses to decide
 * who a controller can see, which is a poor stand-in for what they control and
 * used only where there is no geometry at all.
 *
 * Deliberately not drawn for clearance, ground and tower: they work the field
 * their tag already sits on, and three overlapping circles around one airport
 * say nothing three times.
 */
function rangeStyle(color: string, selected: boolean): L.PathOptions {
  return selected
    ? {
        color,
        weight: 1.5,
        opacity: 0.9,
        fill: true,
        fillColor: color,
        fillOpacity: 0.06,
      }
    : { color, weight: 1, opacity: 0.3, fill: false, dashArray: "4 6" };
}

/**
 * A position tag, the way vatsim-radar labels staffed airports.
 *
 * Everything working one airport — DEL, GND, TWR, APP and the ATIS — is one
 * tag: the ICAO, then a chip per position coloured by facility. That reads at
 * a glance ("ZSSS has ground and tower") where five identical blue dots
 * stacked on the same airport did not, and it is one target to click rather
 * than five overlapping ones.
 *
 * Each chip carries its own `data-key`, so the click handler can tell which
 * position was hit.
 */
function tagIcon(
  code: string,
  chips: Array<{ key: string; label: string; facility: number }>,
  selectedKey: string | null,
  stack = 0,
): L.DivIcon {
  const rendered = chips
    .map(
      (
        chip,
      ) => `<span class="radar-tag__chip${chip.key === selectedKey ? " is-selected" : ""}"
          data-key="${escapeHtml(chip.key)}"
          style="background:${facilityColor(chip.facility)}"
        >${escapeHtml(chip.label)}</span>`,
    )
    .join("");

  return L.divIcon({
    className: "radar-tag-icon",
    html: `<span class="radar-tag__pin"></span>
      <div class="radar-tag${chips.some((c) => c.key === selectedKey) ? " is-selected" : ""}"
        style="--radar-tag-row:${stack}">
        ${
          code
            ? // 机场代码本身也是一个可点的目标：点它开机场视图，点右边的方块仍
              // 然选那个席位。两者共用 clickedKey 的 data-key 解析，所以这里加
              // 一个属性就够了，不需要第二条事件通路。
              `<span class="radar-tag__code" data-key="apt:${escapeHtml(code)}">${escapeHtml(code)}</span>`
            : ""
        }
        <span class="radar-tag__chips">${rendered}</span>
      </div>`,
    // The tag sizes itself from its content; the CSS centres it on the point.
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/** The `data-key` of whichever chip was clicked, else the tag's first. */
function clickedKey(event: L.LeafletMouseEvent, fallback: string): string {
  const target = event.originalEvent?.target as HTMLElement | null;
  return target?.closest<HTMLElement>("[data-key]")?.dataset.key ?? fallback;
}

/* ------------------------------------------------------------------ *
 * Incremental sync
 * ------------------------------------------------------------------ */

function syncPilots() {
  if (!airborneLayer || !groundLayer) return;
  const seen = new Set<string>();

  for (const pilot of props.pilots) {
    const { latitude: lat, longitude: lon } = pilot;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = pilotKey(pilot);
    seen.add(key);
    pilotData.set(key, pilot);

    const onGround = isOnGround(pilot);
    const selected = props.selected === key;
    const signature = pilotSignature(pilot, selected);

    let marker = pilotMarkers.get(key);
    if (!marker) {
      marker = L.marker([lat, lon], {
        icon: aircraftIcon(pilot, selected),
        riseOnHover: true,
      });
      marker.bindTooltip(() => pilotTooltip(key), {
        direction: "top",
        offset: [0, -8],
      });
      marker.on("click", () => emit("select", key));
      pilotMarkers.set(key, marker);
      iconSignatures.set(key, signature);
      (onGround ? groundLayer : airborneLayer).addLayer(marker);
    } else {
      marker.setLatLng([lat, lon]);
      if (iconSignatures.get(key) !== signature) {
        marker.setIcon(aircraftIcon(pilot, selected));
        iconSignatures.set(key, signature);
      }
      // Took off or landed since the last poll — move it between the layers
      // that the zoom-based ground filter switches on and off.
      const target = onGround ? groundLayer : airborneLayer;
      const other = onGround ? airborneLayer : groundLayer;
      if (other.hasLayer(marker)) {
        other.removeLayer(marker);
        target.addLayer(marker);
      }
    }
  }

  for (const [key, marker] of pilotMarkers) {
    if (seen.has(key)) continue;
    airborneLayer.removeLayer(marker);
    groundLayer.removeLayer(marker);
    pilotMarkers.delete(key);
    iconSignatures.delete(key);
    pilotData.delete(key);
    if (props.selected === key) emit("select", null);
  }
}

function pilotTooltip(key: string): string {
  const p = pilotData.get(key);
  if (!p) return "";
  const type = p.flight_plan?.aircraft
    ? ` · ${escapeHtml(p.flight_plan.aircraft)}`
    : "";
  return `<span style="font-weight:600">${escapeHtml(p.callsign)}</span>${type}
    <span style="opacity:.7"> · FL${flightLevel(Math.round(p.altitude))} · ${p.groundspeed}kt</span>`;
}

/** One tag's worth of positions. */
type StationGroup = {
  code: string;
  lat: number;
  lon: number;
  /** True for the airport tag; false for approach and anything else standing
   *  alone. Decides which tag keeps the anchor point when they collide. */
  local: boolean;
  /** Row within a stack of tags sharing this position; 0 sits on the point. */
  stack: number;
  stations: Array<{
    station: Controller;
    key: string;
    facility: number;
    isAtis: boolean;
  }>;
};

/**
 * The positions that share an airport's tag: clearance, ground, tower and the
 * ATIS. They all sit on the field itself, so one label answers "what is open
 * at ZSSS".
 *
 * Approach does not belong in it — it owns an area around the airport rather
 * than the airport, is often staffed by someone covering several fields, and
 * is what vatsim-radar draws as its own entity. It gets its own tag, as does
 * anything else that is neither local nor en-route.
 */
const LOCAL_FACILITIES = new Set([2, 3, 4]); // DEL, GND, TWR

function isLocalPosition(facility: number, isAtis: boolean): boolean {
  return isAtis || LOCAL_FACILITIES.has(facility);
}

/** Which tag a position belongs to. */
function stationGroupKey(
  callsign: string,
  facility: number,
  isAtis: boolean,
): string {
  return isLocalPosition(facility, isAtis)
    ? stationAirport(callsign)
    : `pos:${callsign}`;
}

function groupStations(): Map<string, StationGroup> {
  const groups = new Map<string, StationGroup>();

  const add = (station: Controller, isAtis: boolean) => {
    const lat = parseFloat(station.latitude);
    const lon = parseFloat(station.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // An ATIS is identified by the array it arrived in: the feed's `facility`
    // for an ATIS connection is not reliably 7.
    const facility = isAtis ? 7 : station.facility;
    const id = stationGroupKey(station.callsign, facility, isAtis);
    // An approach whose airspace is drawn is labelled on that airspace's
    // boundary instead of at the airport it reports from.
    const anchor = traconLabelPoints.get(atcKey(station));
    const group = groups.get(id) ?? {
      code: stationAirport(station.callsign),
      lat: anchor?.[0] ?? lat,
      lon: anchor?.[1] ?? lon,
      local: isLocalPosition(facility, isAtis),
      stack: 0,
      stations: [],
    };
    group.stations.push({ station, key: atcKey(station), facility, isAtis });
    groups.set(id, group);
  };

  for (const controller of props.controllers) {
    if (ownsAirspace(controller)) continue;
    add(controller, false);
  }
  for (const station of props.atis) add(station, true);

  for (const group of groups.values()) {
    group.stations.sort(
      (a, b) => facilityRank(a.facility) - facilityRank(b.facility),
    );
  }

  stackCollidingTags(groups);

  return groups;
}

/**
 * Deal out tags that land on the same spot.
 *
 * An approach controller and the field's ATIS report all but identical
 * coordinates, so their tags were drawn centred on the same pixel and the
 * second one simply hid the first. Tags sharing a position are stacked
 * downwards instead, the airport keeping the anchor point.
 */
function stackCollidingTags(groups: Map<string, StationGroup>) {
  const clusters = new Map<string, StationGroup[]>();

  for (const group of groups.values()) {
    // Two decimal places is a bit over a kilometre — close enough that two
    // tags would overlap at any zoom where both are legible.
    const cluster = `${group.lat.toFixed(2)},${group.lon.toFixed(2)}`;
    const list = clusters.get(cluster) ?? [];
    list.push(group);
    clusters.set(cluster, list);
  }

  for (const list of clusters.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        Number(b.local) - Number(a.local) || a.code.localeCompare(b.code),
    );
    list.forEach((group, index) => (group.stack = index));
  }
}

function syncStations() {
  if (!atcLayer) return;
  /** Everyone online, tagged and airspace owners alike — `atcData` backs the
   *  details panel and `focus()`, so it must not outlive a session. */
  const online = new Set<string>();

  for (const controller of props.controllers) {
    online.add(atcKey(controller));
    atcData.set(atcKey(controller), controller);
  }
  for (const station of props.atis) {
    online.add(atcKey(station));
    atcData.set(atcKey(station), station);
  }

  const groups = groupStations();
  const ranged = new Set<string>();

  for (const [id, group] of groups) {
    const chips = group.stations.map((entry) => ({
      key: entry.key,
      // Sharing a tag earns the short label; alone, a position keeps its name.
      label:
        (group.stations.length > 1 || group.local
          ? facilityLetter(entry.facility)
          : "") || getFacilityName(entry.facility),
      facility: entry.facility,
    }));
    const selectedKey =
      chips.find((chip) => chip.key === props.selected)?.key ?? null;
    const signature =
      `${chips.map((c) => `${c.key}:${c.label}`).join(",")}` +
      `|${selectedKey ?? ""}|${group.stack}`;

    for (const entry of group.stations) {
      // Clearance, ground, tower and the ATIS work the field itself. A ring
      // around them describes how far they can *see*, which on an airport tag
      // is a 50nm circle saying nothing the tag has not already said — and
      // several of them overlapping at one airport say it several times over.
      if (isLocalPosition(entry.facility, entry.isAtis)) continue;
      // Nor does a position whose real airspace is drawn from SimAware: the
      // ring is a stand-in for geometry we do not have, and this one we do.
      if (traconCovered.has(entry.key)) continue;
      ranged.add(entry.key);
      syncRange(
        entry.key,
        parseFloat(entry.station.latitude),
        parseFloat(entry.station.longitude),
        entry.station.visual_range,
        facilityColor(entry.facility),
        props.selected === entry.key,
      );
    }

    let marker = atcMarkers.get(id);
    if (!marker) {
      marker = L.marker([group.lat, group.lon], {
        icon: tagIcon(group.code, chips, selectedKey, group.stack),
        riseOnHover: true,
      });
      marker.on("click", (event) => {
        // Resolved when the click happens, not when the tag was built: the
        // positions behind this tag change under it.
        const first = groupStations().get(id)?.stations[0]?.key ?? "";
        const key = clickedKey(event, first);
        if (key) emit("select", key);
      });
      atcMarkers.set(id, marker);
      iconSignatures.set(id, signature);
      atcLayer.addLayer(marker);
    } else {
      marker.setLatLng([group.lat, group.lon]);
      if (iconSignatures.get(id) !== signature) {
        marker.setIcon(tagIcon(group.code, chips, selectedKey, group.stack));
        iconSignatures.set(id, signature);
      }
    }
  }

  for (const [id, marker] of atcMarkers) {
    if (groups.has(id)) continue;
    atcLayer.removeLayer(marker);
    atcMarkers.delete(id);
    iconSignatures.delete(id);
  }
  for (const [key, circle] of rangeCircles) {
    if (ranged.has(key)) continue;
    rangeLayer?.removeLayer(circle);
    rangeCircles.delete(key);
  }
  for (const key of atcData.keys()) {
    if (online.has(key)) continue;
    atcData.delete(key);
    if (props.selected === key) emit("select", null);
  }
}

function syncRange(
  key: string,
  lat: number,
  lon: number,
  visualRange: number,
  color: string,
  selected: boolean,
) {
  if (!rangeLayer) return;

  const nm = Math.min(visualRange || 0, MAX_RANGE_NM);
  const existing = rangeCircles.get(key);

  if (nm <= 0) {
    if (existing) {
      rangeLayer.removeLayer(existing);
      rangeCircles.delete(key);
    }
    return;
  }

  const radius = nm * 1852;
  if (!existing) {
    const circle = L.circle([lat, lon], {
      radius,
      interactive: false,
      ...rangeStyle(color, selected),
    });
    rangeCircles.set(key, circle);
    rangeLayer.addLayer(circle);
    return;
  }

  existing.setLatLng([lat, lon]);
  if (existing.getRadius() !== radius) existing.setRadius(radius);
  existing.setStyle(rangeStyle(color, selected));
}

/* ------------------------------------------------------------------ *
 * Approach airspace (SimAware TRACONs)
 * ------------------------------------------------------------------ */

/**
 * Approach positions are drawn as the airspace they actually own.
 *
 * `visual_range` describes how far a controller can see, not what they
 * control, so the ring around an APP was always a stand-in. SimAware publishes
 * the real TRACON polygons (`public/tracon.geojson`, vendored — see
 * data/vatspy/README.md), keyed by the callsign prefixes that work them. Where
 * a position matches one, the polygon replaces its ring; where it does not —
 * plenty of fields have no TRACON drawn — the ring stays, which is better than
 * nothing at all.
 *
 * 1.6 MB is not loaded until an approach position is actually online.
 */
const TRACON_STYLE: L.PathOptions = {
  color: "#ff861d",
  weight: 1.5,
  opacity: 0.85,
  fillColor: "#ff861d",
  fillOpacity: 0.07,
};
const TRACON_SELECTED_STYLE: L.PathOptions = {
  ...TRACON_STYLE,
  weight: 2.5,
  fillOpacity: 0.16,
};

const FACILITY_APPROACH = 5;

/** Prefix (as SimAware spells it) to the polygons working under it. */
let tracons: Map<string, GeoJSON.Feature[]> | null = null;
let traconsRequest: Promise<void> | null = null;
/** Drawn airspace per controller key, and the keys it accounts for. */
const traconShapes = new Map<string, L.GeoJSON[]>();
const traconCovered = new Set<string>();
/** Where an approach tag goes once its airspace is known — see traconLabel. */
const traconLabelPoints = new Map<string, LatLon>();

/**
 * The point on a TRACON's outline to hang its label from: the northernmost
 * vertex.
 *
 * An approach controller reports the airport's coordinates, which is where the
 * tower already is, so an APP tag anchored there lands on top of the airport's
 * and says nothing about the airspace it belongs to. On the boundary it labels
 * the shape, and the two tags stop competing for the same pixel. North because
 * it has to be somewhere predictable, and the top of a shape is where a label
 * is looked for.
 */
function traconLabel(features: GeoJSON.Feature[]): LatLon | null {
  let best: LatLon | null = null;

  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    // A coordinate pair: [lon, lat].
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const [lon, lat] = node as [number, number];
      if (!best || lat > best[0]) best = [lat, lon];
      return;
    }
    for (const child of node) walk(child);
  };

  for (const feature of features) {
    walk((feature.geometry as { coordinates?: unknown })?.coordinates);
  }

  return best;
}

async function loadTracons(): Promise<void> {
  if (tracons) return;
  traconsRequest ??= fetch("/tracon.geojson")
    .then((response) => (response.ok ? response.json() : null))
    .then((data: GeoJSON.FeatureCollection | null) => {
      tracons = new Map();
      for (const feature of data?.features ?? []) {
        for (const prefix of (feature.properties?.prefix as string[]) ?? []) {
          const key = prefix.toUpperCase();
          const list = tracons.get(key) ?? [];
          list.push(feature);
          tracons.set(key, list);
        }
      }
    })
    .catch(() => {
      tracons = new Map();
    });
  await traconsRequest;
}

/**
 * The polygons an approach callsign works.
 *
 * `ZBAA_S_APP` is Beijing's south sector and `ZBAA_APP` the whole TRACON, so
 * the more specific spelling is tried first: everything but the trailing
 * position suffix, then just the airport.
 */
function traconsFor(callsign: string): GeoJSON.Feature[] {
  if (!tracons) return [];
  const parts = callsign.toUpperCase().split("_");
  const candidates = [parts.slice(0, -1).join("_"), parts[0]];

  for (const candidate of candidates) {
    // `candidate && tracons.get(candidate)` typed as `"" | Feature[]`, since a
    // one-part callsign makes the first candidate an empty string.
    if (!candidate) continue;
    const found = tracons.get(candidate);
    if (found?.length) return found;
  }
  return [];
}

async function syncTracons() {
  if (!boundariesLayer) return;

  const approaches = props.controllers.filter(
    (c) => c.facility === FACILITY_APPROACH,
  );
  if (approaches.length) await loadTracons();

  const drawn = new Set<string>();

  for (const controller of approaches) {
    const features = traconsFor(controller.callsign);
    if (!features.length) continue;

    const key = atcKey(controller);
    drawn.add(key);
    const selected = props.selected === key;

    const label = traconLabel(features);
    if (label) traconLabelPoints.set(key, label);

    const existing = traconShapes.get(key);
    if (existing) {
      for (const shape of existing)
        shape.setStyle(selected ? TRACON_SELECTED_STYLE : TRACON_STYLE);
      continue;
    }

    const shapes = features.map((feature) => {
      const shape = L.geoJSON(feature, {
        style: selected ? TRACON_SELECTED_STYLE : TRACON_STYLE,
      });
      shape.on("click", () => emit("select", key));
      boundariesLayer!.addLayer(shape);
      return shape;
    });
    traconShapes.set(key, shapes);
  }

  for (const [key, shapes] of traconShapes) {
    if (drawn.has(key)) continue;
    for (const shape of shapes) boundariesLayer.removeLayer(shape);
    traconShapes.delete(key);
    traconLabelPoints.delete(key);
  }

  // Rings and polygons are alternatives, so tell syncStations which positions
  // are already accounted for and let it drop their rings.
  traconCovered.clear();
  for (const key of drawn) traconCovered.add(key);
  syncStations();
}

/* ------------------------------------------------------------------ *
 * Boundaries — built once, restyled per poll
 * ------------------------------------------------------------------ */

const ACTIVE_STYLE: L.PathOptions = {
  color: "#10B981",
  weight: 2,
  opacity: 0.8,
  fillOpacity: 0.1,
  fillColor: "#10B981",
};
const INACTIVE_STYLE: L.PathOptions = {
  color: "#6B7280",
  weight: 1,
  opacity: 0.22,
  fillOpacity: 0,
};

/**
 * Unstaffed FIRs live in their own layer, off the map below this zoom.
 *
 * There are hundreds of them worldwide. Drawn at once they are a grey mesh
 * over every continent, and at the zoom where you are looking at the whole
 * network they carry no information — nobody is working any of them. Close in,
 * where a border tells you which airspace you are looking at, they come back.
 */
const QUIET_BOUNDARY_MIN_ZOOM = 5;

/**
 * Oceanic airspace is kept apart from the FIR it shares an id with.
 *
 * VATSpy ships Tokyo Control as two features under the one id `RJTG`: the
 * airspace over Japan, and a piece of the Pacific several times its size. Keyed
 * together, one `RJTG_CTR` lit both, and the map claimed a controller was
 * working half an ocean. They are keyed apart here and matched separately —
 * an oceanic sector lights only for a callsign that says it is oceanic.
 */
const OCEANIC_SUFFIX = "#oceanic";

function boundaryKey(id: string, oceanic: boolean): string {
  return oceanic ? `${id}${OCEANIC_SUFFIX}` : id;
}

function boundaryBaseId(key: string): string {
  return key.endsWith(OCEANIC_SUFFIX)
    ? key.slice(0, -OCEANIC_SUFFIX.length)
    : key;
}

function isOceanicKey(key: string): boolean {
  return key.endsWith(OCEANIC_SUFFIX);
}

/** `RJTG_O_CTR` and `RJTG_OCEANIC_CTR` work the ocean; `RJTG_CTR` does not. */
function worksOceanic(callsign: string): boolean {
  return callsign
    .toUpperCase()
    .split("_")
    .some((part) => part === "O" || part === "OCN" || part === "OCEANIC");
}

function buildBoundaries(data: GeoJSON.FeatureCollection) {
  if (!quietBoundariesLayer) return;

  for (const feature of data.features) {
    const boundaryId =
      feature.properties?.ID ||
      feature.properties?.id ||
      feature.properties?.name;
    if (!boundaryId) continue;

    knownBoundaryIds.add(String(boundaryId).toLowerCase());

    const key = boundaryKey(
      String(boundaryId),
      String(feature.properties?.oceanic) === "1",
    );
    const shape = L.geoJSON(feature, { style: INACTIVE_STYLE });
    const shapes = boundaryShapes.get(key) ?? [];
    shapes.push(shape);
    boundaryShapes.set(key, shapes);
    quietBoundariesLayer.addLayer(shape);
  }
}

function applyBoundaryFilter() {
  if (!map || !quietBoundariesLayer) return;
  const show = map.getZoom() >= QUIET_BOUNDARY_MIN_ZOOM;
  if (show && !map.hasLayer(quietBoundariesLayer))
    map.addLayer(quietBoundariesLayer);
  else if (!show && map.hasLayer(quietBoundariesLayer))
    map.removeLayer(quietBoundariesLayer);
}

/**
 * Callsigns beside the aircraft, from this zoom up.
 *
 * The label is built into every aircraft icon and hidden by CSS, so turning
 * them on is one class on the map container rather than a tooltip rebuilt on
 * several hundred markers. Below this zoom they would overlap into noise.
 */
const AIRCRAFT_LABEL_MIN_ZOOM = 7;

/**
 * Waypoint names along the selected route, on the same principle.
 *
 * Two thresholds, because the two kinds of fix sit at different densities. An
 * en-route fix is tens of miles from its neighbours and readable early; a SID
 * lays six of them across one terminal area, and naming those before the map
 * has spread them out writes the procedure over itself.
 */
const FIX_LABEL_MIN_ZOOM = 6;
const TERMINAL_LABEL_MIN_ZOOM = 9;

/**
 * Airway and procedure names come in earlier than the fixes they string
 * together: there are far fewer of them, and at the zoom where a whole route
 * fits on screen `W47` is the part worth reading.
 */
const VIA_LABEL_MIN_ZOOM = 5;

function applyLabelFilter() {
  if (!map) return;

  const zoom = map.getZoom();
  const container = map.getContainer();

  container.classList.toggle(
    "show-aircraft-labels",
    zoom >= AIRCRAFT_LABEL_MIN_ZOOM,
  );
  container.classList.toggle("show-fix-labels", zoom >= FIX_LABEL_MIN_ZOOM);
  container.classList.toggle(
    "show-terminal-labels",
    zoom >= TERMINAL_LABEL_MIN_ZOOM,
  );
  container.classList.toggle("show-via-labels", zoom >= VIA_LABEL_MIN_ZOOM);
}

function syncBoundaries() {
  if (!boundaryShapes.size) return;

  const nextActive = new Set<string>();
  const nextControllers = new Map<string, Controller[]>();

  for (const controller of props.controllers) {
    if (!ownsAirspace(controller)) continue;
    const oceanic = worksOceanic(controller.callsign);

    for (const boundaryId of boundaryShapes.keys()) {
      // The ocean is a separate job from the FIR that shares its id.
      if (isOceanicKey(boundaryId) !== oceanic) continue;
      if (
        !matchControllerToBoundary(
          controller.callsign,
          boundaryBaseId(boundaryId),
        )
      )
        continue;
      nextActive.add(boundaryId);
      const list = nextControllers.get(boundaryId) ?? [];
      list.push(controller);
      nextControllers.set(boundaryId, list);
    }
  }

  boundaryControllers = nextControllers;

  for (const [boundaryId, shapes] of boundaryShapes) {
    const isActive = nextActive.has(boundaryId);
    const wasActive = activeBoundaries.has(boundaryId);
    // The click handler resolves the owning controller when it fires, so an
    // area whose staffing merely changed needs no work at all.
    if (isActive === wasActive) continue;

    for (const shape of shapes) {
      shape.setStyle(isActive ? ACTIVE_STYLE : INACTIVE_STYLE);
      // A staffed sector is always drawn; an unstaffed one is subject to the
      // zoom filter, so the two live in different layers.
      (isActive ? quietBoundariesLayer : boundariesLayer)?.removeLayer(shape);
      (isActive ? boundariesLayer : quietBoundariesLayer)?.addLayer(shape);
      shape.off("click");
      if (isActive) {
        // Selecting the sector selects whoever is working it, so the details
        // panel shows a CTR position the same way it shows a tower.
        shape.on("click", () => {
          const owner = boundaryControllers.get(boundaryId)?.[0];
          if (owner) emit("select", atcKey(owner));
        });
      }
    }
  }

  activeBoundaries = nextActive;
  syncSectorTags();
}

/**
 * A tag on each staffed sector, so an en-route position is labelled the same
 * way an airport is rather than being a nameless green polygon. It sits at the
 * centre of the first piece of the boundary the controller owns.
 */
function syncSectorTags() {
  if (!atcLayer) return;
  const drawn = new Set<string>();

  for (const [boundaryId, controllers] of boundaryControllers) {
    const shape = boundaryShapes.get(boundaryId)?.[0];
    if (!shape) continue;

    let centre: L.LatLng;
    try {
      centre = shape.getBounds().getCenter();
    } catch {
      continue;
    }

    for (const controller of controllers) {
      const key = atcKey(controller);
      // A position covering several boundaries is tagged on the first one.
      if (drawn.has(key)) continue;
      drawn.add(key);

      const chips = [
        {
          key,
          label: `${controller.callsign} ${controller.frequency}`,
          facility: controller.facility,
        },
      ];
      const selectedKey = props.selected === key ? key : null;
      const signature = `${chips[0].label}|${selectedKey ?? ""}|${centre.lat},${centre.lng}`;

      let marker = sectorMarkers.get(key);
      if (!marker) {
        marker = L.marker(centre, { icon: tagIcon("", chips, selectedKey) });
        marker.on("click", () => emit("select", key));
        sectorMarkers.set(key, marker);
        iconSignatures.set(`sector:${key}`, signature);
        atcLayer.addLayer(marker);
      } else if (iconSignatures.get(`sector:${key}`) !== signature) {
        marker.setLatLng(centre);
        marker.setIcon(tagIcon("", chips, selectedKey));
        iconSignatures.set(`sector:${key}`, signature);
      }
    }
  }

  for (const [key, marker] of sectorMarkers) {
    if (drawn.has(key)) continue;
    atcLayer.removeLayer(marker);
    sectorMarkers.delete(key);
    iconSignatures.delete(`sector:${key}`);
  }
}

/* ------------------------------------------------------------------ *
 * Selection + trail
 * ------------------------------------------------------------------ */

/**
 * The flown track, coloured by altitude.
 *
 * Drawn as one solid polyline per run of points in the same altitude band —
 * the same grouping vatsim-radar does server-side before it hands the track to
 * the map — so a climb, a cruise and a descent are three visibly different
 * stretches of the same line rather than one uniform thread. The bands and the
 * ramp are the ones the aircraft icons already use, so a segment's colour
 * matches what the aircraft looked like when it flew that piece.
 *
 * The line is also broken wherever two consecutive points are further apart
 * than an aircraft could have flown between samples. Recording pauses, a
 * reconnect, or a simulator reporting 0/0 before it has a position all put a
 * pair of points on the track that were never joined by a flight; drawing
 * through them lays a line across half the world.
 */
const MAX_TRACK_SEGMENT_NM = 250;

function drawTrail() {
  if (!trailLayer) return;
  trailLayer.clearLayers();

  const points = trackKey === props.selected ? track : null;
  if (!points || points.length < 2) return;

  let runStart = 0;
  let runColor = altitudeColor(points[0][2], props.theme);

  const flush = (end: number) => {
    if (end - runStart < 1) return;
    L.polyline(
      points
        .slice(runStart, end + 1)
        .map(([lat, lon]) => [lat, lon] as [number, number]),
      { color: runColor, weight: 2, opacity: 0.9, interactive: false },
    ).addTo(trailLayer!);
  };

  for (let i = 1; i < points.length; i++) {
    const jumped =
      distanceNm(
        [points[i - 1][0], points[i - 1][1]],
        [points[i][0], points[i][1]],
      ) > MAX_TRACK_SEGMENT_NM;

    if (jumped) {
      // End the line *before* the jump and restart after it, leaving a gap
      // where we genuinely do not know what the aircraft did.
      flush(i - 1);
      runStart = i;
      runColor = altitudeColor(points[i][2], props.theme);
      continue;
    }

    const color = altitudeColor(points[i][2], props.theme);
    if (color === runColor) continue;
    // The segment that changes band belongs to both runs, so the line has no
    // gap where the colour turns over.
    flush(i);
    runStart = i;
    runColor = color;
  }
  flush(points.length - 1);
}

/**
 * Fetch the selected flight's track from `/api/v1/track`.
 *
 * `flightPosition` is the only source: nothing is accumulated in the browser
 * and nothing is persisted there. The track a viewer sees is therefore the
 * same one every viewer sees — it starts where the pilot connected rather than
 * where this tab happened to open, and it survives a reload, a different
 * browser and a different machine, none of which a local trail could do.
 *
 * The cost of that is a dependency: with track recording off in can-fsd, or
 * the table missing, there is simply no line. That is the honest picture.
 *
 * Re-fetched on every poll while a flight stays selected, so the line grows
 * with the aircraft. The current live position is appended to whatever came
 * back, because the FSD samples and its newest row is usually a few seconds
 * behind the datafeed.
 */
async function loadTrack(key: string) {
  const pilot = pilotData.get(key);
  const cid = pilot?.cid;

  if (!pilot || !cid) {
    track = [];
    trackKey = null;
    drawTrail();
    return;
  }

  let recorded: TrailPoint[] = [];

  try {
    const response = await fetch(
      `/api/v1/track?cid=${encodeURIComponent(cid)}&limit=${TRACK_POINTS}`,
    );
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const points = payload?.data?.points as
        | [number, number, number, number][]
        | undefined;
      recorded = (points ?? []).map(
        ([lat, lon, altitude]) => [lat, lon, altitude] as TrailPoint,
      );
    }
  } catch {
    /* offline or blocked — fall through with whatever we have */
  }

  // The selection may have moved on while the request was in flight.
  if (props.selected !== key) return;

  const last = recorded[recorded.length - 1];
  const live: TrailPoint = [
    pilot.latitude,
    pilot.longitude,
    Math.round(pilot.altitude),
  ];
  if (!last || last[0] !== live[0] || last[1] !== live[1]) recorded.push(live);

  track = recorded;
  trackKey = key;
  drawTrail();
}

/* ------------------------------------------------------------------ *
 * The filed route
 * ------------------------------------------------------------------ */

interface RoutePoint {
  ident: string;
  lat: number;
  lon: number;
  kind: "airport" | "fix" | "airway" | "sid" | "star";
  /** The airway or procedure this point was reached along, if any. */
  via?: string;
}

/** The selected flight's filed route, as `/api/v1/route` resolved it. */
let routePoints: RoutePoint[] = [];
/** The plan those points belong to, so a poll does not re-resolve them. */
let routeKey: string | null = null;
let routePending: string | null = null;

function planKey(plan: {
  departure?: string;
  arrival?: string;
  route?: string;
}): string {
  return `${plan.departure ?? ""}|${plan.arrival ?? ""}|${plan.route ?? ""}`;
}

/**
 * Resolve a filed route into coordinates.
 *
 * The navigation database stays on the server — a browser asks about one
 * flight and gets that flight's fixes back, not a copy of the database. The
 * answer only changes when the *plan* changes, so it is keyed by the plan and
 * survives every position poll in between.
 */
async function loadRoute(
  key: string,
  plan: { departure?: string; arrival?: string; route?: string },
) {
  if (routeKey === key || routePending === key) return;
  routePending = key;

  const params = new URLSearchParams({
    departure: plan.departure ?? "",
    arrival: plan.arrival ?? "",
    route: plan.route ?? "",
  });

  try {
    const response = await fetch(`/api/v1/route?${params}`);
    const payload = response.ok
      ? await response.json().catch(() => null)
      : null;
    // A newer selection started resolving while this was in flight.
    if (routePending !== key) return;

    routePoints = (payload?.data?.points as RoutePoint[]) ?? [];
    routeKey = key;
    routePending = null;
    drawRoute();
  } catch {
    if (routePending === key) routePending = null;
  }
}

/**
 * The part of the route still ahead of the aircraft.
 *
 * The nearest point wins, and is then dropped if the aircraft is already
 * closer to the one after it than that leg is long — which is what "abeam the
 * fix" looks like in coordinates. Nothing here reads the track: a flight that
 * joined its route late, or was vectored off it, still gets the fixes ahead of
 * where it actually is rather than the ones the plan says it should have hit.
 */
function remainingRoute(points: RoutePoint[], position: LatLon): RoutePoint[] {
  if (points.length < 2) return points;

  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const distance = distanceNm(position, [points[i].lat, points[i].lon]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }

  const next = points[best + 1];
  if (next) {
    const toNext = distanceNm(position, [next.lat, next.lon]);
    const leg = distanceNm(
      [points[best].lat, points[best].lon],
      [next.lat, next.lon],
    );
    if (toNext < leg) best++;
  }

  return points.slice(best);
}

/** Enough interpolation to bend a long leg, none wasted on a short one. */
function arc(from: LatLon, to: LatLon): LatLon[] {
  const distance = distanceNm(from, to);
  if (distance < 60) return [from, to];
  return greatCircle(from, to, Math.min(64, Math.ceil(distance / 60)));
}

/**
 * The route the selected flight has left to fly.
 *
 * Where the navigation database resolves the filed route, that is what gets
 * drawn — fix to fix, with the SID and STAR expanded into their published
 * legs. The line starts at the aircraft, not at the departure field: where it
 * came from is already on the map, drawn by the recorded track as actually
 * flown rather than as the route it was cleared for.
 *
 * When the route resolves to nothing — an empty plan, an unparseable route, or
 * no navigation data deployed — it falls back to a great circle straight to
 * the destination, which is what this drew before and what vatsim-radar draws
 * when Navigraph is unavailable to it.
 *
 * The 468 KB airport table is fetched the first time a flight is selected
 * rather than on load, so a visitor who never clicks an aircraft never pays
 * for it.
 */
async function drawRoute() {
  if (!routeLayer) return;

  const key = props.selected;
  const pilot = key ? pilotData.get(key) : null;
  const plan = pilot?.flight_plan;

  if (!pilot || !plan?.arrival) {
    routeLayer.clearLayers();
    return;
  }

  await loadAirports();
  // Selection moved on while the table was loading.
  if (props.selected !== key) return;

  routeLayer.clearLayers();

  const wanted = planKey(plan);
  if (routeKey !== wanted) loadRoute(wanted, plan);

  const position: LatLon = [pilot.latitude, pilot.longitude];
  const color = props.theme === "dark" ? "#94a3b8" : "#475569";
  const arrival = airportAt(plan.arrival);

  const ahead =
    routeKey === wanted ? remainingRoute(routePoints, position) : [];

  if (ahead.length) {
    drawRouteLine(ahead, position, color);
  } else if (arrival) {
    L.polyline(greatCircle(position, arrival), {
      color,
      weight: 1.5,
      opacity: 0.75,
      interactive: false,
    }).addTo(routeLayer);
  }

  if (arrival) airportDot(arrival, plan.arrival, color).addTo(routeLayer);
}

/**
 * Draw the route as one polyline per run of like legs, so a procedure can be
 * dashed without cutting the en-route portion into a marker per fix.
 *
 * A leg takes the style of the point it arrives at: the first leg of a STAR is
 * part of the STAR.
 */
function drawRouteLine(ahead: RoutePoint[], position: LatLon, color: string) {
  if (!routeLayer) return;

  const isProcedure = (point: RoutePoint) =>
    point.kind === "sid" || point.kind === "star";

  let from: LatLon = position;
  let run: LatLon[] = [position];
  let runProcedure = isProcedure(ahead[0]);

  const flush = () => {
    if (run.length < 2) return;
    L.polyline(run, {
      color,
      weight: 1.5,
      opacity: runProcedure ? 0.9 : 0.75,
      dashArray: runProcedure ? "4 4" : undefined,
      interactive: false,
    }).addTo(routeLayer!);
  };

  for (const point of ahead) {
    const to: LatLon = [point.lat, point.lon];
    const procedure = isProcedure(point);

    if (procedure !== runProcedure) {
      flush();
      // The turning leg belongs to both runs, so the line has no gap where the
      // style changes.
      run = [from];
      runProcedure = procedure;
    }

    run.push(...arc(from, to).slice(1));
    from = to;
  }
  flush();

  // A dot on every waypoint, named from the zoom where the names fit. The
  // airports are skipped: they already carry a tag of their own.
  for (const point of ahead) {
    if (point.kind === "airport") continue;
    fixDot(point, color).addTo(routeLayer);
  }

  drawViaLabels(ahead, position, color);
}

/** How many waypoints one airway label is expected to cover. */
const VIA_LABEL_SPACING = 12;

/**
 * Name each stretch of line that was flown along something — `W47`, `BOTP2G`.
 *
 * A run of points sharing a `via` is one airway or one procedure, and the
 * label goes on the line between two of them rather than on a fix, because
 * the name belongs to the leg, not to the waypoint. A long airway gets the
 * name repeated: one label in the middle of a 600-mile stretch is a label
 * nobody sees at the zoom where they are reading fix names.
 */
function drawViaLabels(ahead: RoutePoint[], position: LatLon, color: string) {
  if (!routeLayer) return;

  for (let start = 0; start < ahead.length; ) {
    const via = ahead[start].via;
    let end = start;
    while (end + 1 < ahead.length && ahead[end + 1].via === via) end++;

    if (!via) {
      start = end + 1;
      continue;
    }

    // The run's line starts at whatever it was joined from — the fix before
    // it, or the aircraft when the route is already inside the airway.
    const from: LatLon =
      start === 0 ? position : [ahead[start - 1].lat, ahead[start - 1].lon];
    const legs: LatLon[] = [
      from,
      ...ahead.slice(start, end + 1).map((p) => [p.lat, p.lon] as LatLon),
    ];

    const labels = Math.max(
      1,
      Math.round((legs.length - 1) / VIA_LABEL_SPACING),
    );
    for (let i = 0; i < labels; i++) {
      const leg = Math.floor(((i + 0.5) * (legs.length - 1)) / labels);
      const a = legs[leg];
      const b = legs[leg + 1] ?? legs[leg];
      viaLabel([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], via, color).addTo(
        routeLayer,
      );
    }

    start = end + 1;
  }
}

function viaLabel(at: LatLon, name: string, color: string): L.Marker {
  return L.marker(at, {
    interactive: false,
    icon: L.divIcon({
      className: "radar-tag-icon",
      html: `<div class="radar-via" style="--radar-via-color:${color}">${escapeHtml(name)}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

/**
 * A waypoint on the route: a dot always, its ident once there is room for it.
 *
 * The name is built into the marker and revealed by a class on the map
 * container, the same way aircraft callsigns work — a zoom change is one class
 * toggle rather than forty markers rebuilt.
 */
function fixDot(point: RoutePoint, color: string): L.Marker {
  const terminal = point.kind === "sid" || point.kind === "star";

  return L.marker([point.lat, point.lon], {
    interactive: false,
    icon: L.divIcon({
      className: "radar-tag-icon",
      html: `<div class="radar-fix${terminal ? " radar-fix--terminal" : ""}" style="--radar-fix-color:${color}">
          <span class="radar-fix__dot"></span
          ><span class="radar-fix__name">${escapeHtml(point.ident)}</span>
        </div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

function airportDot(at: LatLon, icao: string, color: string): L.Marker {
  return L.marker(at, {
    interactive: false,
    icon: L.divIcon({
      className: "radar-tag-icon",
      html: `<div class="radar-airport" style="--radar-airport-color:${color}">
          <span class="radar-airport__dot"></span>${escapeHtml(icao.toUpperCase())}
        </div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

/** Re-draw whatever gained or lost the selection highlight. */
function refreshSelection(previous?: string | null) {
  let touchedStation = false;

  for (const key of [previous, props.selected]) {
    if (!key) continue;

    const pilot = pilotData.get(key);
    const pilotMarker = pilotMarkers.get(key);
    if (pilot && pilotMarker) {
      const selected = props.selected === key;
      pilotMarker.setIcon(aircraftIcon(pilot, selected));
      iconSignatures.set(key, pilotSignature(pilot, selected));
      continue;
    }

    if (atcData.has(key)) touchedStation = true;
  }

  // A station's highlight lives inside a shared tag, so let the sync rebuild
  // whichever tag actually changed — its signature covers the selection.
  if (touchedStation) {
    syncStations();
    syncSectorTags();
    for (const [key, shapes] of traconShapes) {
      const style =
        props.selected === key ? TRACON_SELECTED_STYLE : TRACON_STYLE;
      for (const shape of shapes) shape.setStyle(style);
    }
  }

  drawTrail();
  drawRoute();
}

/** Centre the map on an entity. The traffic list and the details panel call
 *  this; the details themselves are rendered beside the map, not on it. */
function focus(key: string) {
  if (!map) return;

  const pilotMarker = pilotMarkers.get(key);
  if (pilotMarker) {
    map.setView(pilotMarker.getLatLng(), Math.max(map.getZoom(), 7), {
      animate: true,
    });
    return;
  }

  const controller = atcData.get(key);
  if (!controller) return;

  // A local position shares its airport's tag; approach has one of its own.
  const isAtis = props.atis.some((a) => a.callsign === controller.callsign);
  const tag = atcMarkers.get(
    stationGroupKey(
      controller.callsign,
      isAtis ? 7 : controller.facility,
      isAtis,
    ),
  );
  if (tag) {
    map.setView(tag.getLatLng(), Math.max(map.getZoom(), 7), { animate: true });
    return;
  }

  // A CTR/FSS position is its airspace — frame the whole thing.
  const oceanic = worksOceanic(controller.callsign);
  for (const [boundaryId, shapes] of boundaryShapes) {
    if (isOceanicKey(boundaryId) !== oceanic) continue;
    if (
      !matchControllerToBoundary(
        controller.callsign,
        boundaryBaseId(boundaryId),
      )
    )
      continue;
    map.fitBounds(shapes[0].getBounds(), { padding: [40, 40], maxZoom: 7 });
    return;
  }
}

/**
 * 图层开关。
 *
 * 加进地图和从地图移除，而不是把图层里的内容清空 —— 移除保留了图层里所有已经建
 * 好的标记和多边形，再打开时是瞬间的；清空则要把边界的几兆 GeoJSON 重新解析一
 * 遍，那正是这个文件开头说的「永远不重建地图」要避免的事。
 */
function applyLayerVisibility() {
  if (!map) return;
  const toggles: [L.LayerGroup | null, boolean][] = [
    [boundariesLayer, props.settings.boundaries],
    [quietBoundariesLayer, props.settings.boundaries],
    [rangeLayer, props.settings.rangeRings],
    [atcLayer, props.settings.airportTags],
  ];
  for (const [layer, visible] of toggles) {
    if (!layer) continue;
    if (visible && !map.hasLayer(layer)) map.addLayer(layer);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

watch(
  () => [
    props.settings.basemap,
    props.settings.boundaries,
    props.settings.airportTags,
    props.settings.rangeRings,
  ],
  () => {
    if (tileLayer) {
      tileLayer.setUrl(tileUrl());
      // 卫星图没有子域，换过去之后再换回来必须把它加回来，否则 {s} 展不开。
      tileLayer.options.subdomains = tileOptions().subdomains;
    }
    applyLayerVisibility();
  },
);

defineExpose({ focus });

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * The smallest zoom at which the world still covers the container.
 *
 * Web Mercator draws the whole world as a square of 256 × 2^zoom pixels, so
 * below log2(height / 256) the map is shorter than its frame and the page
 * shows through above and below it. Clamping the minimum to that makes the
 * map fill its container at every zoom it will let you reach — which is why
 * this is recomputed on resize rather than hard-coded: the right floor for a
 * phone is not the right floor for a 4K window.
 */
function applyMinZoom() {
  if (!map) return;

  const height = map.getSize().y;
  if (height <= 0) return;

  const minZoom = Math.ceil(Math.log2(height / 256));
  if (map.getMinZoom() === minZoom) return;

  map.setMinZoom(minZoom);
  // setMinZoom does not move a view that is already below the new floor.
  if (map.getZoom() < minZoom) map.setZoom(minZoom);
}

function applyGroundFilter() {
  if (!map || !groundLayer) return;
  const show = map.getZoom() >= GROUND_TRAFFIC_MIN_ZOOM;
  if (show && !map.hasLayer(groundLayer)) map.addLayer(groundLayer);
  else if (!show && map.hasLayer(groundLayer)) map.removeLayer(groundLayer);
}

/** Rescale every aircraft icon after a zoom (or a theme flip), in one pass. */
function rescaleIcons() {
  for (const [key, marker] of pilotMarkers) {
    const pilot = pilotData.get(key);
    if (!pilot) continue;
    const selected = props.selected === key;
    const signature = pilotSignature(pilot, selected);
    if (iconSignatures.get(key) === signature) continue;
    marker.setIcon(aircraftIcon(pilot, selected));
    iconSignatures.set(key, signature);
  }
}

function fitToTraffic() {
  if (!map || didInitialFit) return;
  const points: L.LatLngExpression[] = [];
  for (const pilot of props.pilots) {
    if (Number.isFinite(pilot.latitude) && Number.isFinite(pilot.longitude)) {
      points.push([pilot.latitude, pilot.longitude]);
    }
  }
  for (const marker of atcMarkers.values()) points.push(marker.getLatLng());
  if (!points.length) return;

  try {
    map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 8 });
  } catch {
    /* degenerate bounds — keep the default view */
  }
  didInitialFit = true;
}

onMounted(async () => {
  if (!mapContainer.value) return;

  // 分享链接带来的中心和缩放优先于默认视角。三项必须**一起**齐备才用：只有中心
  // 没有缩放的话，会得到一个位置对但比例尺莫名其妙的画面。
  const shared = props.initialView;
  const hasShared =
    shared?.lat != null && shared?.lon != null && shared?.zoom != null;

  map = L.map(mapContainer.value, {
    center: hasShared ? [shared!.lat!, shared!.lon!] : [35.0, 105.0],
    zoom: hasShared ? shared!.zoom! : 4,
    zoomControl: true,
    preferCanvas: true,
    // Keep the world inside the frame vertically: no dragging the map off the
    // top or bottom to leave a band of page showing.
    maxBounds: L.latLngBounds(
      L.latLng(-85.05, -Infinity),
      L.latLng(85.05, Infinity),
    ),
    maxBoundsViscosity: 1,
  });

  applyMinZoom();
  // The container is a flex child of the page, so it resizes with the window
  // and with the two side panels opening and closing.
  resizeObserver = new ResizeObserver(() => {
    applyMinZoom();
    map?.invalidateSize();
  });
  resizeObserver.observe(mapContainer.value);

  tileLayer = L.tileLayer(tileUrl(), {
    // The airspace credits are not decoration: VATSpy's data is CC BY-SA 4.0,
    // which requires attribution wherever it is shown.
    attribution:
      "© OpenStreetMap contributors © CARTO · Airspace " +
      '<a href="https://github.com/vatsimnetwork/vatspy-data-project" target="_blank" rel="noreferrer">VATSpy</a>' +
      " (CC BY-SA 4.0) · " +
      '<a href="https://github.com/vatsimnetwork/simaware-tracon-project" target="_blank" rel="noreferrer">SimAware</a>',
    ...tileOptions(),
  }).addTo(map);

  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  // 视口回报给上层写进 URL。moveend 而不是 move：拖动过程中每帧都写一次地址栏，
  // 既没意义又会让浏览器忙着做无用功。
  map.on("moveend zoomend", () => {
    if (!map) return;
    const centre = map.getCenter();
    emit("move", { lat: centre.lat, lon: centre.lng, zoom: map.getZoom() });
  });

  // The vendored datasets have to be credited where they are shown: VATSpy is
  // CC BY-SA 4.0, which requires it, and SimAware is community work that
  // deserves it. See data/vatspy/README.md.
  map.attributionControl.addAttribution(
    'Airports & FIRs <a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
      'target="_blank" rel="noopener">VATSpy</a> ' +
      '(<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" ' +
      'rel="noopener">CC BY-SA 4.0</a>) · TRACONs ' +
      '<a href="https://github.com/vatsimnetwork/simaware-tracon-project" ' +
      'target="_blank" rel="noopener">SimAware</a>',
  );

  quietBoundariesLayer = L.layerGroup().addTo(map);
  boundariesLayer = L.layerGroup().addTo(map);
  rangeLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  trailLayer = L.layerGroup().addTo(map);
  atcLayer = L.layerGroup().addTo(map);
  applyLayerVisibility();
  groundLayer = L.layerGroup();
  airborneLayer = L.layerGroup().addTo(map);

  map.on("zoomend", () => {
    applyGroundFilter();
    applyBoundaryFilter();
    applyLabelFilter();
    rescaleIcons();
  });
  // Clicking empty map clears the selection, the way the list expects.
  map.on("click", () => emit("select", null));

  syncStations();
  syncTracons();
  syncPilots();
  applyGroundFilter();
  applyLabelFilter();
  fitToTraffic();

  try {
    const response = await fetch("/boundaries.geojson");
    buildBoundaries(await response.json());
    applyBoundaryFilter();
    syncBoundaries();
  } catch (error) {
    console.error("Failed to load boundaries data:", error);
  }
});

watch(
  () => props.pilots,
  () => {
    syncPilots();
    if (props.selected) loadTrack(props.selected);
    drawRoute();
    fitToTraffic();
  },
);

watch(
  () => [props.controllers, props.atis],
  () => {
    syncStations();
    syncTracons();
    syncBoundaries();
    fitToTraffic();
  },
);

watch(
  () => props.theme,
  (theme) => {
    if (tileLayer) tileLayer.setUrl(tileUrl());
    rescaleIcons();
    drawTrail();
    drawRoute();
  },
);

watch(
  () => props.selected,
  (next, previous) => {
    refreshSelection(previous);
    if (next && pilotData.has(next)) loadTrack(next);
    else {
      track = [];
      trackKey = null;
      drawTrail();
    }
  },
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  map?.remove();
  map = null;
});
</script>

<template>
  <div class="h-full w-full relative">
    <div
      ref="mapContainer"
      class="h-full w-full relative z-0"
      style="min-height: 300px"
    ></div>
  </div>
</template>

<style>
/* Hover labels. The Leaflet block in globals.css is intentionally frozen, so
   the tooltip skin lives with the component that introduces it. */
.leaflet-tooltip {
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.95);
  color: #0f172a;
  font-size: 11px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

.leaflet-tooltip-top::before {
  border-top-color: rgba(255, 255, 255, 0.95);
}

.dark .leaflet-tooltip {
  background: rgba(30, 41, 59, 0.96);
  color: #f1f5f9;
}

.dark .leaflet-tooltip-top::before {
  border-top-color: rgba(30, 41, 59, 0.96);
}

/* Callsigns beside the aircraft, revealed by the zoom filter rather than
   rebuilt per marker. */
.aircraft-label {
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  display: none;
  padding: 0 3px;
  border-radius: 3px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.82);
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  pointer-events: none;
}

.dark .aircraft-label {
  background: rgba(15, 23, 42, 0.82);
  color: #e2e8f0;
}

.show-aircraft-labels .aircraft-label {
  display: block;
}

/* Position tags. The icon element itself is zero-sized and anchored on the
   coordinate: the pin marks the field, and the label floats above it rather
   than sitting on top of the thing it names. */
.radar-tag-icon {
  width: 0 !important;
  height: 0 !important;
  overflow: visible;
}

.radar-tag__pin {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fff;
  border: 1.5px solid rgba(15, 23, 42, 0.75);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.dark .radar-tag__pin {
  background: #0f172a;
  border-color: rgba(226, 232, 240, 0.85);
}

.radar-tag {
  position: absolute;
  /* Sits above the pin. Row 0 is nearest it; tags sharing a position stack up
     from there, so none of them covers the field. */
  transform: translate(
    -50%,
    calc(-100% - 9px - var(--radar-tag-row, 0) * 23px)
  );
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 5px;
  border-radius: 6px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(15, 23, 42, 0.14);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
  font-size: 11px;
  line-height: 1.45;
}

.dark .radar-tag {
  background: rgba(15, 23, 42, 0.94);
  border-color: rgba(148, 163, 184, 0.28);
}

.radar-tag.is-selected {
  border-color: rgba(148, 163, 184, 0.95);
  box-shadow:
    0 0 0 2px rgba(148, 163, 184, 0.55),
    0 2px 6px rgba(0, 0, 0, 0.28);
}

.radar-tag__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #0f172a;
}

.dark .radar-tag__code {
  color: #f1f5f9;
}

.radar-tag__chips {
  display: flex;
  gap: 3px;
}

.radar-tag__chip {
  padding: 0 5px;
  border-radius: 4px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  /* The chips are the click targets; the label around them is not. */
  cursor: pointer;
}

.radar-tag__chip.is-selected {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.95);
}

/* Route endpoints: a dot on the field with its ICAO beside it. */
.radar-airport {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 2px;
  border-radius: 4px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.85);
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}

.dark .radar-airport {
  background: rgba(15, 23, 42, 0.8);
  color: #f1f5f9;
}

.radar-airport__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--radar-airport-color, #475569);
}

/* Waypoints along the route. The dot is the marker; the name is revealed by
   the zoom filter, and never on a marker small enough to be the dot itself. */
.radar-fix {
  position: absolute;
  /* Half the dot, so the dot itself lands on the fix and the name hangs off
     it. Centring the whole box would walk the dot off the waypoint the moment
     the name appeared. */
  transform: translate(-2.5px, -2.5px);
  display: flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}

.radar-fix__dot {
  width: 5px;
  height: 5px;
  flex: none;
  border: 1px solid var(--radar-fix-color, #475569);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
}

.dark .radar-fix__dot {
  background: rgba(15, 23, 42, 0.9);
}

.radar-fix__name {
  display: none;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.8);
  color: #0f172a;
}

.dark .radar-fix__name {
  background: rgba(15, 23, 42, 0.78);
  color: #e2e8f0;
}

.show-fix-labels .radar-fix:not(.radar-fix--terminal) .radar-fix__name,
.show-terminal-labels .radar-fix--terminal .radar-fix__name {
  display: block;
}

/* The airway or procedure a stretch of the route is flown along, sitting on
   the line itself. Hidden until the zoom filter says there is room. */
.radar-via {
  position: absolute;
  transform: translate(-50%, -50%);
  display: none;
  padding: 0 3px;
  border-radius: 3px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.82);
  color: var(--radar-via-color, #475569);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.dark .radar-via {
  background: rgba(15, 23, 42, 0.78);
}

.show-via-labels .radar-via {
  display: block;
}
</style>
