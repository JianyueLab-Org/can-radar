/**
 * 预约管制 —— 这一页只读它。
 *
 * 数据在 can-api 的 `atcReservation` 表里，写它的地方是 can-controller
 * （`/reservations`）。这个站点一如既往地不碰数据库，也不碰那张表的写入路径：
 * 下面这个 fetch 打的是本站的 `/api/v1/atc/reservations`，而那条路由是一个把
 * 会话 cookie 原样转给 can-api 的转发（见 `src/pages/api/v1/atc/reservations.ts`）。
 *
 * **它要登录。** 上游那条路由挂在 `WithPilot` 后面 —— 预约板上有成员用户名和
 * 备注，那是网络内部的东西，而这一页是全网最公开的一张。所以卡片只对认得出来
 * 的人渲染（见 Radar.vue 里那个 `v-if="signedIn"`），匿名访问一次上游都不打。
 */

/** 上游一行预约的形状，字段名照抄 can-api 的 `handleReservationBoard`。 */
export interface Reservation {
  id: number;
  username: string;
  callsign: string;
  description: string | null;
  /** RFC3339，UTC。 */
  startsAt: string;
  endsAt: string;
  /** 这一条是不是看板子的人自己的。上游按会话判的，不是这边比出来的。 */
  mine: boolean;
}

/**
 * 呼号后缀 → 席位号。
 *
 * 预约表里存的是**呼号**，不是席位号 —— 一条预约是一句「我打算开这个席位」，
 * 那时候还没有任何一个 FSD 连接可以问 facility。所以这里从后缀读回来，用的是
 * 网络自己的那套代号（can-web 的 `FACILITY_CODES`，也就是开席时拼呼号用的那
 * 张表），好让卡片上的色块和地图上、名单上的是同一批颜色。
 *
 * `_DEP` 归到进近：它在 FACILITY_CODES 里没有位置（开席只开 APP），但预约是
 * 人手填的呼号，而离场席位在真实使用里确实叫 `_DEP`。
 */
const SUFFIX_FACILITY: Record<string, number> = {
  OBS: 0,
  FSS: 1,
  DEL: 2,
  GND: 3,
  TWR: 4,
  APP: 5,
  DEP: 5,
  CTR: 6,
  ATIS: 7,
};

/**
 * 一条预约的席位号。认不出来的后缀当观察员（灰色）—— 呼号是人手填的，卡片上
 * 一格灰色胜过一格骗人的颜色。
 */
export function reservationFacility(callsign: string): number {
  const parts = callsign.toUpperCase().split("_");
  return SUFFIX_FACILITY[parts[parts.length - 1] ?? ""] ?? 0;
}

/** 卡片真正渲染的那一行：原始数据加上几个算好的值。 */
export interface ReservationView {
  reservation: Reservation;
  facility: number;
  /** 已经开始、还没结束。 */
  live: boolean;
  /** 离开始还有多少分钟，已经开始的是负数。 */
  minutesToStart: number;
  /** 时间窗，拆成三段让组件自己拼 —— 日期只在跨过 UTC 今天时才出现。 */
  window: { date: string | null; start: string; end: string };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `14:00`，UTC。预约板上的时间一律是 Zulu，和飞行计划、ATIS 保持一套。 */
function zuluTime(date: Date): string {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `08-22`，UTC。 */
function zuluDate(date: Date): string {
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * 把上游那一份整理成卡片要显示的样子，顺手把**已经结束的**扔掉。
 *
 * 上游查询里就带着 `endsAt > now`，所以列表回来的时候没有过期的；但这张卡五分
 * 钟才重取一次，中间会有槽位走到头。不在这里滤掉的话，卡片会把一条已经结束的
 * 预约挂着显示到下一次刷新。
 *
 * 排序不动 —— 上游按 `startsAt ASC` 给的，正在进行的那几条自然排在最前面。
 */
export function reservationViews(
  list: Reservation[],
  now: number,
): ReservationView[] {
  const today = new Date(now);
  const views: ReservationView[] = [];

  for (const reservation of list) {
    const start = new Date(reservation.startsAt);
    const end = new Date(reservation.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end.getTime() <= now) continue;

    views.push({
      reservation,
      facility: reservationFacility(reservation.callsign),
      live: start.getTime() <= now,
      minutesToStart: Math.round((start.getTime() - now) / 60000),
      window: {
        date: sameUtcDay(start, today) ? null : zuluDate(start),
        start: zuluTime(start),
        end: zuluTime(end),
      },
    });
  }

  return views;
}

function toReservation(raw: unknown): Reservation | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const callsign = typeof row.callsign === "string" ? row.callsign : "";
  const startsAt = typeof row.startsAt === "string" ? row.startsAt : "";
  const endsAt = typeof row.endsAt === "string" ? row.endsAt : "";
  if (!callsign || !startsAt || !endsAt) return null;

  return {
    id: typeof row.id === "number" ? row.id : 0,
    username: typeof row.username === "string" ? row.username : "",
    callsign: callsign.toUpperCase(),
    description:
      typeof row.description === "string" && row.description.trim()
        ? row.description.trim()
        : null,
    startsAt,
    endsAt,
    mine: row.mine === true,
  };
}

/**
 * 取一次预约板。
 *
 * **失败回 `null`，空板回 `[]`** —— 两者在卡片上写的不是同一句话。合成一个空
 * 数组的话，上游挂了会显示成「目前没有预约」，而那是这张卡最不该说错的一句：
 * 有人照着它决定今晚要不要上线。
 *
 * 信封两种都认，理由和 `fetchMetar` 那处一样：认错的表现是永远说「取不到」，
 * 看着像上游挂了。
 */
export async function fetchReservations(
  signal?: AbortSignal,
): Promise<Reservation[] | null> {
  let response: Response;
  try {
    response = await fetch("/api/v1/atc/reservations", {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const envelope = (body ?? {}) as {
    reservations?: unknown;
    data?: { reservations?: unknown };
  };
  const list = envelope.data?.reservations ?? envelope.reservations;
  if (!Array.isArray(list)) return null;

  return list
    .map(toReservation)
    .filter((row): row is Reservation => row !== null);
}
