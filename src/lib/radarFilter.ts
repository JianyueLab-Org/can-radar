/**
 * 交通筛选。
 *
 * **筛选的结果必须同时作用到列表和地图上**，这是它和原来那个搜索框最大的区别。
 * 原来那个只过滤侧栏，地图照旧画全部 —— 于是「只看 ZSPD 进港」筛出三行，地图上
 * 仍然是两百架，人得在两个不一致的画面之间自己对照。
 *
 * 纯函数放在这里而不是组件里，是为了它能被测：判据里每一条都有一个「空值算什
 * 么」的问题（没填计划的飞机算不算 ZSPD 出港？地面算不算 0 高度？），而这些答案
 * 靠读组件模板是看不出来的。
 */

import type { Pilot } from "@/lib/radarTypes";

/** 高度层。分界照航图上的习惯：地面、进近、中层、高空。 */
export type AltitudeBand = "any" | "ground" | "low" | "mid" | "high";

export interface TrafficFilter {
  /** 呼号、航司、机型、CID 的模糊匹配。 */
  text: string;
  altitude: AltitudeBand;
  /** 起飞机场 ICAO，空串表示不限。 */
  departure: string;
  arrival: string;
}

export const EMPTY_FILTER: TrafficFilter = {
  text: "",
  altitude: "any",
  departure: "",
  arrival: "",
};

/** 有没有任何一项在起作用 —— 界面据此决定要不要显示「已筛选」的提示。 */
export function isFiltering(filter: TrafficFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.altitude !== "any" ||
    filter.departure !== "" ||
    filter.arrival !== ""
  );
}

/**
 * 地面的判据是 `groundspeed`，不是高度。
 *
 * 高度判不了：机场本身可能在几千英尺上（ZLXY 在 1500 英尺），而海平面机场上空
 * 1000 英尺的飞机是在飞。速度是唯一一个到处都成立的判据，30 节是滑行和起飞之间
 * 那条线。
 */
const GROUND_SPEED_MAX = 30;

/** 高度层的边界，英尺。 */
const LOW_TOP = 10000;
const MID_TOP = 24000;

export function bandOf(pilot: Pilot): Exclude<AltitudeBand, "any"> {
  if ((pilot.groundspeed ?? 0) <= GROUND_SPEED_MAX) return "ground";
  const altitude = pilot.altitude ?? 0;
  if (altitude < LOW_TOP) return "low";
  if (altitude < MID_TOP) return "mid";
  return "high";
}

/**
 * 一架飞机过不过筛。
 *
 * 起降机场取自飞行计划，**没填计划的飞机在指定了机场时一律不通过**。这是有意
 * 的：「ZSPD 进港」问的是「哪些飞机要来浦东」，而一架没填计划的飞机我们并不知道
 * 它要去哪，把它算进来会让这个筛选变成「可能相关的」而不是答案。
 */
export function matchesFilter(pilot: Pilot, filter: TrafficFilter): boolean {
  if (filter.altitude !== "any" && bandOf(pilot) !== filter.altitude) {
    return false;
  }

  if (filter.departure && plan(pilot, "departure") !== filter.departure) {
    return false;
  }
  if (filter.arrival && plan(pilot, "arrival") !== filter.arrival) {
    return false;
  }

  const needle = filter.text.trim().toLowerCase();
  if (!needle) return true;

  // 机型和 CID 也参与匹配：管制员找「所有 A359」和「这个 CID 是谁」用的是同一个
  // 框，分成两个输入框只会让人猜该填哪个。
  return haystack(pilot).some((value) => value.includes(needle));
}

function haystack(pilot: Pilot): string[] {
  const values = [
    pilot.callsign,
    pilot.name,
    String(pilot.cid ?? ""),
    pilot.flight_plan?.aircraft,
    pilot.flight_plan?.departure,
    pilot.flight_plan?.arrival,
  ];
  return values.filter(Boolean).map((value) => String(value).toLowerCase());
}

function plan(pilot: Pilot, field: "departure" | "arrival"): string {
  return (pilot.flight_plan?.[field] ?? "").toUpperCase();
}

/**
 * 出现在筛选下拉里的机场：**当前真的有交通的那些**，按出现次数排。
 *
 * 不给一份全世界机场的列表，因为那样的下拉滚不到底，而这张网络同一时刻活跃的机
 * 场通常是个位数。次数排序让最热的那个排在最前，也就是多数时候要选的那个。
 */
export function activeAirports(
  pilots: Pilot[],
  field: "departure" | "arrival",
): { icao: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const pilot of pilots) {
    const icao = plan(pilot, field);
    if (!icao) continue;
    counts.set(icao, (counts.get(icao) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([icao, count]) => ({ icao, count }))
    .sort((a, b) => b.count - a.count || a.icao.localeCompare(b.icao));
}
