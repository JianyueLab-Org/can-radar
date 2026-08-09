import type { APIContext } from "astro";

import { SESSION_COOKIE, apiOrigin } from "@/server/config";
import { crossOrigin, forbidden } from "@/server/guard";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 登出 —— 本站唯一的写操作，而且它写的也不是数据，是那枚 cookie 的墓碑。
 *
 * 登录在主站，登出为什么在这里？因为这一页正是那种「开在副屏上一整天」的页面。
 * 让人为了退出跳去主站，多数人会直接关掉标签页，而那不叫退出。跳转过去也做不
 * 到「退出后还留在这张图上」——can-web 的登录页只接受站内的回跳地址（那是它
 * 防开放重定向的护栏，不该为了这点便利去拆）。
 *
 * 它仍然不是一条凭据路径：这里既不认令牌也不签令牌，只是把请求带着 cookie 转
 * 给 can-api，再把它回的 `Set-Cookie` 原样传回浏览器。**清 cookie 的仍然是签
 * 发它的那个服务**，用的是它自己那份 Domain/Secure/SameSite —— 属性对不上的话
 * 浏览器会把过期的那枚和原来那枚一起留着，人看着退出了其实没有。
 *
 * cookie 的 Domain 是父域 `.airwaysn.org`，而这里是它下面的一台主机，所以由这
 * 个源把它清掉是浏览器允许的：登出在主站、雷达、开发者中心是同一次登出。
 */

const UPSTREAM = apiOrigin();

export const POST = async (context: APIContext) => {
  if (crossOrigin(context)) return forbidden();

  const limited = enforce([
    [`signout:ip:${clientIp(context)}`, LIMITS.signout],
  ]);
  if (limited) return limited;

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  // 本来就没有会话。can-api 的登出是无条件成功的（拿着坏令牌的人也必须能把它
  // 清掉），这里照同一个原则答 ok，只是省掉一次没有意义的上游调用。
  if (!token) return Response.json({ ok: true });

  let response: Response;
  try {
    response = await fetch(`${UPSTREAM}/api/v1/auth/signout`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return Response.json(
      { status: 502, error: "上游没有响应。" },
      { status: 502 },
    );
  }

  const headers = new Headers({
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store, private",
  });
  // `getSetCookie()` 而不是 `get("set-cookie")`：后者会把多条 Set-Cookie 用逗
  // 号拼成一条，而 cookie 的 Expires 里本来就有逗号，拼完没有人能再拆开。
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(await response.text(), {
    status: response.status,
    headers,
  });
};
