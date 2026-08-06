import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

/**
 * Navigation data: turning a filed route string into a line on the map.
 *
 * The source is `data/navdata/*.txt.gz`, built by `scripts/build-navdata.mjs`
 * from a PSS-format database. It is read **server-side only** and one route at
 * a time — the whole database is never handed to a browser. That is partly
 * size (6 MB gzipped) and mostly provenance: terminal procedures come from an
 * AIRAC cycle, which is not ours to redistribute wholesale.
 *
 * Everything is loaded lazily on the first route request and then kept, so a
 * radar session with nobody selected costs nothing.
 *
 * The files live outside `dist/`, so the process must be started from the
 * repo root — which `bun run start` does — or `NAVDATA_DIR` must point at them.
 * When they are missing the resolver reports it rather than throwing, and the
 * map simply draws no route.
 */

export interface RoutePoint {
  ident: string;
  lat: number;
  lon: number;
  /** What put this point on the line, so the map can style it. */
  kind: "airport" | "fix" | "airway" | "sid" | "star";
  /**
   * The airway or procedure this point was reached along — `W47`, `BOTP2G`.
   * Absent on a fix flown direct, which is exactly what the map should say
   * about it. A run of points sharing one is one labelled stretch of line.
   */
  via?: string;
}

const DATA_DIR =
  process.env.NAVDATA_DIR || join(process.cwd(), "data", "navdata");

/* ------------------------------------------------------------------ *
 * Indices
 *
 * Each file is kept as the decompressed text plus a table of the offsets its
 * records start at, and looked up by binary search. Nothing is turned into
 * objects until a route asks for it.
 *
 * That is not premature: as dictionaries these three files cost ~320 MB of
 * heap, most of it 300,000 `Map` entries and the arrays hanging off them. As
 * text and offsets they cost ~27 MB, which is the text itself. The files are
 * written sorted by exactly the key searched here (see scripts/build-navdata).
 * ------------------------------------------------------------------ */

interface Table {
  text: string;
  /** Where each record starts. Fixes: every line. Others: header lines. */
  offsets: Uint32Array;
}

interface NavData {
  fixes: Table;
  airways: Table;
  procedures: Table;
}

let cache: NavData | null = null;
let unavailable = false;

function read(name: string): string {
  return gunzipSync(readFileSync(join(DATA_DIR, name))).toString("utf8");
}

/**
 * Offsets of the lines that start a record.
 *
 * `headersOnly` picks out the `=` lines, which is how the airway and procedure
 * files mark the start of a block; the fixes file has one record per line.
 */
function index(text: string, headersOnly: boolean): Uint32Array {
  const offsets: number[] = [];

  let offset = 0;
  while (offset < text.length) {
    if (!headersOnly || text.charCodeAt(offset) === 61 /* = */)
      offsets.push(offset);
    const lineEnd = text.indexOf("\n", offset);
    if (lineEnd === -1) break;
    offset = lineEnd + 1;
  }

  return Uint32Array.from(offsets);
}

