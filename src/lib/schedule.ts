/**
 * 网络的日程：活动、活动席位、以及管制预约。这一页只读它们。
 *
 * 三件东西放在一个模块里，是因为卡片上它们是同一个问题的两半 ——「等一下有谁开
 * 席」（预约卡）和「等一下有什么事」（活动卡），而**活动报名的席位两边都算**：
 * 它排在活动里，同时又是一条「某人某时段开某个席位」的承诺。时间窗的整形、
 * 「进行中」的判据、倒计时的刻度因此只该有一份。
 *
 * ## 两个数据源，两种可见性，别把它们的规矩弄混
 *
 * - **活动是公开的。** can-api 的 `GET /api/v1/activity/list` 和
 *   `GET /api/v1/activity/{id}` 都没有守卫 —— 一场活动是公告出去的东西。所以活动
 *   卡对匿名访客照常出现，本站那条转发也不带 cookie（见
 *   `src/server/activityBoard.ts`：不带 cookie 还有第二个好处，答复对所有人一
 *   样，于是可以缓存）。
 * - **管制预约要登录。** 上游那条挂在 `WithPilot` 后面，板子上有成员用户名和自
 *   由填写的备注。本站的转发没有 cookie 就答 401，一次上游都不打。
 *
 * 于是预约卡上两段的可见性是不一样的：活动席位那一段人人可见，个人预约那一段登
 * 录之后才出现。**这不是疏忽，是两个上游本来就不同的答案**，别为了「统一」把任
 * 何一边改成另一边。
 */

/* ------------------------------------------------------------------ *
 * 上游的形状
 * ------------------------------------------------------------------ */

/** 一条管制预约，字段名照抄 can-api 的 `handleReservationBoard`。 */
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

/** 一场活动，字段名照抄 can-api 的 `renderActivity` 加上列表那几个汇总。 */
export interface Activity {
  id: number;
  title: string;
  professional: boolean;
  startsAt: string;
  /** 可以是 null —— 这一列是后加的，而且不是每场活动都定了收尾时间。 */
  endsAt: string | null;
  status: number;
  airports: string[];
  positionCount: number;
  openPositionCount: number;
  registrationCount: number;
}

/** 一个**已经有人预约**的活动席位，连同它所属活动的时间窗。 */
export interface ActivitySeat {
  id: number;
  activityId: number;
  activityTitle: string;
  callsign: string;
  facility: number;
  username: string;
  startsAt: string;
  endsAt: string | null;
}

export interface ActivityBoard {
  activities: Activity[];
  seats: ActivitySeat[];
}

/**
 * 没有结束时间的活动，按这个长度算它还没结束。
 *
 * `endsAt` 可以是 null（列是后加的），而卡片得回答「这场还在不在」。拿开始时间当
 * 结束时间的话，一场刚开场的活动会在同一分钟里从卡片上消失。六小时是一个宁可多
 * 留一会儿的数：多留的代价是一行过期的信息，少留的代价是活动正在进行时卡片说没
 * 有活动。
 */
const OPEN_ENDED_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 时间窗
 * ------------------------------------------------------------------ */

/** 时间窗拆成三段，让组件自己拼 —— 日期只在跨过 UTC 今天时才出现。 */
export interface ScheduleWindow {
  date: string | null;
  start: string;
  /** null 表示这一场没有定收尾时间。 */
  end: string | null;
}

/**
 * 时间窗写成一行字。
 *
 * 在这里拼而不是在模板里 —— 三段值加上两个可选（日期、结束时间）在 Vue 模板里是
 * 一串 `<template v-if>`，而**模板里的空白是会渲染出来的**：没有日期时那一行会
 * 比有日期时多出一个前导空格，在一个 `nowrap` 加省略号的窄行里正好看得见。一个
 * 函数，两张卡共用，也就不会只修好其中一张。
 */
