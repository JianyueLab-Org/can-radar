import type { APIContext } from "astro";

import type { Member } from "@/lib/member";
import { SESSION_COOKIE, apiOrigin } from "./config";

/**
 * 雷达站现在知道你是谁了 —— 但它没有因此长出一套登录。
 *
 * 会话 cookie（`can_session`）是 can-api 签的，Domain 是**父域**
 * `.ceruleanavi.net`（见 can-api 的 `internal/session/session.go` 和
 * `deploy/k8s.yaml` 里的 `COOKIE_DOMAIN`）。radar.ceruleanavi.net 是那个域下面的
 * 一台主机，所以浏览器**本来就**把这枚 cookie 带到这里来了 —— 一直如此，只是
 * 以前没人读。这个文件做的全部事情就是把它读出来，问一次「这是谁」。
 *
 * 于是这个站点仍然：没有密码表单、没有数据库口令、没有自己的会话格式、也没有
 * 第二条凭据路径。**登录入口只有一个，在主站**；这里只是认得出已经登录的人。
 *
 * ## 为什么不自己验签
 *
 * 令牌是 HMAC-SHA256 签的，验签只要那把密钥 —— 而那正是不能做的事：把
 * `SESSION_SECRET` 放进全网最公开的这个部署里，等于让「能签发任何人的会话」的
 * 能力多了一处存放点，而省下的只是一次内网 HTTP。拿 cookie 去问 can-api，这个
 * 站点就永远只是一个**读者**，泄露了也伪造不出任何东西。
 *
 * ## 没有 cookie 就不问
 *
 * 这一页是全网被爬得最凶的页面，绝大多数请求根本不带 cookie。带 cookie 才问，
 * 意味着匿名流量一次上游都不打 —— 否则每一个爬虫都会变成 can-api 的一次数据库
 * 读。
 *
 * ## 问不到就当没登录
 *
 * can-api 挂了、超时了、答了个 500 —— 一律当作未登录，而不是抛。地图是这一页
 * 的主体，它不需要会话也能看；为了页眉上那一格文字让整张图打不开，是本末倒置。
 */

/**
 * 上游最多等这么久。
 *
 * 比 /api/v1/track 的 8 秒短得多，因为这一次调用挡在**页面渲染**前面：它慢一
 * 秒，全站的首字节就慢一秒。会话读不到的代价只是页眉写着「登录」。
 */
const TIMEOUT_MS = 2500;

/**
 * 这次请求是谁发来的。没带会话、或者上游答不上来，都返回 null。
 */
export async function readMember(context: APIContext): Promise<Member | null> {
  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/api/v1/auth/session`, {
      headers: {
        Accept: "application/json",
        // 原样转发，不重新拼装：这枚 cookie 的值是签名的一部分，任何「整理」
        // 都会把它改坏。
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

  return toMember(body);
}

/**
 * can-api 的答复。
 *
 * 未登录时它答的是 `200 {"user": null}` 而不是 401 —— 那是它有意的选择（公开
 * 页面上「没登录」是常态，不是错误），所以这里也不能把非 200 当成唯一的失败。
 */
export function toMember(body: unknown): Member | null {
  if (!body || typeof body !== "object") return null;
  const user = (body as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;

  const raw = user as Record<string, unknown>;
  const username = typeof raw.username === "string" ? raw.username : "";
  if (!username) return null;

  return {
    username,
    name: typeof raw.name === "string" ? raw.name : "",
    rating: typeof raw.rating === "number" ? raw.rating : 0,
  };
}
