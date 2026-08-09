import type { APIContext } from "astro";

import { apiOrigin } from "@/server/config";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 飞过的航迹 —— 一个转发，不是数据源。
 *
 * 航迹存在 `flightPosition` 表里，那张表由 can-fsd 写入和清理，schema 归
 * can-api 所有。雷达拆出来的时候**只有这一件事**没有跟着搬：搬了就意味着这个
 * 站点要拿着数据库口令，而它是整个网络上最公开、最没有登录、被爬得最凶的一个
 * 页面。让最暴露的东西持有数据库凭据，是这次拆分最不该做的事。
 *
 * 上游从 can-web 换成了 can-api —— 路径一个字都没变，换的只是主机，这正是那次
 * 迁移刻意保住的性质。仍然在服务端问、浏览器那边仍然是同源的一次 fetch，所以
 * **不用给 can-api 开 CORS**：radar.airwaysn.org 不在它的 ALLOWED_ORIGINS 里，
 * 也不需要在。
 *
 * 两处限流不是重复：这一桶挡的是打到我们这儿的量，can-api 那边还有它自己的一
 * 桶挡我们。真正的天花板是那一个。
 */

const UPSTREAM = apiOrigin();

/** 只放行认识的查询参数，原样带过去。 */
const PASS_THROUGH = ["cid", "callsign", "limit"] as const;

export const GET = async (context: APIContext) => {
  const limited = enforce([[`track:ip:${clientIp(context)}`, LIMITS.track]]);
  if (limited) return limited;

  const incoming = context.url.searchParams;
  const params = new URLSearchParams();
  for (const key of PASS_THROUGH) {
    const value = incoming.get(key);
    if (value) params.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}/api/v1/track?${params}`, {
      headers: { Accept: "application/json" },
      // 上游卡住时不能把这个请求一起拖住 —— 地图上是一条画不出来的航迹，
      // 不是整张图打不开。
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return Response.json(
      { status: 502, error: "上游没有响应。" },
      { status: 502 },
    );
  }

  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
      // 航迹每几秒才多一个点，短缓存足够挡住「选着一架飞机不动」的重复查询。
      "Cache-Control": response.ok ? "public, max-age=10" : "no-store",
    },
  });
};
