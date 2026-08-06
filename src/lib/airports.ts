/**
 * The airport coordinate table, loaded once per page.
 *
 * `public/airports.json` is 468 KB of `{ "ZBAA": [lat, lon] }`, built from the
 * vendored VATSpy data (see data/vatspy/README.md). Two islands need it — the
 * map, to draw the leg to the destination, and the details panel, to say how
 * far that is — so the fetch and the parsed table are shared rather than
 * duplicated in each.
 *
 * Nothing loads it until something asks: a visitor who never selects a flight
 * never pays for it.
 */
import type { LatLon } from "@/lib/radar";

export type AirportTable = Record<string, LatLon>;

let airports: AirportTable | null = null;
let request: Promise<AirportTable> | null = null;

export async function loadAirports(): Promise<AirportTable> {
  if (airports) return airports;

  request ??= fetch("/airports.json")
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then((data: AirportTable) => {
      airports = data ?? {};
      return airports;
    });

  return request;
}

/** The table if it is already loaded, else null. */
export function loadedAirports(): AirportTable | null {
  return airports;
}

/** Coordinates for an ICAO, if the table is loaded and knows it. */
export function airportAt(icao: string | undefined | null): LatLon | null {
  if (!icao) return null;
  return airports?.[icao.trim().toUpperCase()] ?? null;
}
