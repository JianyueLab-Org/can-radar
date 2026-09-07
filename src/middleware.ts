import { defineMiddleware } from "astro:middleware";

/**
 * 每一个响应上的三个安全头。
 *
 * 四个兄弟站（can-dev、can-efb、can-controller、can-portal）都有这一份，这个站
 * 从前**一个都没有** —— 它连 `src/middleware.ts` 都没有，所以差的不是某一条头，
 * 是整层。
 *
 * 这里没有会话解析、也没有 `PROTECTED_PREFIXES`：雷达是全网最公开、最不需要登
 * 录的一页，它一条受保护的路径都没有。这个文件存在的唯一理由就是下面那三行。
 *
 * ## 三条头各自挡什么
 *
 * - `X-Frame-Options: DENY` —— 别人不能把这一页嵌进自己的框里冒充成自己的雷达。
 *   这个站正因为公开、可分享，才最容易被这么用。
 * - `X-Content-Type-Options: nosniff` —— 本站的 `/api/v1/*` 转发的是上游的字
 *   节（METAR 是 text/plain），浏览器不该替它猜类型。
 * - `Referrer-Policy` —— 分享出去的地址带着 `?sel=`（选中的呼号）和视图参数。
 *   跨源请求（底图瓦片就是别的源）默认会把完整地址连查询串一起放进 `Referer`；
 *   `origin-when-cross-origin` 跨源时只送 origin，同源不受影响。
 */

/**
 * 用函数包一层，而不是在 `next()` 之后就地设置。
 *
 * 兄弟站的注释都写了同一句话：将来这里一旦出现提前返回的分支（重定向、维护页、
 * 健康检查），就地写法会让它成为唯一一个什么头都没有的响应，而那正是最容易被
 * 漏看的一个。can-web 被这一条咬过。
 */
function withSecurityHeaders(response: Response): Response {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "origin-when-cross-origin");
  return response;
}

export const onRequest = defineMiddleware(async (_context, next) => {
  return withSecurityHeaders(await next());
});
