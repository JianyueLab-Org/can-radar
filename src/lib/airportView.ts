/**
 * 一个机场此刻的样子：进离场航班、在场席位、天气。
 *
 * 除了天气之外**全部从已有的 datafeed 推导**，不新增任何上游。这张图每 30 秒本
 * 来就要把整份数据取下来，从里面数出「谁要来 ZSPD」是遍历一次的事；为它单开一个
 * 接口只会多一个会失败、会不同步、会被爬的东西。
 *
 * 天气是唯一的例外，因为 datafeed 里没有 —— 它走 can-api 的 /api/v1/metar，那条
 * 是公开的（EuroScope 的 ATIS maker 就在用），所以这张不需要登录的页面调得动。
 */

import type { AtisData, Controller, Pilot } from "@/lib/radarTypes";

/** 一架和这个机场有关的飞机，以及它是来还是走。 */
export interface AirportFlight {
  pilot: Pilot;
  /** 地面上还是在飞 —— 决定列表里显示的是「在停机坪」还是高度。 */
  onGround: boolean;
}

export interface AirportSnapshot {
  icao: string;
  departures: AirportFlight[];
  arrivals: AirportFlight[];
  /** 在这个机场工作的席位，含通播。 */
  stations: (Controller | AtisData)[];
}

/** 和筛选器同一条判据，理由见 radarFilter.ts。 */
const GROUND_SPEED_MAX = 30;

/**
 * 席位属于哪个机场，从呼号的第一段读。
 *
 * `ZSPD_TWR` → `ZSPD`，`ZSPD_A_ATIS` → `ZSPD`。区调（`ZSHA_CTR`）读出来的是
 * FIR 代码而不是机场，但那正好 —— 它不会等于任何一个机场的 ICAO，于是自然不会
 * 出现在机场面板里，不需要额外排除。
 */
export function stationAirportCode(callsign: string): string {
  return (callsign.split("_")[0] ?? "").toUpperCase();
}

/**
 * 组一个机场的快照。
 *
 * 进离场是按**飞行计划**分的，不是按位置：一架停在浦东、计划飞往虹桥的飞机是浦
 * 东的离场，尽管它此刻就在浦东地面上。按位置分会让它同时算进两边，或者哪边都不
 * 算，取决于半径怎么定。
 *
 * 一架从 ZSPD 飞往 ZSPD 的飞机（本场训练）会同时出现在两个列表里，这是对的：塔
 * 台确实要在两边都看见它。
 */
export function airportSnapshot(
  icao: string,
  pilots: Pilot[],
  controllers: Controller[],
  atis: AtisData[],
): AirportSnapshot {
  const code = icao.toUpperCase();
  const departures: AirportFlight[] = [];
  const arrivals: AirportFlight[] = [];

  for (const pilot of pilots) {
    const plan = pilot.flight_plan;
    if (!plan) continue;
    const entry: AirportFlight = {
      pilot,
      onGround: (pilot.groundspeed ?? 0) <= GROUND_SPEED_MAX,
    };
    if ((plan.departure ?? "").toUpperCase() === code) departures.push(entry);
    if ((plan.arrival ?? "").toUpperCase() === code) arrivals.push(entry);
  }

  // 离场按还在地面的排在前 —— 那些是塔台马上要处理的；进场按距离近的排不了（这
  // 里没有距离），所以按高度低的排在前，效果一样：低的就是快到的。
  departures.sort(
    (a, b) =>
      Number(b.onGround) - Number(a.onGround) ||
      a.pilot.callsign.localeCompare(b.pilot.callsign),
  );
  arrivals.sort(
    (a, b) =>
      (a.pilot.altitude ?? 0) - (b.pilot.altitude ?? 0) ||
      a.pilot.callsign.localeCompare(b.pilot.callsign),
  );

  const stations = [...controllers, ...atis].filter(
    (station) => stationAirportCode(station.callsign) === code,
  );

  return { icao: code, departures, arrivals, stations };
}

/**
 * 取一份 METAR。
 *
 * 失败一律返回 null 而不是抛：天气取不到时机场面板的其余部分照常显示，那比整个
 * 面板打不开好得多 —— 而且天气源在墙内本来就时灵时不灵。
 */
export async function fetchMetar(
  icao: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
      { headers: { Accept: "application/json" }, signal },
    );
    if (!response.ok) return null;
    // 公开那条回的是 `{icao, metar}`，不是站内其余接口那个 `{status,data,…}`
    // 信封 —— 它是给 EuroScope 的 ATIS maker 用的，形状比我们早。两种都认，因为
    // 认错的表现是面板永远说「取不到天气」，而那看着像上游挂了。
    const body = (await response.json()) as {
      metar?: unknown;
      data?: { raw?: unknown };
    };
    const raw = typeof body?.metar === "string" ? body.metar : body?.data?.raw;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}
