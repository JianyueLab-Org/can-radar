import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIContext } from "astro";
import { resolveRoute, navDataAvailable } from "@/server/navdata";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * A filed route, resolved into coordinates for the radar to draw.
 *
 * Unauthenticated, like the map it serves and like `/api/v1/track` — the rate
 * limit is the only gate. Nothing here reads the database or the session; the
 * request carries the route, the response carries points.
 *
 * The route string is resolved, not echoed: this is what keeps the navigation
 * database on the server. A browser asking for one flight's route gets that
 * flight's route, not a copy of every fix in the world.
 *
 * Answers are cached by route, because on a busy evening the same city pair is
 * flown by several aircraft at once and the resolution is identical for all of
 * them.
 */

function json(status: number, body: Record<string, unknown>) {
  return Response.json(
    { status, ...body, timestamp: new Date().toISOString() },
    { status },
  );
}

/** Longer than any real filed route; anything past this is not one. */
const MAX_ROUTE = 1500;

const ICAO = /^[A-Z0-9]{3,4}$/;

/** Resolved routes, newest last. Small: this is a map, not a database. */
const cached = new Map<string, unknown[]>();
const CACHE_LIMIT = 200;

/**
 * Airport coordinates, shared with the browser's own copy of the table.
 *
 * Read from `public/`, which the standalone build serves from `dist/client`
 * but which is also still on disk next to it — and the process is started from
 * the repo root either way (see `bun run start`).
 */
let airports: Record<string, [number, number]> | null = null;

function airportAt(icao: string): [number, number] | null {
  if (!airports) {
    try {
      airports = JSON.parse(
        readFileSync(join(process.cwd(), "public", "airports.json"), "utf8"),
      );
    } catch {
      airports = {};
    }
  }
  return airports?.[icao] ?? null;
}

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`route:ip:${clientIp(context)}`, LIMITS.routeResolve],
  ]);
  if (limited) return limited;

  const params = context.url.searchParams;
  const departure = (params.get("departure") ?? "").trim().toUpperCase();
  const arrival = (params.get("arrival") ?? "").trim().toUpperCase();
  const route = (params.get("route") ?? "").trim().slice(0, MAX_ROUTE);

  if (!ICAO.test(departure) || !ICAO.test(arrival)) {
    return json(400, { error: "invalidAirports" });
  }

  if (!navDataAvailable()) return json(503, { error: "navDataUnavailable" });

  const key = `${departure} ${arrival} ${route}`;
  const hit = cached.get(key);
  if (hit) return json(200, { data: { points: hit } });

  const points = resolveRoute({
    departure,
    arrival,
    route,
    departureAt: airportAt(departure),
    arrivalAt: airportAt(arrival),
  });

  // Oldest first in insertion order, so the first key is the one to drop.
  if (cached.size >= CACHE_LIMIT) {
    cached.delete(cached.keys().next().value as string);
  }
  cached.set(key, points);

  return json(200, { data: { points } });
};
