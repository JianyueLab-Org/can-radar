/**
 * Facility codes as they appear on the radar and in map popups, keyed by the
 * `facility` field of the live data feed.
 *
 * The community reads these as abbreviations, and they sit inline next to a
 * callsign and frequency where a spelled-out "Clearance Delivery" wraps.
 * Indices match `facilityMap` in `src/pages/api/v1/pilot/[id].ts` — 7 is
 * ATIS, and used to be mislabelled here as FSS.
 */
const facilities: Record<number, string> = {
  0: "OBS",
  1: "FSS",
  2: "DEL",
  3: "GND",
  4: "TWR",
  5: "APP",
  6: "CTR",
  7: "ATIS",
};

export function getFacilityName(facility: number): string {
  return facilities[facility] || "Unknown";
}
