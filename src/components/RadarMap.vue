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
/* leaflet.css **不在这里引**，在 BaseLayout.astro 里，排在 vr-theme.css 前面。
 *
 * 从这里引的话，它是这个岛屿的一个动态样式表，浏览器会在组件加载时把它插到
 * <head> 的最后 —— 也就是排在整站样式的**后面**。于是 Leaflet 自己那份
 * `.leaflet-control-attribution a { color: #0078A8 }` 会赢过外观层同权重的那条，
 * 版权条上留着一串默认的亮蓝色链接和一块白底比例尺。改成在布局里引，顺序就由
 * 我们说了算。 */
import { airportAt, loadAirports } from "@/lib/airports";
import { loadAirportCodes, stationField } from "@/lib/airportCodes";
import { getFacilityName, ownsAirspace } from "@/lib/facilities";
import { firMatch, loadFirs, prefersOceanic } from "@/lib/firs";
import {
  AREA_COLORS,
  ROUTE_COLORS,
  altitudeColor,
  distanceNm,
  escapeHtml,
  facilityColor,
  facilityLetter,
  facilityRank,
  flightLevel,
  greatCircle,
  isOnGround,
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
  /**
   * 看这张图的人自己那架飞机的键，没登录或者没连线时是 null。
   *
   * 和 `selected` 是两件事：选中的那架随时会换，这一架在整个航段里都是同一架，
   * 所以它在图上一直戴着自己的记号 —— 一屏两百架飞机时，「哪个是我」不该靠找。
   */
  mine?: string | null;
  /** 跟随自己那架：每次刷新把地图挪过去。缩放不动，那是人自己调的。 */
  follow?: boolean;
  /** The viewer's own preferences — basemap and which layers are drawn. */
  settings: RadarSettings;
  /** Centre and zoom to open at, from a shared link. Read once, on setup. */
  initialView?: { lat: number | null; lon: number | null; zoom: number | null };
}>();

