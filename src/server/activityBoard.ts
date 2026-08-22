import { apiOrigin } from "./config";

/**
 * 活动板：一次扇出，一份缓存，给全站所有访客用。
 *
 * ## 为什么这里不是一个转发
 *
 * 别的 `/api/v1/*` 都是一条路由对一条上游。活动这件事对不上：can-api 的列表
 * （`/api/v1/activity/list`）只给出每场活动**有几个席位、还剩几个空**，谁预约了
 * 哪个席位要一场一场去问 `/api/v1/activity/{id}`。而预约卡上「活动报名的管制」
 * 那一段要的正是后者。
 *
 * 让浏览器自己扇出是不行的：那会让全网最公开的这一页每打开一次就发 1+N 个请求，
 * 而 N 是活动场次。所以扇出放在服务端，**浏览器只发一个请求**。
 *
 * ## 缓存和单飞
 *
 * 扇出在服务端就意味着每个访客都会引发一圈上游调用，那比让浏览器扇出更糟 ——
 * 所以这里有一份 60 秒的进程内缓存，外加一个 in-flight 合流：同一时刻涌进来的
 * 若干个请求共用**同一次**扇出，而不是各跑一圈。
 *
 * 进程内的 Map 而不是 Redis，理由和 `rateLimit.ts` 那处是同一条：这个应用是单
 * 进程的 standalone Node。将来真要多副本，每个副本各有一份缓存，上游负载按副本
 * 数翻倍 —— 那时候换掉的是这个文件，不是调用方。
 *
 * ## 不带 cookie
 *
 * 上游那两条都没有守卫（活动是公告出去的东西），但**带上会话会让答复因人而异**
 * ——can-api 给 SUP 多返回草稿。这一页要的是「已经公告的活动」，而且答复对所有人
 * 一样才能缓存、才能带 `public` 的 Cache-Control。所以这里不转发 cookie，草稿在
 * 雷达上永远不出现，这正是想要的。
 */

export interface BoardActivity {
  id: number;
  title: string;
  professional: boolean;
  startsAt: string;
  endsAt: string | null;
  status: number;
  airports: string[];
  positionCount: number;
  openPositionCount: number;
  registrationCount: number;
}

export interface BoardSeat {
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
  activities: BoardActivity[];
  seats: BoardSeat[];
}

const UPSTREAM = apiOrigin();

/** 缓存多久。活动是几天前排的，一分钟的陈旧没有任何人会察觉。 */
export const BOARD_TTL_SECONDS = 60;

/**
 * 一次最多问几场活动的席位。
 *
 * 扇出要有上限，否则上游哪天多出一百场排在未来的活动，这一页就替它自己做了一次
 * 压测。取 10 是因为这张网络同时排在未来的活动是个位数 —— 真的撞到上限时，多出
 * 来的那几场**仍然出现在活动卡上**，只是它们的席位不进预约卡，因为列表那一份数
 * 据是完整的、扇出的那一份才是被截断的。
 */
const MAX_FANOUT = 10;

/** 已取消。上游对匿名调用本来就不返回它，这里再挡一道是防它哪天改了。 */
const STATUS_CANCELLED = 3;

/** 没定结束时间的活动按这个长度算它还没结束（和 `lib/schedule.ts` 同一个数）。 */
const OPEN_ENDED_MS = 6 * 60 * 60 * 1000;

const TIMEOUT_MS = 8000;

let cache: { at: number; value: ActivityBoard } | null = null;
let inflight: Promise<ActivityBoard | null> | null = null;

async function readJson(path: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toActivity(raw: unknown): BoardActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const startsAt = str(row.startsAt);
  const title = str(row.title);
  if (!startsAt || !title) return null;

  return {
    id: num(row.id),
    title,
    professional: row.professional === true,
    startsAt,
    endsAt: str(row.endsAt) || null,
    status: num(row.status),
    airports: Array.isArray(row.airports) ? row.airports.map(str) : [],
    positionCount: num(row.positionCount),
    openPositionCount: num(row.openPositionCount),
    registrationCount: Array.isArray(row.registrations)
      ? row.registrations.length
      : 0,
  };
}

/** 还没结束的那些，按开始时间从近到远。 */
function upcoming(activities: BoardActivity[], now: number): BoardActivity[] {
  return activities
    .filter((a) => {
      if (a.status === STATUS_CANCELLED) return false;
      const start = Date.parse(a.startsAt);
      if (Number.isNaN(start)) return false;
      const end = a.endsAt ? Date.parse(a.endsAt) : NaN;
      const finish = Number.isNaN(end) ? start + OPEN_ENDED_MS : end;
      return finish > now;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * 一场活动里**已经有人预约**的席位。
 *
 * 空席不进来：预约卡回答的是「谁会开席」，一个没人认领的席位在那张卡上是一行没
 * 有主语的字。空席的数目仍然在活动卡上（`openPositionCount`），那里它才是信息。
 */
async function seatsOf(activity: BoardActivity): Promise<BoardSeat[]> {
  const body = await readJson(`/api/v1/activity/${activity.id}`);
  const positions = (body as { data?: { positions?: unknown } } | null)?.data
    ?.positions;
  if (!Array.isArray(positions)) return [];

  const out: BoardSeat[] = [];
  for (const raw of positions) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const username = str(row.username);
    const callsign = str(row.callsign);
    if (!username || !callsign) continue;

    out.push({
      id: num(row.id),
      activityId: activity.id,
      activityTitle: activity.title,
      callsign: callsign.toUpperCase(),
      facility: num(row.facility),
      username,
      startsAt: activity.startsAt,
      endsAt: activity.endsAt,
    });
  }
  return out;
}

async function build(now: number): Promise<ActivityBoard | null> {
  const body = await readJson("/api/v1/activity/list");
  const list = (body as { data?: { activities?: unknown } } | null)?.data
    ?.activities;
  // 列表取不到就整个失败：活动卡上「取不到」和「近期没有活动」不是同一句话。
  if (!Array.isArray(list)) return null;

  const activities = upcoming(
    list.map(toActivity).filter((a): a is BoardActivity => a !== null),
    now,
  );

  // 单场取不到就跳过它的席位，而不是让整块板子失败 —— 少一场的席位是一行缺失的
  // 信息，整块失败是一张打不开的卡。
  const seats = (
    await Promise.all(activities.slice(0, MAX_FANOUT).map(seatsOf))
  ).flat();

  return { activities, seats };
}

/**
 * 读活动板。取不到上游的列表时返回 null。
 *
 * `now` 是参数而不是在里面读，好让缓存的判定和活动的「还没结束」用同一个时刻。
 */
export async function readActivityBoard(
  now: number = Date.now(),
): Promise<ActivityBoard | null> {
  if (cache && now - cache.at < BOARD_TTL_SECONDS * 1000) return cache.value;
  if (inflight) return inflight;

  inflight = build(now)
    .then((board) => {
      // 失败不进缓存：下一个请求应该再试一次，而不是把一次超时钉在这儿 60 秒。
      if (board) cache = { at: now, value: board };
      return board;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
