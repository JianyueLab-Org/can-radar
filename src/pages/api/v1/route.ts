import type { APIContext } from "astro";

import { apiOrigin } from "@/server/config";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 一条填报航路解析成坐标 —— 一个转发，不是数据源。
 *
 * 导航数据搬进 can-api 了。这个站点原来自己读 `NAVDATA_DIR` 下那三个 gz、在解压
 * 后的正文上二分查找，那意味着**这个公开仓库的部署里躺着一份商业 AIRAC 派生数
 * 据**，而它是全网最公开、最没有登录、被爬得最凶的一个页面。和 `/api/v1/track`
 * 当初留在这边不搬是同一个判断，只是方向相反：那一件是「不要让最暴露的站点拿数
 * 据库口令」，这一件是「不要让它拿导航数据」。
 *
 * 路径一个字没变（`/api/v1/route`），换的只是谁在解析 —— can-atc 和地图那边都不
 * 用改。仍然在服务端问、浏览器那边仍然是同源的一次 fetch，所以**不用给 can-api
 * 开 CORS**。
 *
 * 上游 503 `navDataUnavailable` 会原样透过来，地图那边照旧退回直飞弧线 —— 那条
 * 降级路径从 can-web 时期就在，没有变。
 *
 * 两处限流不是重复：这一桶挡的是打到我们这儿的量，can-api 那边还有它自己的一桶
 * 挡我们。真正的天花板是那一个。
 */

const UPSTREAM = apiOrigin();

/** 只放行认识的查询参数，原样带过去。 */
const PASS_THROUGH = ["departure", "arrival", "route"] as const;

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`route:ip:${clientIp(context)}`, LIMITS.routeResolve],
  ]);
  if (limited) return limited;

  const incoming = context.url.searchParams;
  const params = new URLSearchParams();
  for (const key of PASS_THROUGH) {
    const value = incoming.get(key);
    if (value) params.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}/api/v1/route?${params}`, {
      headers: { Accept: "application/json" },
      // 上游卡住时不能把这个请求一起拖住 —— 地图上是一条画不出来的航路，
      // 不是整张图打不开。解析比查航迹重，超时给得宽一点。
      signal: AbortSignal.timeout(10000),
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
      // 同一条航路在一个 AIRAC 周期内不变，但航路串会跟着飞行计划改，改完要
      // 立刻看到新的线 —— 所以只缓存很短一段，够挡住「选着一架飞机不动」的重复
      // 查询就行。
      "Cache-Control": response.ok ? "public, max-age=30" : "no-store",
    },
  });
};
