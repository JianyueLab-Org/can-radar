import type { APIContext } from "astro";

import { apiOrigin } from "@/server/config";
import { isPublicRoute, publicProxyCache } from "@/server/publicProxyCache";
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

/** 只放行认识的查询参数，并按 can-api 的解析规则构造规范键。 */
const MAX_ROUTE_LENGTH = 1500;

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`route:ip:${clientIp(context)}`, LIMITS.routeResolve],
  ]);
  if (limited) return limited;

  const incoming = context.url.searchParams;
  const departure = incoming.get("departure")?.trim().toUpperCase() ?? "";
  const arrival = incoming.get("arrival")?.trim().toUpperCase() ?? "";
  const routeValue = incoming.get("route")?.trim() ?? "";
  const route = routeValue.slice(0, MAX_ROUTE_LENGTH);
  const params = new URLSearchParams();
  if (departure) params.set("departure", departure);
  if (arrival) params.set("arrival", arrival);
  if (route) params.set("route", route);

  return publicProxyCache.fetch(`${UPSTREAM}/api/v1/route?${params}`, {
    ttlSeconds: 30,
    timeoutMs: 10000,
    validate: isPublicRoute,
  });
};