const emit = defineEmits<{
  (e: "select", key: string | null): void;
  /** Reported so the parent can put the viewport in the URL. */
  (e: "move", view: { lat: number; lon: number; zoom: number }): void;
  /**
   * 人自己动了地图，跟随该停了。
   *
   * 由地图报而不是外面猜：只有这里分得清「人拖的」和「跟随自己挪的」——
   * `panTo` 不会触发 `dragstart`，所以这个事件只在真的有人拖动时发出。少了它，
   * 跟随开着的时候地图会把人每一次拖动都拽回去，那不是跟随，是抢方向盘。
   */
  (e: "follow-cancel"): void;
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
/** VATSpy 的边界 id → 它在 `boundaryShapes` 里占的那些键。一个 id 底下同时有
 *  陆地和公海两块时是两个键，见 `boundaryKey`。 */
const boundaryKeysById = new Map<string, string[]>();
let boundaryControllers = new Map<string, Controller[]>();
let activeBoundaries = new Set<string>();

let didInitialFit = false;

const pilotKey = (p: Pilot) => `pilot:${p.cid || p.callsign}`;
const atcKey = (c: Controller) => `atc:${c.callsign}`;

/* ------------------------------------------------------------------ *
 * Controller ↔ boundary matching — see `@/lib/firs`
 * ------------------------------------------------------------------ */

/**
 * 一个席位该点亮 `boundaryShapes` 里的哪几个键。
 *
 * 判据整个在 `@/lib/firs` 里（VATSpy 的呼号前缀表，最长前缀赢）；这里只做一件
 * 那边做不了的事：把边界 **id** 落到本地的**键**上。一个 id 底下可能挂着两个要
 * 素（陆地一块、公海一块），它们在 `boundaryShapes` 里是两个键，见 `boundaryKey`。
 *
 * 表还没取回来时返回空 —— 地图照常画，边界等 `loadFirs()` 落地后那一次
 * `syncBoundaries()` 再上色。
 */
function boundaryKeysFor(callsign: string): string[] {
  const match = firMatch(callsign);
  if (!match) return [];

  const oceanic = prefersOceanic(callsign);
  const keys: string[] = [];

  for (const id of match.boundaries) {
    const candidates = boundaryKeysById.get(id);
    if (!candidates?.length) continue;
    // 挑不到就用第一个：绝大多数 id 只有一个要素，海陆之分根本不适用。
    const picked =
      candidates.find((key) => isOceanicKey(key) === oceanic) ?? candidates[0];
    if (!keys.includes(picked)) keys.push(picked);
  }

  return keys;
}

/**
 * CTR/FSS positions own an area rather than a point on the map.
 *
 * 判据在 `lib/facilities`，因为机场卡也要同一条 —— 理由写在那儿。
 *
 * FSS 以前只认 `PRC_FSS` 一个呼号，因为那时候没有对照表，别的 FSS 呼号匹配不出
 * 任何边界 —— 把它们算成「拥有空域」的结果是既没有多边形也没有机场标牌，人整个
 * 消失。现在 `[UIRs]` 在表里（`ASEA_FSS` 是东南亚那一串），这条限制没有必要了：
 * 匹配不到的席位由 `boundaryKeysFor` 返回空，本来就不会画错东西。
 */
function ownsAirspaceStation(controller: Controller): boolean {
  return ownsAirspace(controller.facility);
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
function pilotSignature(
  pilot: Pilot,
  selected: boolean,
  mine: boolean,
): string {
  return [
    isOnGround(pilot) ? "g" : "a",
    Math.round(pilot.heading),
    altitudeColor(pilot.altitude, props.theme),
    iconScale(),
    selected ? "s" : "",
    mine ? "m" : "",
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
 *
 * 两种记号可以同时戴：选中的那一圈白边，和「这是我自己」的那一圈品牌色。自己
 * 那架画在里圈 —— 选中会换人，而它整个航段都是同一架，里圈是不会被挪走的那一
 * 层。用 `var(--vr-brand)` 而不是写死的色号：标记是 DOM（`preferCanvas` 只管
 * 向量图层），所以自定义属性在这里是认的，品牌色仍然只有一处定义。
 */
function aircraftIcon(
  pilot: Pilot,
  selected: boolean,
  mine: boolean,
): L.DivIcon {
  const color = altitudeColor(pilot.altitude, props.theme);
  const onGround = isOnGround(pilot);

  const size = onGround
    ? Math.max(16, Math.round(iconScale() * 0.72))
    : iconScale();
  const anchor = size / 2;
  const svgSize = size - 4;

  const rings = [
    mine ? "0 0 0 2px var(--vr-brand)" : "",
    selected ? `0 0 0 ${mine ? 4 : 2}px rgba(255,255,255,.7)` : "",
  ].filter(Boolean);

  return L.divIcon({
    className: "aircraft-marker",
    html: `
      <div style="
        width:${size}px;height:${size}px;
        transform: rotate(${pilot.heading - 45}deg);
        display:flex;align-items:center;justify-content:center;
        ${rings.length ? `border-radius:50%;box-shadow:${rings.join(",")};` : ""}
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
    const mine = props.mine === key;
    const signature = pilotSignature(pilot, selected, mine);

    let marker = pilotMarkers.get(key);
    if (!marker) {
      marker = L.marker([lat, lon], {
        icon: aircraftIcon(pilot, selected, mine),
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
        marker.setIcon(aircraftIcon(pilot, selected, mine));
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

/**
 * Which tag a position belongs to.
 *
 * 分组用的是**解析过的 ICAO** 而不是呼号第一段：北美的本场席位报三字代码
 * （`MEM_TWR`），而标牌上那个代码同时是「点它打开机场卡」的键，卡里的进离场、
 * 天气和坐标全按 ICAO 查。见 `lib/airportCodes`。
 */
function stationGroupKey(
  callsign: string,
  facility: number,
  isAtis: boolean,
): string {
  const local = isLocalPosition(facility, isAtis);
  return local ? stationField(callsign, true) : `pos:${callsign}`;
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
    const local = isLocalPosition(facility, isAtis);
    const id = stationGroupKey(station.callsign, facility, isAtis);
    // An approach whose airspace is drawn is labelled on that airspace's
    // boundary instead of at the airport it reports from.
    const anchor = traconLabelPoints.get(atcKey(station));
    const group = groups.get(id) ?? {
      code: stationField(station.callsign, local),
      lat: anchor?.[0] ?? lat,
      lon: anchor?.[1] ?? lon,
      local,
      stack: 0,
      stations: [],
    };
    group.stations.push({ station, key: atcKey(station), facility, isAtis });
    groups.set(id, group);
  };

  for (const controller of props.controllers) {
    if (ownsAirspaceStation(controller)) continue;
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

/* 两套边界样式。颜色来自 AREA_COLORS（见 lib/radar.ts 里为什么是字面量），而
 * 「没人管」那一套跟主题走，所以它是函数而不是常量 —— 主题一换，下面那个
 * watch 会把所有多边形重新上一遍色。 */
const ACTIVE_STYLE: L.PathOptions = {
  color: AREA_COLORS.active,
  weight: 2,
  opacity: 0.8,
  fillOpacity: 0.1,
  fillColor: AREA_COLORS.active,
};
function inactiveStyle(): L.PathOptions {
  return {
    color: AREA_COLORS.idle[props.theme],
    weight: 1,
    opacity: 0.55,
    fillOpacity: 0,
  };
}

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
 * VATSpy 偶尔把一块陆地和一块公海挂在同一个 id 底下 —— 现在是 `KZNY`（纽约）和
 * `SUEO`（蒙得维的亚），公海那块往往比陆地大好几倍。合成一个键的话，一个
 * `NY_CTR` 会同时点亮两块，地图上就成了「这个人管着半个大西洋」。这里把它们分
 * 成两个键，由 `boundaryKeysFor` 挑一个（判据见 `lib/firs` 的 `prefersOceanic`）。
 *
 * 东京以前也是这样一个 id 两块地；上游已经把东京海洋区拆成独立的 `RJJJ`，所以
 * 今天这条只剩两个 id 用得上 —— 留着是因为上游随时可能再合并回去，而合并回去的
 * 表现是一整片公海无声地亮起来。
 */
const OCEANIC_SUFFIX = "#oceanic";

function boundaryKey(id: string, oceanic: boolean): string {
  return oceanic ? `${id}${OCEANIC_SUFFIX}` : id;
}

function isOceanicKey(key: string): boolean {
  return key.endsWith(OCEANIC_SUFFIX);
}

/**
 * 空闲时不画的那些边界 —— 被拆开的扇区。
 *
 * `boundaries.geojson` 里 1102 个要素中有 633 个是扇区划分（`ADR-E`、
 * `RJDG-F01` 这样），它们**画在自己所属 FIR 的多边形之上**。全部铺开的结果是每
 * 个被拆过的 FIR 都有一圈外框加几条内部分割线，叠成一张网 —— 这就是那片杂乱。
 *
 * 判据是「父 FIR 也在这份数据里」，不是「id 里有连字符」。有 32 个子扇区找不到
 * 父要素（`TEH-*`、`LGMD-*`，以及**这张网络自己的 `ZJSY-*` 三亚**，它的父要素
 * 叫 `ZJSA`），按连字符一刀切会让那几块空域整个消失。
 *
 * 只影响**空闲**图层：一旦有人上了某个扇区，syncBoundaries 会把它挪进
 * boundariesLayer 照常高亮 —— 「这块被拆开的空域现在有人管」恰恰是必须画出来的
 * 那种信息。
 */
const idleHiddenBoundaries = new Set<string>();

function buildBoundaries(data: GeoJSON.FeatureCollection) {
  if (!quietBoundariesLayer) return;

  const rawIds = new Set<string>();
  for (const feature of data.features) {
    const id =
      feature.properties?.ID ||
      feature.properties?.id ||
      feature.properties?.name;
    if (id) rawIds.add(String(id));
  }

  for (const feature of data.features) {
    const boundaryId =
      feature.properties?.ID ||
      feature.properties?.id ||
      feature.properties?.name;
    if (!boundaryId) continue;

    const raw = String(boundaryId);
    const key = boundaryKey(raw, String(feature.properties?.oceanic) === "1");

    const keys = boundaryKeysById.get(raw);
    if (!keys) boundaryKeysById.set(raw, [key]);
    else if (!keys.includes(key)) keys.push(key);

    const parent = raw.includes("-") ? raw.slice(0, raw.indexOf("-")) : null;
    if (parent && rawIds.has(parent)) idleHiddenBoundaries.add(key);

    const shape = L.geoJSON(feature, { style: inactiveStyle() });
    const shapes = boundaryShapes.get(key) ?? [];
    shapes.push(shape);
    boundaryShapes.set(key, shapes);
    if (!idleHiddenBoundaries.has(key)) quietBoundariesLayer.addLayer(shape);
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
    if (!ownsAirspaceStation(controller)) continue;

    for (const boundaryId of boundaryKeysFor(controller.callsign)) {
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
      shape.setStyle(isActive ? ACTIVE_STYLE : inactiveStyle());
      // A staffed sector is always drawn; an unstaffed one is subject to the
      // zoom filter, so the two live in different layers.
      (isActive ? quietBoundariesLayer : boundariesLayer)?.removeLayer(shape);
      // 空闲的扇区划分不画回去（见 idleHiddenBoundaries）—— 少了这个判断，一个
      // 上过线又下线的扇区就会作为一条内部分割线永久留在图上。
      if (isActive) boundariesLayer?.addLayer(shape);
      else if (!idleHiddenBoundaries.has(boundaryId))
        quietBoundariesLayer?.addLayer(shape);
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
  const color = ROUTE_COLORS[props.theme];
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

  /* 每一段都标，而不是一条航路只标两三处。
   *
   * 原来是按一个固定间距在一段长航路上均匀撒几个标签，于是「这一段是哪
   * 条航路」这个问题，在两个标签之间的那些腿上是答不出来的 —— 而那正是有人放大
   * 去看某一个航路点时所在的位置。
   *
   * **进离场程序不标。** 一条 SID 有十几条腿，每条都写一遍 LEKE1D 就是在同一个
   * 词上堆十几个标签，而它们本来就挤在机场周围最小的那块地方。程序的名字在详情
   * 卡的飞行计划里，那里只需要出现一次。
   *
   * 密度由缩放级别兜着（.show-via-labels，见 applyLabelFilter）：拉远到看不清
   * 的时候整批标签都不画。 */
  let from: LatLon = position;

  for (const point of ahead) {
    const to: LatLon = [point.lat, point.lon];
    const procedure = point.kind === "sid" || point.kind === "star";

    if (point.via && !procedure) {
      viaLabel(
        [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
        point.via,
        color,
      ).addTo(routeLayer);
    }

    from = to;
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
          <svg class="radar-fix__dot" viewBox="0 0 10 9" aria-hidden="true"><path d="M5 .6 9.5 8.4H.5z"/></svg
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
      const mine = props.mine === key;
      pilotMarker.setIcon(aircraftIcon(pilot, selected, mine));
      iconSignatures.set(key, pilotSignature(pilot, selected, mine));
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

  // A CTR/FSS position is its airspace — frame the whole thing. A UIR covers
  // several FIRs, so the frame is every piece of it rather than the first.
  const bounds = L.latLngBounds([]);
  for (const boundaryId of boundaryKeysFor(controller.callsign)) {
    for (const shape of boundaryShapes.get(boundaryId) ?? []) {
      bounds.extend(shape.getBounds());
    }
  }
  if (bounds.isValid())
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
}

/**
 * 跟随自己那架：把它挪回画面中央。
 *
 * `panTo` 而不是 `setView`：**缩放一个字都不动**。跟着自己飞的人多半正把比例
 * 尺调在他要的那一档（进近时拉近看跑道，巡航时拉远看航路），每三十秒替他重设
 * 一次缩放，比不跟随还烦人。
 *
 * 已经在画面中间那一小块里就不动 —— 每次刷新都来一次动画，会让整张图看上去一
 * 直在轻微地晃。
 */
function keepFollowing() {
  if (!map || !props.follow || !props.mine) return;
  const marker = pilotMarkers.get(props.mine);
  if (!marker) return;

  const target = marker.getLatLng();
  const size = map.getSize();
  const offset = map.latLngToContainerPoint(target).subtract(size.divideBy(2));
  // 画面短边的六分之一 —— 大约是「还在中间」的那一块。
  const slack = Math.min(size.x, size.y) / 6;
  if (Math.abs(offset.x) < slack && Math.abs(offset.y) < slack) return;

  map.panTo(target, { animate: true });
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

/* ------------------------------------------------------------------ *
 * 地图控件的接口
 *
 * Leaflet 自带的 `+ / −` 控件被关掉了（`zoomControl: false`），换成左下角那一
 * 列和别的按钮同一套样子的方块 —— 照 vatsim-radar 的 `MapControls`。控件是外面
 * 那个组件，所以缩放要从这里露出去。
 *
 * `zoom` 是一个 ref 而不是一个函数：按钮到了上下限要变灰，那需要一个会触发重新
 * 渲染的值，`map.getZoom()` 不会。
 * ------------------------------------------------------------------ */

const zoom = ref(0);
const zoomRange = ref<[min: number, max: number]>([0, 18]);

function syncZoomState() {
  if (!map) return;
  zoom.value = map.getZoom();
  zoomRange.value = [map.getMinZoom(), map.getMaxZoom()];
}

function zoomBy(delta: number) {
  if (!map || map.getZoom() === undefined) return;
  const [min, max] = zoomRange.value;
  const next = Math.min(max, Math.max(min, map.getZoom() + delta));
  if (next === map.getZoom()) return;
  map.setZoom(next, { animate: true });
}

defineExpose({
  focus,
  zoom,
  zoomRange,
  zoomIn: () => zoomBy(1),
  zoomOut: () => zoomBy(-1),
  /** 把视野拉回到当前所有交通上。 */
  fitAll: () => fitToTraffic(true),
});

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
    const mine = props.mine === key;
    const signature = pilotSignature(pilot, selected, mine);
    if (iconSignatures.get(key) === signature) continue;
    marker.setIcon(aircraftIcon(pilot, selected, mine));
    iconSignatures.set(key, signature);
  }
}

function fitToTraffic(force = false) {
  if (!map) return;
  if (didInitialFit && !force) return;
  const points: L.LatLngExpression[] = [];
  for (const pilot of props.pilots) {
    if (Number.isFinite(pilot.latitude) && Number.isFinite(pilot.longitude)) {
      points.push([pilot.latitude, pilot.longitude]);
    }
  }
  for (const marker of atcMarkers.values()) points.push(marker.getLatLng());
  // 区调的标牌在 `sectorMarkers` 里，不在 `atcMarkers` 里 —— 漏掉它的表现是：网
  // 络上只有一个区调、一架飞机都没有时，可取的点是空的，于是退回默认的中国视
  // 角。那个人明明画出来了，只是在屏幕外，看上去像根本没上线。
  for (const marker of sectorMarkers.values()) points.push(marker.getLatLng());
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
    // 缩放交给左下角那一列自绘按钮（见 defineExpose 上方的说明）。Leaflet 自带
    // 的控件是一块白色圆角，和这套近黑的设计对不上，两套按钮并排更难看。
    zoomControl: false,
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

  // 比例尺挪到右下角：左下角现在是那一列控件的位置。
  L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);

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
    syncZoomState();
  });
  syncZoomState();
  // Clicking empty map clears the selection, the way the list expects.
  map.on("click", () => emit("select", null));

  // 人一上手拖地图，跟随就停。`dragstart` 只有真的有人在拖时才触发 —— 跟随自
  // 己用的 `panTo` 不算拖动，所以这里不会自己把自己关掉。
  map.on("dragstart", () => {
    if (props.follow) emit("follow-cancel");
  });

  syncStations();
  syncTracons();
  syncPilots();
  applyGroundFilter();
  applyLabelFilter();
  fitToTraffic();

  try {
    // 三份一起取：多边形、「哪个呼号管哪块多边形」（lib/firs），以及「三字代码
    // 是哪个机场」（lib/airportCodes）。前两者一起等是因为第一次 syncBoundaries
    // 跑在表到齐之前会把所有边界都判成没人管；第三份到位之后要重跑一次
    // syncStations，否则北美的标牌会停在 `MEM` 而不是 `KMEM`。
    const [response] = await Promise.all([
      fetch("/boundaries.geojson"),
      loadFirs(),
      loadAirportCodes(),
    ]);
    buildBoundaries(await response.json());
    applyBoundaryFilter();
    syncBoundaries();
    syncStations();
    // 再试一次初始定位：区调的标牌到这一步才存在，而上面那次（挂载时）看不到它
    // 们。已经定过位的话 `didInitialFit` 会挡住，不会把画面抢回去。
    fitToTraffic();
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
    // 位置刚更新过，跟随要在这之后 —— 反过来写会永远慢一拍，跟着的是上一次的
    // 坐标。
    keepFollowing();
  },
);

/**
 * 自己那架换了（登录、登出、上线、下线）。
 *
 * 只需要重画记号：`rescaleIcons` 会逐个比对签名，而签名里带着「是不是我」，所
 * 以它正好只重画摘下和戴上记号的那两架。
 */
watch(
  () => props.mine,
  () => {
    rescaleIcons();
    keepFollowing();
  },
);

// 刚打开跟随时先挪一次，不等下一轮刷新 —— 三十秒的沉默会让人以为按钮没生效。
watch(
  () => props.follow,
  (on) => {
    if (on) keepFollowing();
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
    // 没人管的那些边界的颜色跟着主题走（AREA_COLORS.idle），所以主题一换要重新
    // 上色 —— 少了这一句，从深色切到浅色之后那张网还是深色那一版的灰。
    syncBoundaries();
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
/* ---------------------------------------------------------------------------
   地图上的字。

   全部改成 vr-theme.css 的记号 —— 原来这里写死的是 slate 系（#0f172a /
   #e2e8f0），那是 can-web 的配色。地图是这个站唯一的主体，标签的底色和面板的底
   色差一点点就会看出来是两套东西拼的。

   两个不跟主题走的例外，写在下面各自的注释里。
--------------------------------------------------------------------------- */

/* 悬停标签。globals.css 底部那块 Leaflet 规则是刻意冻住的，所以 tooltip 的皮
   跟着引入它的组件走。 */
.leaflet-tooltip {
  padding: 2px 6px;
  border: 1px solid var(--vr-stroke);
  border-radius: var(--radius-control);
  background: var(--vr-bg);
  color: var(--vr-t1);
  font-family: var(--vr-font-sans);
  font-size: 11px;
  font-weight: 500;
  box-shadow: var(--vr-shadow);
}

.leaflet-tooltip-top::before {
  border-top-color: var(--vr-stroke);
}

/* 呼号，跟在飞机旁边，由缩放级别的过滤器决定露不露，而不是每个标记重建一次。

   等宽字：一屏上几十个呼号竖着排下来，比例字宽的话每一个的长度都不一样，扫过去
   像一堆碎纸片。 */
.aircraft-label {
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  display: none;
  margin-top: 1px;
  padding: 0 3px;
  border-radius: 3px;
  white-space: nowrap;
  background: color-mix(in srgb, var(--vr-bg) 82%, transparent);
  color: var(--vr-t1);
  font-family: var(--vr-font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: 0.01em;
  pointer-events: none;
}

.show-aircraft-labels .aircraft-label {
  display: block;
}

/* 席位标签。图标元素本身是零尺寸、锚在坐标上：小圆点标的是机场，标签浮在它上
   方，而不是盖住它命名的那个东西。 */
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
  background: var(--vr-bg);
  border: 1.5px solid var(--vr-t2);
}

.radar-tag {
  position: absolute;
  /* 落在小圆点上方。第 0 行离它最近；共用一个位置的标签从那里往上叠，所以谁都不
     会盖住机场本身。 */
  transform: translate(
    -50%,
    calc(-100% - 9px - var(--radar-tag-row, 0) * 23px)
  );
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  /* 4px 而不是 6px —— 这套设计里的圆角一律小一档。 */
  border-radius: var(--radius-control);
  white-space: nowrap;
  background: color-mix(in srgb, var(--vr-bg) 94%, transparent);
  border: 1px solid var(--vr-stroke);
  box-shadow: var(--vr-shadow);
  font-size: 11px;
  line-height: 1.45;
}

/* 选中的那一个描一圈品牌色。原来描的是中性灰，在一屏彩色的席位方块里根本认不
   出哪个是「我刚点的那个」。 */
.radar-tag.is-selected {
  border-color: var(--vr-brand);
  box-shadow:
    0 0 0 1px var(--vr-brand),
    var(--vr-shadow);
}

.radar-tag__code {
  font-family: var(--vr-font-alt);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vr-t1);
  cursor: pointer;
}

.radar-tag__chips {
  display: flex;
  gap: 3px;
}

.radar-tag__chip {
  padding: 0 4px;
  border-radius: 3px;
  /* 席位色是饱和的实色，白字在六种颜色上都读得动 —— 这里**不跟主题走**，
     深浅两套下都是白字。 */
  color: #fff;
  font-family: var(--vr-font-alt);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  /* 方块才是点击目标，围着它们的标签不是。 */
  cursor: pointer;
}

.radar-tag__chip.is-selected {
  box-shadow: 0 0 0 1.5px var(--vr-bg);
}

/* 航路两端：机场上一个点，旁边是它的 ICAO。 */
.radar-airport {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 2px;
  border-radius: 3px;
  white-space: nowrap;
  background: color-mix(in srgb, var(--vr-bg) 85%, transparent);
  color: var(--vr-t1);
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.radar-airport__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--radar-airport-color, var(--vr-t3));
}

/* 航路上的航路点。点是标记，名字由缩放过滤器决定露不露，而且永远不会出现在小
   到只剩一个点的标记上。 */
.radar-fix {
  position: absolute;
  /* 半个标记，这样标记本身落在航路点上、名字挂在它旁边。整个盒子居中的话，名
     字一出现标记就从航路点上走开了。数值跟着 .radar-fix__dot 的尺寸走。 */
  transform: translate(-6px, -5.25px);
  display: flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  font-family: var(--vr-font-mono);
  font-size: 9px;
  font-weight: 500;
  line-height: 1;
}

/* 航路点是三角形，不是圆点 —— vatsim-radar 就是这么画的，而且它把「航路上的
   点」和地图上别的圆形标记（机场、席位的小圆点）从形状上分开了：一屏上同时有
   三种圆点时，颜色不够用来区分它们。

   内联 SVG 而不是 CSS 的 border 三角形技巧：要的是描边加半透明填充，border 画
   出来的三角形是实心的，描不了边。 */
.radar-fix__dot {
  width: 12px;
  height: 10.5px;
  flex: none;
  overflow: visible;
  fill: color-mix(in srgb, var(--vr-bg) 88%, transparent);
  stroke: var(--radar-fix-color, var(--vr-t3));
  /* 描边按 viewBox 的单位算，元素放大它也跟着放大 —— 所以放大之后这个数要往
     回收一点，否则三角形会从「一个描出来的形状」变成「一坨实心的」。 */
  stroke-width: 1.2;
  stroke-linejoin: round;
}

.radar-fix__name {
  display: none;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--vr-bg) 80%, transparent);
  color: var(--vr-t2);
}

.show-fix-labels .radar-fix:not(.radar-fix--terminal) .radar-fix__name,
.show-terminal-labels .radar-fix--terminal .radar-fix__name {
  display: block;
}

/* 某一段航路飞的是哪条航路或程序，压在线上。缩放过滤器说放得下之前不显示。 */
.radar-via {
  position: absolute;
  transform: translate(-50%, -50%);
  display: none;
  padding: 0 3px;
  border-radius: 3px;
  white-space: nowrap;
  background: color-mix(in srgb, var(--vr-bg) 82%, transparent);
  color: var(--radar-via-color, var(--vr-t3));
  font-family: var(--vr-font-alt);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1.5;
}

.show-via-labels .radar-via {
  display: block;
}

/* 比例尺。Leaflet 自带的是一条白边黑字的方框，压在近黑的底图上是一块补丁。 */
.leaflet-control-scale-line {
  padding: 1px 5px;
  border: 1px solid var(--vr-stroke) !important;
  border-top: none !important;
  border-radius: 0 0 3px 3px;
  color: var(--vr-t3);
  font-family: var(--vr-font-alt);
  font-size: 10px;
  font-weight: 600;
  text-shadow: none;
  background: color-mix(in srgb, var(--vr-bg) 80%, transparent) !important;
}
</style>
