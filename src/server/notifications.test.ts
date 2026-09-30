import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleNotifications, matchNotificationRoute } from "./notifications";

/**
 * 通知铃的转发：`/api/v1/notifications/[...path]` 的全部逻辑。
 * 不带 `can_session` 的请求答 401，不问上游。
 */

const ORIGIN = "https://radar.ceruleanavi.net";
const API = "https://api.test";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function stub(respond: () => Response): void {
  calls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    return respond();
  }) as typeof fetch;
}

function context(
  method: string,
  path: string | undefined,
  opts: {
    origin?: string;
    cookie?: string;
    body?: string;
    search?: string;
  } = {},
): APIContext {
  const url = new URL(
    `${ORIGIN}/api/v1/notifications${path ? `/${path}` : ""}${opts.search ?? ""}`,
  );
  const headers: Record<string, string> = {};
  if (opts.origin) headers.origin = opts.origin;
  if (opts.body) headers["content-type"] = "application/json";
  return {
    request: new Request(url, { method, headers, body: opts.body }),
    url,
    params: { path },
    cookies: {
      get: (name: string) =>
        name === "can_session" && opts.cookie
          ? { value: opts.cookie }
          : undefined,
    },
    clientAddress: "203.0.113.7",
  } as unknown as APIContext;
}

beforeEach(() => {
  process.env.CAN_API_ORIGIN = API;
  process.env.PUBLIC_ORIGIN = ORIGIN;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("matchNotificationRoute", () => {
  test("五条路径各自的方法", () => {
    const cases: Array<[string | undefined, string, string]> = [
      [undefined, "GET", "/api/v1/notifications"],
      ["", "GET", "/api/v1/notifications"],
      ["unread", "GET", "/api/v1/notifications/unread"],
      ["read-all", "POST", "/api/v1/notifications/read-all"],
      ["member/1", "PATCH", "/api/v1/notifications/member/1"],
      ["broadcast/42", "patch", "/api/v1/notifications/broadcast/42"],
    ];
    for (const [path, method, upstream] of cases) {
      expect(matchNotificationRoute(path, method)).toEqual({
        ok: true,
        path: upstream,
      });
    }
  });

  test.each([
    "member",
    "member/abc",
    "member/1/read",
    "other/1",
    "broadcast/123456789012345678901",
    "unread/x",
    "../atc/reservations",
  ])("%s 是 404", (path) => {
    expect(matchNotificationRoute(path, "GET")).toEqual({
      ok: false,
      status: 404,
    });
  });

  test("方法不对是 405，带 Allow", () => {
    expect(matchNotificationRoute("read-all", "GET")).toEqual({
      ok: false,
      status: 405,
      allow: "POST",
    });
  });
});

describe("handleNotifications", () => {
  test("没有 can_session：401，不问上游", async () => {
    stub(() => Response.json({ count: 1 }));
    const response = await handleNotifications(context("GET", "unread"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(calls).toEqual([]);
  });

  test("未读数：带 can_session 转发，no-store", async () => {
    stub(() => Response.json({ count: 3 }));
    const response = await handleNotifications(
      context("GET", "unread", { cookie: "tok" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 3 });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/api/v1/notifications/unread`,
    ]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Cookie).toBe("can_session=tok");
  });

  test("列表：查询串原样带过去", async () => {
    stub(() => Response.json({ items: [], next: null }));
    await handleNotifications(
      context("GET", undefined, {
        cookie: "tok",
        search: "?before=abc&limit=20",
      }),
    );
    expect(calls[0].url).toBe(
      `${API}/api/v1/notifications?before=abc&limit=20`,
    );
  });

  test("标记一条：body 过去，204 回来", async () => {
    stub(() => new Response(null, { status: 204 }));
    const response = await handleNotifications(
      context("PATCH", "member/7", {
        origin: ORIGIN,
        cookie: "tok",
        body: '{"read":true}',
      }),
    );
    expect(response.status).toBe(204);
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe('{"read":true}');
  });

  test("全部已读：没有 body 也转发", async () => {
    stub(() => new Response(null, { status: 204 }));
    const response = await handleNotifications(
      context("POST", "read-all", { origin: ORIGIN, cookie: "tok" }),
    );
    expect(response.status).toBe(204);
    expect(calls[0].init.body).toBeUndefined();
  });

  test("跨站写 403，不问上游", async () => {
    stub(() => new Response(null, { status: 204 }));
    const response = await handleNotifications(
      context("POST", "read-all", {
        origin: "https://evil.example",
        cookie: "tok",
      }),
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("表外 404、方法不对 405，都不问上游", async () => {
    stub(() => Response.json({}));
    expect(
      (
        await handleNotifications(
          context("PATCH", "member/abc", { cookie: "tok" }),
        )
      ).status,
    ).toBe(404);
    const wrong = await handleNotifications(
      context("GET", "member/1", { cookie: "tok" }),
    );
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("PATCH");
    expect(calls).toEqual([]);
  });

  test("上游不响应：502", async () => {
    calls = [];
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const response = await handleNotifications(
      context("GET", "unread", { cookie: "tok" }),
    );
    expect(response.status).toBe(502);
  });
});