export function windowLabel(window: ScheduleWindow): string {
  const range = window.end
    ? `${window.start}–${window.end}Z`
    : `${window.start}Z`;
  return window.date ? `${window.date} ${range}` : range;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `14:00`，UTC。日程上的时间一律是 Zulu，和飞行计划、ATIS 保持一套。 */
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

/** 一段日程算出来的共同部分：还在不在、还有多久、时间窗怎么写。 */
interface Timing {
  live: boolean;
  minutesToStart: number;
  window: ScheduleWindow;
}

/**
 * 把一段 `startsAt`/`endsAt` 整形，**已经结束的返回 null**。
 *
 * 结束判据用的是「实际结束时间」：定了 `endsAt` 就用它，没定就用开始时间加
 * `OPEN_ENDED_MS`。返回 null 而不是一个带 `ended` 标志的对象，是因为调用方无一
 * 例外地要把它滤掉 —— 让它连一个可用的值都拿不到，就没有哪个调用方能忘记这件事。
 */
function timing(
  startsAt: string,
  endsAt: string | null,
  now: number,
): Timing | null {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;

  let end: Date | null = null;
  if (endsAt) {
    const parsed = new Date(endsAt);
    if (!Number.isNaN(parsed.getTime())) end = parsed;
  }

  const finish = end ? end.getTime() : start.getTime() + OPEN_ENDED_MS;
  if (finish <= now) return null;

  return {
    live: start.getTime() <= now,
    minutesToStart: Math.round((start.getTime() - now) / 60000),
    window: {
      date: sameUtcDay(start, new Date(now)) ? null : zuluDate(start),
      start: zuluTime(start),
      end: end ? zuluTime(end) : null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 活动卡看到的样子
 * ------------------------------------------------------------------ */

export interface ActivityView extends Timing {
  activity: Activity;
}

/**
 * 未来的活动，按开始时间从近到远。
 *
 * 上游给的是**全部**活动（`ORDER BY startsAt DESC`，历史场次都在里面），所以
 * 「未来」这件事要在这里做完 —— 服务端已经滤过一遍，这里再滤是因为卡片在两次取
 * 数之间会跨过某一场的结束时刻。
 */
export function activityViews(list: Activity[], now: number): ActivityView[] {
  const views: ActivityView[] = [];
  for (const activity of list) {
    const t = timing(activity.startsAt, activity.endsAt, now);
    if (t) views.push({ activity, ...t });
  }
  return views.sort(
    (a, b) => Date.parse(a.activity.startsAt) - Date.parse(b.activity.startsAt),
  );
}

/* ------------------------------------------------------------------ *
 * 预约卡看到的样子
 * ------------------------------------------------------------------ */

/**
 * 呼号后缀 → 席位号。
 *
 * 预约表里存的是**呼号**，不是席位号 —— 一条预约是一句「我打算开这个席位」，那
 * 时候还没有任何一个 FSD 连接可以问 facility。所以这里从后缀读回来，用的是网络自
 * 己的那套代号（can-web 的 `FACILITY_CODES`，也就是开席时拼呼号用的那张表），好
 * 让卡片上的色块和地图上、名单上的是同一批颜色。
 *
 * **活动席位不走这里** —— 它在数据库里就带着 `facility`，猜一遍反而可能猜错。
 *
 * `_DEP` 归到进近：它在 FACILITY_CODES 里没有位置（开席只开 APP），但预约是人手
 * 填的呼号，而离场席位在真实使用里确实叫 `_DEP`。
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
 * 一条预约的席位号。认不出来的后缀当观察员（灰色）—— 呼号是人手填的，卡片上一格
 * 灰色胜过一格骗人的颜色。
 */
export function reservationFacility(callsign: string): number {
  const parts = callsign.toUpperCase().split("_");
  return SUFFIX_FACILITY[parts[parts.length - 1] ?? ""] ?? 0;
}

/**
 * 「某人某时段开某个席位」—— 预约和活动席位在卡片上归一成这一种行。
 *
 * 归一是为了让「进行中」「还有多久」「点开地图上那个席位」这三件事各写一遍，而
 * 不是各写两遍。`kind` 留着，因为两段仍然分开显示，而且点开的去处不一样。
 */
export interface StaffingEntry {
  key: string;
  kind: "reservation" | "activity";
  callsign: string;
  facility: number;
  username: string;
  /** 预约是自由填写的备注，活动席位是那场活动的标题。 */
  note: string | null;
  /** 活动席位才有，用来链回主站那一场。 */
  activityId: number | null;
  startsAt: string;
  endsAt: string | null;
  mine: boolean;
}

export function reservationEntries(list: Reservation[]): StaffingEntry[] {
  return list.map((r) => ({
    key: `res:${r.id}`,
    kind: "reservation" as const,
    callsign: r.callsign,
    facility: reservationFacility(r.callsign),
    username: r.username,
    note: r.description,
    activityId: null,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    mine: r.mine,
  }));
}

/**
 * 活动席位的 `mine` 是**这边比出来的**，不像预约那样由上游判。
 *
 * 上游那条是公开的，它不知道在问的是谁，所以也就不可能替我们判。传进来的
 * `memberId` 是会话里的 `username`（也就是 CID），没登录时是 null，那时候一行都
 * 不会是自己的。
 */
export function seatEntries(
  seats: ActivitySeat[],
  memberId: string | null,
): StaffingEntry[] {
  return seats.map((s) => ({
    key: `seat:${s.id}`,
    kind: "activity" as const,
    callsign: s.callsign,
    facility: s.facility,
    username: s.username,
    note: s.activityTitle,
    activityId: s.activityId,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    mine: !!memberId && s.username === memberId,
  }));
}

export interface StaffingView extends Timing {
  entry: StaffingEntry;
}

/** 还没结束的那些，按开始时间从近到远。已经结束的在这里就没了。 */
export function staffingViews(
  entries: StaffingEntry[],
  now: number,
): StaffingView[] {
  const views: StaffingView[] = [];
  for (const entry of entries) {
    const t = timing(entry.startsAt, entry.endsAt, now);
    if (t) views.push({ entry, ...t });
  }
  return views.sort(
    (a, b) => Date.parse(a.entry.startsAt) - Date.parse(b.entry.startsAt),
  );
}

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

async function readJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
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
 * **失败回 `null`，空板回 `[]`** —— 两者在卡片上写的不是同一句话。合成一个空数组
 * 的话，上游挂了会显示成「目前没有预约」，而那是这张卡最不该说错的一句：有人照
 * 着它决定今晚要不要上线。
 *
 * 信封两种都认，理由和 `fetchMetar` 那处一样：认错的表现是永远说「取不到」，看着
 * 像上游挂了。
 */
export async function fetchReservations(
  signal?: AbortSignal,
): Promise<Reservation[] | null> {
  const body = await readJson("/api/v1/atc/reservations", signal);
  if (body === null) return null;

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

/**
 * 取一次活动板。
 *
 * 这一条打的是本站的 `/api/v1/activity/board`，而那条路由做的事比一个转发多 ——
 * 它替浏览器把「列表 + 每场活动的席位」那一圈扇出跑掉了，理由写在
 * `src/server/activityBoard.ts` 里。同样是失败回 `null`。
 */
export async function fetchActivityBoard(
  signal?: AbortSignal,
): Promise<ActivityBoard | null> {
  const body = await readJson("/api/v1/activity/board", signal);
  if (body === null) return null;

  const payload = (body ?? {}) as {
    activities?: unknown;
    seats?: unknown;
  };
  if (!Array.isArray(payload.activities) || !Array.isArray(payload.seats)) {
    return null;
  }

  return {
    activities: payload.activities as Activity[],
    seats: payload.seats as ActivitySeat[],
  };
}
