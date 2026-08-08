import type { APIContext } from "astro";

import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 机场天气 —— 和航迹一样，一个转发，不是数据源。
 *
 * can-api 那条已经是 `Access-Control-Allow-Origin: *`，浏览器其实能直连。仍然走
 * 转发有三个理由，按重要性排：
 *
 * 1. **同源。** 浏览器只和本站说话，配置里只有一个上游地址（CAN_API_ORIGIN），
 *    而不是在前端包里再写死一个域名。
 * 2. **本站自己的限流桶。** 直连的话这张全网最公开的页面就绕过了我们的门，只剩
 *    can-api 那一道。
 * 3. **缓存。** can-api 回的是 `no-store`，所以每点一次机场都会真的去问上游的天
 *    气源。METAR 半小时才换一次，这里放五分钟的缓存，绝大多数点击就落在缓存上。
 */

const UPSTREAM = (
  process.env.CAN_API_ORIGIN || "https://api.airwaysn.org"
).replace(/\/+$/, "");

/** 四位字母数字。上游也会校验，这里先挡一道是为了不把垃圾转发出去。 */
const ICAO = /^[A-Za-z0-9]{4}$/;

/** 半小时一换的东西，五分钟的缓存不会让人看到过期的天气。 */
const CACHE_SECONDS = 300;

export const GET = async (context: APIContext) => {
  const limited = enforce([[`metar:ip:${clientIp(context)}`, LIMITS.metar]]);
  if (limited) return limited;

  const icao = (context.url.searchParams.get("icao") || "")
    .trim()
    .toUpperCase();
  if (!ICAO.test(icao)) {
    return Response.json(
      { status: 400, error: "提供一个四位的 ICAO 代码。" },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}/api/v1/metar?icao=${icao}`, {
      headers: { Accept: "application/json" },
      // 上游卡住时不能把这个请求一起拖住 —— 机场面板上是一行取不到的天气，
      // 不是整个面板打不开。
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
      "Cache-Control": response.ok
        ? `public, max-age=${CACHE_SECONDS}`
        : "no-store",
    },
  });
};
