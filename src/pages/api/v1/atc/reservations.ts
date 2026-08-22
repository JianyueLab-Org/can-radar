import type { APIContext } from "astro";

import { SESSION_COOKIE, apiOrigin } from "@/server/config";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 预约管制板 —— 和航迹、天气一样，一个转发，不是数据源。
 *
 * 路径和上游一个字都不差（can-api 的 `GET /api/v1/atc/reservations`），换的只
 * 是主机。这个站点仍然不碰 `atcReservation` 那张表，也仍然只读：这里只实现了
 * GET，写和撤销留在 can-controller —— 那是有登录、有表单、有确认对话框的地方，
 * 而这一页连一个密码框都不该有。
 *
 * ## 它要带着 cookie
 *
 * 上游那条挂在 `WithPilot` 后面。预约板上有成员用户名和自由填写的备注，那是网
 * 络内部的东西 —— 全网最公开的这一页把它匿名放出去，是替 can-api 做一个不属于
 * 这里的决定。所以 cookie 原样转过去，由**上游**判断这个人能不能看。
 *
 * 原样转发而不是重新拼装：那枚 cookie 的值是签名的一部分，任何「整理」都会把
 * 它改坏（`src/server/session.ts` 那处也是同一句话）。
 *
 * ## 没有 cookie 就不问上游
 *
 * 这一页绝大多数请求根本不带 cookie，而带 cookie 才问是这个站点的一条规矩：否
 * 则每个爬虫都会变成 can-api 的一次数据库读。答 401 而不是一个空数组 —— 「你
 * 没登录」和「今晚没有人预约」是两件事，合成一句会让卡片替上游说谎。
 *
 * ## 不能缓存
 *
 * 每一行都带着 `mine`，也就是这份答复因人而异。中间任何一层把它存下来，都等于
 * 把一个人的板子发给下一个访客。
 */

const UPSTREAM = apiOrigin();

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`reservations:ip:${clientIp(context)}`, LIMITS.reservations],
  ]);
  if (limited) return limited;

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return Response.json(
      { status: 401, error: "登录后可见。" },
      { status: 401, headers: { "Cache-Control": "no-store, private" } },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}/api/v1/atc/reservations`, {
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      // 上游卡住时不能把这个请求一起拖住 —— 卡片上是一行取不到的预约，不是整
      // 张图打不开。
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return Response.json(
      { status: 502, error: "上游没有响应。" },
      { status: 502, headers: { "Cache-Control": "no-store, private" } },
    );
  }

  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store, private",
    },
  });
};
