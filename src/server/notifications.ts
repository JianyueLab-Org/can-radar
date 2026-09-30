import type { APIContext } from "astro";

import { SESSION_COOKIE, apiOrigin } from "./config";
import { crossOrigin, forbidden } from "./guard";
import { LIMITS, clientIp, enforce } from "./rateLimit";

/**
 * 通知铃的转发：can-ui `NotificationBell` 同源调的五条，原样转给 can-api 的
 * `/api/v1/notifications…`。
 *
 * - 路径按 `ROUTES` 收紧，表外 404，方法不对 405。
 * - 写操作（`POST read-all`、`PATCH {member|broadcast}/{id}`）先查 Origin。
 * - **没有 `can_session` 就不问上游**，答 401 —— 和预约板同一条规矩：这一页
 *   绝大多数请求不带 cookie。
 * - 答复一律 no-store：每一条都因人而异。
 */

/** `rest` 是 `/api/v1/notifications` 之后的部分，不带前导斜杠。 */
const ROUTES: ReadonlyArray<{ test: RegExp; methods: readonly string[] }> = [
  { test: /^$/, methods: ["GET"] },
  { test: /^unread$/, methods: ["GET"] },
  { test: /^read-all$/, methods: ["POST"] },
  { test: /^(member|broadcast)\/[0-9]{1,20}$/, methods: ["PATCH"] },
];

export type NotificationMatch =
  | { ok: true; path: string }
  | { ok: false; status: 404 }
  | { ok: false; status: 405; allow: string };

export function matchNotificationRoute(
  rest: string | undefined,
  method: string,
): NotificationMatch {
  const tail = rest ?? "";
  const route = ROUTES.find((entry) => entry.test.test(tail));
  if (!route) return { ok: false, status: 404 };
  if (!route.methods.includes(method.toUpperCase())) {
    return { ok: false, status: 405, allow: route.methods.join(", ") };
  }
  return {
    ok: true,
    path: tail ? `/api/v1/notifications/${tail}` : "/api/v1/notifications",
  };
}

const TIMEOUT_MS = 8000;
/** `{"read":true}` 是最大的一次合法请求体。 */
const MAX_BODY_BYTES = 1024;
const NO_STORE = { "Cache-Control": "no-store, private" };

export async function handleNotifications(
  context: APIContext,
): Promise<Response> {
  const method = context.request.method.toUpperCase();
  const match = matchNotificationRoute(context.params.path, method);
  if (!match.ok) {
    if (match.status === 404) {
      return Response.json(
        { status: 404, error: "Not found." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json(
      { status: 405, error: "Method not allowed." },
      { status: 405, headers: { ...NO_STORE, Allow: match.allow } },
    );
  }

  if (method !== "GET" && crossOrigin(context)) return forbidden();

  const limited = enforce([
    [`notifications:ip:${clientIp(context)}`, LIMITS.notifications],
  ]);
  if (limited) return limited;

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return Response.json(
      { status: 401, error: "登录后可见。" },
      { status: 401, headers: NO_STORE },
    );
  }

  let body: string | undefined;
  if (method !== "GET") {
    const declared = Number(context.request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return Response.json(
        { status: 413, error: "请求体太大了。" },
        { status: 413, headers: NO_STORE },
      );
    }
    const text = await context.request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return Response.json(
        { status: 413, error: "请求体太大了。" },
        { status: 413, headers: NO_STORE },
      );
    }
    if (text) body = text;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    // 原样转发：那枚 cookie 的值是签名的一部分。
    Cookie: `${SESSION_COOKIE}=${token}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}${match.path}${context.url.search}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { status: 502, error: "上游没有响应。" },
      { status: 502, headers: NO_STORE },
    );
  }

  // 204 不能带响应体：`new Response("", { status: 204 })` 会抛。
  const text = response.status === 204 ? null : await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
      ...NO_STORE,
    },
  });
}
