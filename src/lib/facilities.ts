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

/**
 * 这个席位管的是一片空域，而不是一个机场。
 *
 * 地图拿它决定「画多边形还是画机场标牌」，机场卡拿它决定「这个人算不算在这个场
 * 上」—— 两处必须是同一条判据。以前不用共享：机场卡靠「呼号第一段等于机场
 * ICAO」自然把区调滤掉了（`ZSHA` 不是任何机场）。北美把这个巧合打破了 ——
 * `MEM_22_CTR` 的第一段 `MEM` 解析得出 `KMEM`，于是孟菲斯区调会冒充成一个坐在
 * 孟菲斯机场里的席位。
 *
 * **只对 `controllers` 那一份用。** 通播是从 datafeed 的 `atis` 数组来的，它的
 * facility 也可能是 7，拿这条去滤会把机场卡上的通播一起滤掉。
 */
export function ownsAirspace(facility: number): boolean {
  return facility === 1 || facility === 6 || facility === 7;
}