/** Load the tables, or report that the data is not deployed. */
function load(): NavData | null {
  if (cache) return cache;
  if (unavailable) return null;

  try {
    const fixes = read("fixes.txt.gz");
    const airways = read("airways.txt.gz");
    const procedures = read("procedures.txt.gz");

    cache = {
      fixes: { text: fixes, offsets: index(fixes, false) },
      airways: { text: airways, offsets: index(airways, true) },
      procedures: { text: procedures, offsets: index(procedures, true) },
    };
    return cache;
  } catch {
    // Missing or unreadable: say so once and stop trying on every request.
    unavailable = true;
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Reading records
 * ------------------------------------------------------------------ */

/** The record at `offsets[i]`, without its trailing newline. */
function lineAt(table: Table, i: number): string {
  const start = table.offsets[i];
  const end = table.text.indexOf("\n", start);
  return end === -1 ? table.text.slice(start) : table.text.slice(start, end);
}

/**
 * The key a record is sorted by: the first `fields` space-separated words,
 * with the leading `=` of a header dropped.
 *
 * The search for each separator has to stop at the end of the line. An airway
 * header is just `=W47` — no space at all — and a scan that runs past the
 * newline finds one in the next leg and returns a "key" spanning two records,
 * which sorts nowhere near where the binary search expects it.
 */
function keyAt(table: Table, i: number, fields: number): string {
  const offset = table.offsets[i];
  const start = offset + (table.text.charCodeAt(offset) === 61 ? 1 : 0);

  const newline = table.text.indexOf("\n", start);
  const lineEnd = newline === -1 ? table.text.length : newline;

  let end = start;
  for (let field = 0; field < fields; field++) {
    const space = table.text.indexOf(" ", end);
    if (space === -1 || space >= lineEnd)
      return table.text.slice(start, lineEnd);
    end = field === fields - 1 ? space : space + 1;
  }
  return table.text.slice(start, end);
}

/** Index of the first record with this key, or -1. Records are sorted by it. */
function search(table: Table, key: string, fields: number): number {
  let low = 0;
  let high = table.offsets.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = keyAt(table, mid, fields);

    if (candidate < key) {
      low = mid + 1;
    } else if (candidate > key) {
      high = mid - 1;
    } else {
      // Keep going left: duplicates are adjacent and the first one is wanted.
      found = mid;
      high = mid - 1;
    }
  }

  return found;
}

/** `IDENT lat lon` → a point, or null if the line is not one. */
function pointFrom(line: string, kind: RoutePoint["kind"]): RoutePoint | null {
  const first = line.indexOf(" ");
  const second = line.indexOf(" ", first + 1);
  if (first < 1 || second < 0) return null;

  const lat = Number(line.slice(first + 1, second));
  const lon = Number(line.slice(second + 1));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { ident: line.slice(0, first), lat, lon, kind };
}

/** The legs of the block whose header is at `offsets[i]`. */
function legsOf(
  table: Table,
  i: number,
  kind: RoutePoint["kind"],
): RoutePoint[] {
  const start = table.text.indexOf("\n", table.offsets[i]);
  if (start === -1) return [];

  const end =
    i + 1 < table.offsets.length ? table.offsets[i + 1] : table.text.length;
  const points: RoutePoint[] = [];

  for (const line of table.text.slice(start + 1, end).split("\n")) {
    if (!line) continue;
    const point = pointFrom(line, kind);
    if (point) points.push(point);
  }

  return points;
}

export function navDataAvailable(): boolean {
  return load() !== null;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Squared great-circle-ish distance, used only for comparing candidates.
 *
 * Longitude is scaled by the cosine of the latitude so a degree east means
 * roughly what a degree north does. Nothing here needs a real distance — it
 * needs to know which of five fixes called KAPPA is the one being flown to.
 */
function nearness(
  lat: number,
  lon: number,
  toLat: number,
  toLon: number,
): number {
  let dLon = lon - toLon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;

  const scale = Math.cos(((lat + toLat) / 2) * (Math.PI / 180));
  const x = dLon * scale;
  const y = lat - toLat;
  return x * x + y * y;
}

/* ------------------------------------------------------------------ *
 * Route resolution
 * ------------------------------------------------------------------ */

/**
 * Strip the decorations a filed route hangs on a fix.
 *
 * `SANLI/N0450F350` is a fix with a speed and level change; `PIKAS/1830` a
 * fix with a time. The part before the slash is the fix, and everything a
 * controller reads off the strip is irrelevant to where the line goes.
 */
function cleanToken(token: string): string {
  const cut = token.indexOf("/");
  return (cut > 0 ? token.slice(0, cut) : token).toUpperCase();
}

/** Tokens that describe how to fly rather than where. */
const NOISE = new Set([
  "DCT",
  "SID",
  "STAR",
  "IFR",
  "VFR",
  "SIDSTAR",
  "DIRECT",
]);

/**
 * Latitude/longitude tokens — `52N030W`, `5230N03000W`, `N52W030`. They turn
 * up on oceanic routes, where there is no fix to name.
 */
function parseCoordinateToken(token: string): [number, number] | null {
  let match = /^(\d{2})([NS])(\d{3})([EW])$/.exec(token);
  if (match) {
    const lat = Number(match[1]) * (match[2] === "S" ? -1 : 1);
    const lon = Number(match[3]) * (match[4] === "W" ? -1 : 1);
    return [lat, lon];
  }

  match = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(token);
  if (match) {
    const lat =
      (Number(match[1]) + Number(match[2]) / 60) * (match[3] === "S" ? -1 : 1);
    const lon =
      (Number(match[4]) + Number(match[5]) / 60) * (match[6] === "W" ? -1 : 1);
    return [lat, lon];
  }

  return null;
}

/**
 * The fix of this ident nearest `fromLat/fromLon`.
 *
 * Every fix sharing an ident is adjacent in the file, so the search lands on
 * the first and the rest are read by walking forward.
 */
function resolveFix(
  data: NavData,
  ident: string,
  fromLat: number,
  fromLon: number,
): RoutePoint | null {
  const table = data.fixes;
  const first = search(table, ident, 1);
  if (first === -1) return null;

  let best: RoutePoint | null = null;
  let bestScore = Infinity;

  for (let i = first; i < table.offsets.length; i++) {
    const line = lineAt(table, i);
    if (!line.startsWith(`${ident} `)) break;

    const point = pointFrom(line, "fix");
    if (!point) continue;

    const score = nearness(point.lat, point.lon, fromLat, fromLon);
    if (score < bestScore) {
      bestScore = score;
      best = point;
    }
  }

  return best;
}

/**
 * The stretch of `airway` between two fixes.
 *
 * An airway name is reused around the world and each region's run of it is a
 * separate segment, so the segment is chosen by having both endpoints on it —
 * and, when several do, by being nearest to where the aircraft already is.
 * The slice is reversed when the route runs against the file's ordering.
 */
function expandAirway(
  data: NavData,
  airway: string,
  fromIdent: string,
  toIdent: string,
  nearLat: number,
  nearLon: number,
): RoutePoint[] | null {
  const table = data.airways;
  const first = search(table, airway, 1);
  if (first === -1) return null;

  let best: { points: RoutePoint[]; score: number } | null = null;

  for (let i = first; i < table.offsets.length; i++) {
    if (lineAt(table, i) !== `=${airway}`) break;

    const legs = legsOf(table, i, "airway");
    const from = legs.findIndex((leg) => leg.ident === fromIdent);
    if (from === -1) continue;
    const to = legs.findIndex((leg) => leg.ident === toIdent);
    if (to === -1) continue;

    const step = to > from ? 1 : -1;
    const points: RoutePoint[] = [];
    for (let j = from + step; j !== to + step; j += step) {
      points.push({ ...legs[j], via: airway });
    }

    const score = nearness(legs[from].lat, legs[from].lon, nearLat, nearLon);
    if (!best || score < best.score) best = { points, score };
  }

  return best ? best.points : null;
}

/**
 * A procedure's geometry, choosing between its runway and transition variants.
 *
 * Which runway is in use is not in a flight plan, so the variant is picked by
 * the fix the route joins the procedure at — a SID is flown to its transition
 * fix, which is the next thing on the strip. Failing that, the longest variant
 * is used: it is the one that says the most about where the aircraft is going.
 */
function resolveProcedure(
  data: NavData,
  airport: string,
  name: string,
  adjacentIdent: string | null,
  kind: "sid" | "star",
): RoutePoint[] | null {
  const table = data.procedures;
  const key = `${airport} ${name}`;
  const first = search(table, key, 2);
  if (first === -1) return null;

  let best: RoutePoint[] = [];

  for (let i = first; i < table.offsets.length; i++) {
    // `=ZBAA BOTP2G SID RW18R BOTPU`
    const header = lineAt(table, i).slice(1).split(" ");
    if (`${header[0]} ${header[1]}` !== key) break;
    if (header[2] !== kind.toUpperCase()) continue;

    const legs = legsOf(table, i, kind).map((leg) => ({ ...leg, via: name }));
    if (adjacentIdent && header[4] === adjacentIdent) return legs;
    if (legs.length > best.length) best = legs;
  }

  return best.length ? best : null;
}

export interface ResolveInput {
  departure: string;
  arrival: string;
  route: string;
  /** Airport coordinates, which this module does not carry itself. */
  departureAt?: [number, number] | null;
  arrivalAt?: [number, number] | null;
}

/**
 * Resolve a filed route into the points the map draws between.
 *
 * Unknown tokens are skipped rather than failing the route: a filed route is
 * free text typed by a member, and half a drawn route beats none. The result
 * is the *whole* route — trimming it to what is still ahead is the map's job,
 * because that changes every time the aircraft moves and this does not.
 */
export function resolveRoute(input: ResolveInput): RoutePoint[] {
  const data = load();
  if (!data) return [];

  const points: RoutePoint[] = [];
  const departure = input.departure.toUpperCase();
  const arrival = input.arrival.toUpperCase();

  // Where to start looking for the first fix. Every later fix is resolved
  // against the one before it, so the whole route hangs off this.
  let lat = input.departureAt?.[0] ?? 0;
  let lon = input.departureAt?.[1] ?? 0;

  if (input.departureAt) {
    points.push({ ident: departure, lat, lon, kind: "airport" });
  }

  const tokens = input.route
    .toUpperCase()
    .split(/[\s]+/)
    .map(cleanToken)
    .filter((token) => token && !NOISE.has(token));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // The airport codes sometimes bookend the route; they are already drawn.
    if (token === departure || token === arrival) continue;

    const coordinate = parseCoordinateToken(token);
    if (coordinate) {
      [lat, lon] = coordinate;
      points.push({ ident: token, lat, lon, kind: "fix" });
      continue;
    }

    // A procedure only counts at the end of the route it belongs to: a SID
    // first, a STAR last. Anywhere else, a matching name is a fix.
    const procedure =
      i === 0
        ? resolveProcedure(data, departure, token, tokens[1] ?? null, "sid")
        : i === tokens.length - 1
          ? resolveProcedure(
              data,
              arrival,
              token,
              tokens[i - 1] ?? null,
              "star",
            )
          : null;
    if (procedure?.length) {
      points.push(...procedure);
      lat = procedure[procedure.length - 1].lat;
      lon = procedure[procedure.length - 1].lon;
      continue;
    }

    // An airway needs the fix it leaves from and the fix it joins at, so it
    // is only read as one when it sits between two resolvable fixes.
    const next = tokens[i + 1];
    if (next && points.length) {
      const previous = points[points.length - 1];
      const expanded = expandAirway(
        data,
        token,
        previous.ident,
        next,
        lat,
        lon,
      );
      if (expanded) {
        points.push(...expanded);
        const last = expanded[expanded.length - 1] ?? previous;
        lat = last.lat;
        lon = last.lon;
        i++; // `next` was consumed as the airway's exit.
        continue;
      }
    }

    const fix = resolveFix(data, token, lat, lon);
    if (!fix) continue;

    points.push({ ident: token, lat: fix.lat, lon: fix.lon, kind: "fix" });
    lat = fix.lat;
    lon = fix.lon;
  }

  if (input.arrivalAt) {
    points.push({
      ident: arrival,
      lat: input.arrivalAt[0],
      lon: input.arrivalAt[1],
      kind: "airport",
    });
  }

  // Consecutive duplicates come from a procedure ending on the fix the next
  // leg starts at; they draw nothing and confuse the trimming on the client.
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.lat !== points[index - 1].lat ||
      point.lon !== points[index - 1].lon,
  );
}
