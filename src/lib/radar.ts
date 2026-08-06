/**
 * Radar maths and presentation helpers — browser-safe, imported by the Vue
 * islands that draw the live map.
 *
 * The altitude bands and their palette are ported from vatsim-radar
 * (`app/utils/shared/flight.ts`, `app/utils/colors.ts`), which is the reference
 * implementation for how a VATSIM-style map reads at a glance: colour carries
 * altitude, so the traffic picture tells you who is climbing out and who is at
 * cruise without opening a single popup.
 */

/**
 * Altitude bands, in feet. An aircraft's colour is the band its altitude falls
 * into, so the two palettes below have exactly one colour per band.
 */
export const ALTITUDE_STEPS = [
  2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000, 25000, 30000, 35000,
  40000, 45000, 50000, 55000, 60000,
] as const;

/** viridis, the preset vatsim-radar ships as its default altitude ramp. */
const ALTITUDE_COLORS: Record<"light" | "dark", readonly string[]> = {
  light: [
    "#8ed645",
    "#7ad151",
    "#69cd5b",
    "#5ac864",
    "#4ac16d",
    "#3dbc74",
    "#32b67a",
    "#28ae80",
    "#1fa187",
    "#20938c",
    "#24868e",
    "#2a788e",
    "#306a8e",
    "#365c8d",
    "#3e4c8a",
    "#443a83",
  ],
  dark: [
    "#86d549",
    "#7ad151",
    "#6ece58",
    "#63cb5f",
    "#58c765",
    "#4ec36b",
    "#44bf70",
    "#3bbb75",
    "#2cb17e",
    "#22a884",
    "#1f9f88",
    "#1f958b",
    "#228b8d",
    "#26828e",
    "#2a788e",
    "#2e6f8e",
  ],
};

/** Which altitude band `altitude` falls into. */
export function altitudeBand(altitude: number | null | undefined): number {
  if (!altitude || altitude < 0) return 0;
  const index = ALTITUDE_STEPS.findIndex((step) => altitude - 100 <= step);
  return index === -1 ? ALTITUDE_STEPS.length - 1 : index;
}

/** Aircraft colour for an altitude, in the given theme. */
export function altitudeColor(
  altitude: number | null | undefined,
  theme: "dark" | "light",
): string {
  return ALTITUDE_COLORS[theme][altitudeBand(altitude)];
}

/** Evenly spaced swatches for the map legend, low altitude first. */
export function altitudeLegend(
  theme: "dark" | "light",
): Array<{ color: string; label: string }> {
  const picks = [0, 3, 7, 10, 13];
  return picks.map((index) => ({
    color: ALTITUDE_COLORS[theme][index],
    label: `FL${Math.round(ALTITUDE_STEPS[index] / 100)}`,
  }));
}

export type LatLon = [lat: number, lon: number];

/** Great-circle distance in nautical miles. */
export function distanceNm(from: LatLon, to: LatLon): number {
  const EARTH_RADIUS_NM = 3440.065;
  const rad = Math.PI / 180;

  const dLat = (to[0] - from[0]) * rad;
  const dLon = (to[1] - from[1]) * rad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from[0] * rad) * Math.cos(to[0] * rad) * Math.sin(dLon / 2) ** 2;

  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Points along the great circle between two coordinates.
 *
 * A straight line on a Mercator map is not the path an aircraft flies —
 * ZBAA to KLAX bows a long way north of it — so a route leg is drawn as an
 * interpolated arc. This is spherical linear interpolation, the same shape
 * turf's `greatCircle` produces for vatsim-radar, without the dependency.
 *
 * Longitudes come back unwrapped (they may run past ±180) so a leg crossing
 * the antimeridian draws as one line instead of snapping back across the
 * whole map.
 */
export function greatCircle(from: LatLon, to: LatLon, points = 64): LatLon[] {
  const rad = Math.PI / 180;
  const [lat1, lon1] = [from[0] * rad, from[1] * rad];

  // Take the shorter way round before interpolating.
  let lon2 = to[1];
  while (lon2 - from[1] > 180) lon2 -= 360;
  while (lon2 - from[1] < -180) lon2 += 360;
  const [lat2, lon2rad] = [to[0] * rad, lon2 * rad];

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2rad - lon1) / 2) ** 2,
      ),
    );

  // Coincident, or close enough that the arc and the chord are the same line.
  if (!Number.isFinite(d) || d < 1e-9) return [from, [to[0], lon2]];

  const path: LatLon[] = [];
  for (let i = 0; i <= points; i++) {
    const f = i / points;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);

    const x =
      a * Math.cos(lat1) * Math.cos(lon1) +
      b * Math.cos(lat2) * Math.cos(lon2rad);
    const y =
      a * Math.cos(lat1) * Math.sin(lon1) +
      b * Math.cos(lat2) * Math.sin(lon2rad);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);

    path.push([
      Math.atan2(z, Math.sqrt(x * x + y * y)) / rad,
      Math.atan2(y, x) / rad,
    ]);
  }

  // Undo the ±180 wrap atan2 reintroduces.
  for (let i = 1; i < path.length; i++) {
    while (path[i][1] - path[i - 1][1] > 180) path[i][1] -= 360;
    while (path[i][1] - path[i - 1][1] < -180) path[i][1] += 360;
  }

  return path;
}

/**
 * Position colours, from vatsim-radar's `getFacilityPositionColor`.
 *
 * Keyed by the `facility` field of the datafeed (see `@/lib/facilities`). One
 * colour per kind of position, so a tag on the map says what is staffed
 * without being read: ground movement greens, tower red, approach orange,
 * en-route teal, ATIS amber.
 */
export const FACILITY_COLORS: Record<number, string> = {
  0: "#8b8b93", // OBS
  1: "#2ea78f", // FSS — en-route, same family as CTR
  2: "#2c5ad9", // DEL
  3: "#4a9c25", // GND
  4: "#d32c00", // TWR
  5: "#ff861d", // APP
  6: "#2ea78f", // CTR
  7: "#f0bc01", // ATIS
};

export function facilityColor(facility: number): string {
  return FACILITY_COLORS[facility] ?? FACILITY_COLORS[0];
}

/**
 * One-letter labels for the positions that share an airport's tag, the way
 * vatsim-radar labels them: `UKBB D G T A`.
 *
 * A tag carries up to four of these side by side, and at that size three
 * letters each is a wall of text — the colour already says which is which, so
 * the letter only has to disambiguate. Positions with a tag to themselves
 * (approach, en-route) are not abbreviated: there is room, and `A` would be
 * ambiguous next to the ATIS.
 */
const FACILITY_LETTERS: Record<number, string> = {
  2: "D", // DEL
  3: "G", // GND
  4: "T", // TWR
  7: "A", // ATIS
};

export function facilityLetter(facility: number): string {
  return FACILITY_LETTERS[facility] ?? "";
}

/** Bottom-up, the order a controller reads an airport's positions in. */
const FACILITY_RANK: Record<number, number> = {
  2: 0,
  3: 1,
  4: 2,
  5: 3,
  7: 4,
  6: 5,
  1: 6,
  0: 7,
};

export function facilityRank(facility: number): number {
  return FACILITY_RANK[facility] ?? 9;
}

/**
 * The airport a local position belongs to — everything before the first
 * underscore. `ZSSS_TWR`, `ZSSS_I_TWR` and `ZSSS_ATIS` all group under ZSSS,
 * which is what puts them in one tag on the map.
 */
export function stationAirport(callsign: string): string {
  return (callsign.split("_")[0] || callsign).toUpperCase();
}

/**
 * Parse a timestamp from the datafeed.
 *
 * `logon_time` arrives as `2026-07-27 12:34:55` — UTC wall-clock with nothing
 * to say so. `new Date()` reads that shape as *local* time, which put every
 * "online for" out by the viewer's offset: eight hours too long in China, and
 * in the wrong direction west of Greenwich.
 *
 * A value that does carry a zone (a trailing `Z` or `±HH:MM`) is left to the
 * platform, which already handles it correctly.
 */
export function parseFeedTime(value: string | null | undefined): Date | null {
  const text = (value ?? "").trim();
  if (!text) return null;

  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const zoned = new Date(text);
    return Number.isNaN(zoned.getTime()) ? null : zoned;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    const fallback = new Date(text);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0),
    ),
  );
}

/** `FL350`-style label. Sub-1000ft altitudes read better as plain feet. */
export function flightLevel(altitude: number): string {
  return Math.round(altitude / 100)
    .toString()
    .padStart(3, "0");
}

/**
 * Whether a pilot is taxiing/parked rather than flying.
 *
 * vatsim-radar decides this against an airport database (proximity + altitude);
 * we have no airport coordinates client-side, so this is groundspeed alone —
 * enough to declutter a busy apron, and wrong only for the handful of seconds
 * around lift-off and touchdown.
 */
export function isOnGround(pilot: { groundspeed: number }): boolean {
  return pilot.groundspeed <= 40;
}

/** Escape a string for interpolation into marker HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
