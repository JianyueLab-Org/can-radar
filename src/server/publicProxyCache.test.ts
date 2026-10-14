import type { APIContext } from "astro";
import { afterEach, describe, expect, test } from "bun:test";

import { GET as metar } from "../pages/api/v1/metar";
import { GET as route } from "../pages/api/v1/route";
import {
  isPublicMetar,
  isPublicRoute,
  PublicProxyCache,
} from "./publicProxyCache";
import { clear, LIMITS, record } from "./rateLimit";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalTimeout = AbortSignal.timeout;
const METAR = { icao: "ZBAA", metar: "ZBAA 110000Z 00000KT CAVOK" };
const ROUTE = {
  status: 200,
  data: {
    points: [{ ident: "ZBAA", lat: 40, lon: 116, kind: "airport" }],
  },
  timestamp: "2026-10-11T00:00:00Z",
};
const options = {
  ttlSeconds: 30,
  timeoutMs: 10000,
  validate: isPublicRoute,
};
let calls: Array<{ url: string; init: RequestInit }> = [];
let sequence = 0;

function stub(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  calls = [];
  globalThis.fetch = (async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
}

function context(path: string, ip = "203.0.113.31"): APIContext {
  const url = new URL(`https://radar.example.test${path}`);
  return {
    url,
    request: new Request(url, {
      headers: {
        Cookie: "can_session=synthetic-cookie",
        Authorization: "Bearer synthetic-token",
      },
    }),
    clientAddress: ip,
  } as APIContext;
}

function freshIcao(): string {
  return `T${String(++sequence).padStart(3, "0")}`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  AbortSignal.timeout = originalTimeout;
  clear("metar:ip:203.0.113.31");
  clear("route:ip:203.0.113.31");
});

describe("public proxy cache", () => {
  test("returns independent response bodies and headers from one fetch", async () => {
    const cache = new PublicProxyCache();
    const body = `  ${JSON.stringify(ROUTE)}\n`;
    stub(
      () =>
        new Response(body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }),
    );
    const first = await cache.fetch("https://api.test/route", options);
    first.headers.set("Content-Type", "changed");
    expect(await first.text()).toBe(body);
    const second = await cache.fetch("https://api.test/route", options);
    expect(second).not.toBe(first);
    expect(await second.text()).toBe(body);
    expect(second.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(calls).toHaveLength(1);
  });

  test("coalesces simultaneous identical keys but not other keys", async () => {
    const cache = new PublicProxyCache();
    const { promise, resolve } = Promise.withResolvers<void>();
    stub(async () => {
      await promise;
      return Response.json(ROUTE);
    });
    const first = cache.fetch("https://api.test/route?a=1", options);
    const second = cache.fetch("https://api.test/route?a=1", options);
    const third = cache.fetch("https://api.test/route?a=2", options);
    expect(calls).toHaveLength(2);
    resolve();
    const responses = await Promise.all([first, second, third]);
    expect(responses[0]).not.toBe(responses[1]);
    for (const response of responses)
      expect(await response.json()).toEqual(ROUTE);
  });

  test("TTL starts after body completion and expires exactly at its boundary", async () => {
    let now = 0;
    const cache = new PublicProxyCache({}, () => now);
    const { promise, resolve } = Promise.withResolvers<void>();
    stub(async () => {
      await promise;
      return Response.json(ROUTE);
    });
    const pending = cache.fetch("https://api.test/route", options);
    now = 5000;
    resolve();
    await pending;
    now = 34999;
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(1);
    now = 35000;
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(2);
  });

  test("TTL waits for the full response body, not just response headers", async () => {
    let now = 0;
    const cache = new PublicProxyCache({}, () => now);
    let stream: ReadableStreamDefaultController<Uint8Array>;
    stub(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const pending = cache.fetch("https://api.test/route", options);
    now = 9000;
    stream!.enqueue(new TextEncoder().encode(JSON.stringify(ROUTE)));
    stream!.close();
    await pending;
    now = 38999;
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(1);
  });

  test("includes upstream origin and endpoint in the key", async () => {
    const cache = new PublicProxyCache();
    stub(() => Response.json(ROUTE));
    for (const url of [
      "https://one.test/route?a=1",
      "https://two.test/route?a=1",
      "https://one.test/other?a=1",
    ])
      await cache.fetch(url, options);
    expect(calls).toHaveLength(3);
  });

  test("evicts least-recently-used entries at the entry bound", async () => {
    const cache = new PublicProxyCache({ maxEntries: 2 });
    stub(() => Response.json(ROUTE));
    for (const key of ["a", "b", "a", "c", "a", "b"])
      await cache.fetch(`https://api.test/${key}`, options);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.test/a",
      "https://api.test/b",
      "https://api.test/c",
      "https://api.test/b",
    ]);
  });

  test("evicts expired entries before live entries", async () => {
    let now = 0;
    const cache = new PublicProxyCache({ maxEntries: 2 }, () => now);
    stub(() => Response.json(ROUTE));
    await cache.fetch("https://api.test/expired", {
      ...options,
      ttlSeconds: 1,
    });
    await cache.fetch("https://api.test/live", options);
    await cache.fetch("https://api.test/expired", {
      ...options,
      ttlSeconds: 1,
    });
    now = 1000;
    await cache.fetch("https://api.test/new", options);
    await cache.fetch("https://api.test/live", options);
    expect(calls).toHaveLength(3);
  });

  test("bounds total stored bytes and counts UTF-8 body bytes", async () => {
    const body = JSON.stringify({ ...ROUTE, timestamp: "天气" });
    const bytes = Buffer.byteLength(body);
    const cache = new PublicProxyCache({ maxBytes: bytes * 2 - 1 });
    stub(
      () =>
        new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    for (const key of ["a", "b", "b", "a"])
      await cache.fetch(`https://api.test/${key}`, options);
    expect(calls).toHaveLength(3);
  });

  test("does not admit bodies above per-body or total-byte bounds", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(ROUTE));
    for (const limits of [
      { maxBodyBytes: bytes - 1 },
      { maxBytes: bytes - 1 },
      { maxEntries: 0 },
    ]) {
      const cache = new PublicProxyCache(limits);
      stub(() => Response.json(ROUTE));
      await cache.fetch("https://api.test/route", options);
      await cache.fetch("https://api.test/route", options);
      expect(calls).toHaveLength(2);
    }
  });

  test("oversized UTF-8 keys still coalesce and obey the in-flight bound", async () => {
    const url = "https://api.test/天气";
    const cache = new PublicProxyCache({
      maxKeyBytes: Buffer.byteLength(url) - 1,
      maxInFlight: 1,
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    stub(async () => {
      await promise;
      return Response.json(ROUTE);
    });
    const first = cache.fetch(url, options);
    const second = cache.fetch(url, options);
    expect(calls).toHaveLength(1);
    resolve();
    await Promise.all([first, second]);
    await cache.fetch(url, options);
    expect(calls).toHaveLength(2);
  });

  test("bounds actual upstream requests and releases capacity", async () => {
    const cache = new PublicProxyCache({ maxInFlight: 1 });
    const { promise, resolve } = Promise.withResolvers<void>();
    stub(async () => {
      await promise;
      return Response.json(ROUTE);
    });
    const first = cache.fetch("https://api.test/a", options);
    const joined = cache.fetch("https://api.test/a", options);
    const overflow = await cache.fetch("https://api.test/b", options);
    expect(calls).toHaveLength(1);
    expect(overflow.status).toBe(502);
    expect(await overflow.json()).toEqual({
      status: 502,
      error: "上游没有响应。",
    });
    resolve();
    await Promise.all([first, joined]);
    expect((await cache.fetch("https://api.test/b", options)).status).toBe(200);
    await cache.fetch("https://api.test/b", options);
    expect(calls).toHaveLength(2);
  });

  test("stops reading an oversized streamed body and returns the proxy failure", async () => {
    const cache = new PublicProxyCache({ maxBodyBytes: 8 });
    let pulls = 0;
    let cancelled = false;
    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode("12345678"));
              } else if (pulls === 2) {
                controller.enqueue(new TextEncoder().encode("9"));
              } else {
                controller.enqueue(new Uint8Array(1024));
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    const response = await cache.fetch("https://api.test/oversized", options);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: 502,
      error: "上游没有响应。",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  test.each([400, 401, 429, 500, 503])(
    "preserves and retries HTTP %i without caching",
    async (status) => {
      const cache = new PublicProxyCache();
      stub(
        () =>
          new Response("failure body", {
            status,
            headers: { "Content-Type": "text/plain", "Retry-After": "60" },
          }),
      );
      const first = await cache.fetch("https://api.test/route", options);
      expect(first.status).toBe(status);
      expect(await first.text()).toBe("failure body");
      expect(first.headers.get("Content-Type")).toBe("text/plain");
      expect(first.headers.get("Cache-Control")).toBe("no-store");
      expect(first.headers.get("Retry-After")).toBeNull();
      await cache.fetch("https://api.test/route", options);
      expect(calls).toHaveLength(2);
    },
  );

  test("clears failed shared fetches so a following request can succeed", async () => {
    const cache = new PublicProxyCache({ maxInFlight: 1 });
    const { promise, reject } = Promise.withResolvers<Response>();
    stub(() => (calls.length === 1 ? promise : Response.json(ROUTE)));
    const first = cache.fetch("https://api.test/route", options);
    const second = cache.fetch("https://api.test/route", options);
    reject(new TypeError("synthetic network failure"));
    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        status: 502,
        error: "上游没有响应。",
      });
      expect(response.headers.get("Cache-Control")).toBeNull();
    }
    expect((await cache.fetch("https://api.test/route", options)).status).toBe(
      200,
    );
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(2);
  });

  test("shares one timeout and retries after it", async () => {
    const cache = new PublicProxyCache({ maxInFlight: 1 });
    stub(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          ),
        ),
    );
    const [first, second] = await Promise.all([
      cache.fetch("https://api.test/route", { ...options, timeoutMs: 2 }),
      cache.fetch("https://api.test/route", { ...options, timeoutMs: 2 }),
    ]);
    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(calls).toHaveLength(1);
    const attempts = calls.length;
    stub(() => Response.json(ROUTE));
    expect((await cache.fetch("https://api.test/route", options)).status).toBe(
      200,
    );
    expect(attempts + calls.length).toBe(2);
  });

  test("clears body-read failures and releases singleflight capacity", async () => {
    const cache = new PublicProxyCache({ maxInFlight: 1 });
    stub(() =>
      calls.length === 1
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("synthetic body failure"));
              },
            }),
          )
        : Response.json(ROUTE),
    );
    const results = await Promise.allSettled([
      cache.fetch("https://api.test/route", options),
      cache.fetch("https://api.test/route", options),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await cache.fetch("https://api.test/route", options);
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(2);
  });

  test.each([
    "not JSON",
    "null",
    "[]",
    '{"status":200,"data":{"points":[{}]}}',
    '{"status":503,"data":{"points":[]}}',
  ])("forwards invalid success payload %s without retention", async (body) => {
    const cache = new PublicProxyCache();
    stub(
      () =>
        new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    expect(
      await (await cache.fetch("https://api.test/route", options)).text(),
    ).toBe(body);
    await cache.fetch("https://api.test/route", options);
    expect(calls).toHaveLength(2);
  });

  test.each([
    { "Set-Cookie": "session=synthetic" },
    { "WWW-Authenticate": "Bearer" },
    { Vary: "Accept, Cookie, Origin" },
    { Vary: "Authorization" },
    { Vary: "*" },
    { "Cache-Control": 'private="Cookie"' },
    { "Content-Type": "text/html" },
  ])(
    "rejects public caching after upstream cache-safety rejection %j",
    async (headers) => {
      const cache = new PublicProxyCache();
      stub(() => Response.json(ROUTE, { headers }));
      const first = await cache.fetch("https://api.test/route", options);
      expect(first.headers.get("Cache-Control")).toBe("no-store");
      await cache.fetch("https://api.test/route", options);
      expect(calls).toHaveLength(2);
    },
  );
});

describe("public payload validators", () => {
  test("METAR must match the station and have a string report; no report is valid", () => {
    expect(isPublicMetar(METAR, "ZBAA")).toBe(true);
    expect(isPublicMetar({ icao: "ZBAA", metar: "" }, "ZBAA")).toBe(true);
    for (const payload of [
      null,
      [],
      { icao: "ZSPD", metar: "" },
      { icao: "ZBAA", metar: null },
      { icao: "ZBAA" },
    ])
      expect(isPublicMetar(payload, "ZBAA")).toBe(false);
  });

  test("route points require the public envelope and finite coordinates", () => {
    expect(isPublicRoute(ROUTE)).toBe(true);
    expect(isPublicRoute({ status: 200, data: { points: [] } })).toBe(true);
    for (const point of [
      { ident: "X", lat: NaN, lon: 0, kind: "fix" },
      { ident: "X", lat: 91, lon: 0, kind: "fix" },
      { ident: "X", lat: 0, lon: 181, kind: "fix" },
      { ident: "X", lat: 0, lon: 0, kind: ["fix"] },
      { ident: "X", lat: 0, lon: 0, kind: "fix", via: 1 },
    ])
      expect(isPublicRoute({ status: 200, data: { points: [point] } })).toBe(
        false,
      );
  });
});

describe("METAR and route proxy integration", () => {
  test("METAR normalizes keys and ignores incoming credentials and extra parameters", async () => {
    const icao = freshIcao();
    stub(() => Response.json({ icao, metar: "" }));
    await metar(
      context(`/api/v1/metar?icao=%20${icao.toLowerCase()}%20&type=taf`),
    );
    const response = await metar(
      context(`/api/v1/metar?icao=${icao}&format=raw`),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith(`/api/v1/metar?icao=${icao}`);
    expect(calls[0].init.headers).toEqual({ Accept: "application/json" });
    expect(calls[0].init.credentials).toBe("omit");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  test("METAR rejects invalid ICAO without upstream or cache access", async () => {
    stub(() => Response.json(METAR));
    expect((await metar(context("/api/v1/metar?icao=INVALID"))).status).toBe(
      400,
    );
    expect(calls).toHaveLength(0);
  });

  test("route keys use the resolver's normalized input in fixed order only", async () => {
    const departure = freshIcao();
    const longRoute = `${"A".repeat(1500)}DISCARDED`;
    stub(() => Response.json(ROUTE));
    for (const path of [
      `/api/v1/route?route=%20Fix++DCT%20&arrival=%20zspd%20&departure=%20${departure.toLowerCase()}%20&ignored=1`,
      `/api/v1/route?departure=${departure}&arrival=ZSPD&route=Fix%20%20DCT&ignored=2`,
      `/api/v1/route?departure=${departure}&arrival=ZSPD&route=${longRoute}`,
      `/api/v1/route?departure=${departure}&arrival=ZSPD&route=${"A".repeat(1500)}`,
    ])
      await route(context(path));
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toEndWith(
      `/api/v1/route?departure=${departure}&arrival=ZSPD&route=Fix++DCT`,
    );
    expect(calls[1].url).toEndWith(
      `/api/v1/route?departure=${departure}&arrival=ZSPD&route=${"A".repeat(1500)}`,
    );
    for (const query of [
      `departure=${departure}&arrival=ZSPD&route=FIX++DCT`,
      `departure=${departure}&arrival=ZSPD&route=Fix+DCT`,
      `departure=${departure}&arrival=ZGGG&route=Fix++DCT`,
      `departure=ZBAA&arrival=${departure}&route=Fix++DCT`,
      `departure=${departure}&route=Fix++DCT`,
    ])
      await route(context(`/api/v1/route?${query}`));
    expect(calls).toHaveLength(7);
    expect(calls[0].init.headers).toEqual({ Accept: "application/json" });
    expect(calls[0].init.credentials).toBe("omit");
  });

  test.each(["metar", "route"])(
    "%s cache hits still consume and enforce the local IP limit",
    async (endpoint) => {
      const icao = freshIcao();
      const path =
        endpoint === "metar"
          ? `/api/v1/metar?icao=${icao}`
          : `/api/v1/route?departure=${icao}&arrival=ZSPD`;
      const get = endpoint === "metar" ? metar : route;
      const rule = endpoint === "metar" ? LIMITS.metar : LIMITS.routeResolve;
      stub(() =>
        Response.json(endpoint === "metar" ? { icao, metar: "" } : ROUTE),
      );
      for (let index = 0; index < rule.limit; index++)
        expect((await get(context(path))).status).toBe(200);
      const blocked = await get(context(path));
      expect(blocked.status).toBe(429);
      expect(blocked.headers.has("Retry-After")).toBe(true);
      expect(calls).toHaveLength(1);
    },
  );

  test("rate guard precedes invalid METAR validation", async () => {
    for (let index = 0; index < LIMITS.metar.limit; index++)
      record("metar:ip:203.0.113.31", LIMITS.metar);
    stub(() => Response.json(METAR));
    expect((await metar(context("/api/v1/metar?icao=INVALID"))).status).toBe(
      429,
    );
    expect(calls).toHaveLength(0);
  });

  test.each(["metar", "route"])(
    "%s rate guard rejects callers before they can join pending work",
    async (endpoint) => {
      const icao = freshIcao();
      const path =
        endpoint === "metar"
          ? `/api/v1/metar?icao=${icao}`
          : `/api/v1/route?departure=${icao}&arrival=ZSPD`;
      const get = endpoint === "metar" ? metar : route;
      const rule = endpoint === "metar" ? LIMITS.metar : LIMITS.routeResolve;
      for (let index = 0; index < rule.limit - 1; index++) {
        record(`${endpoint}:ip:203.0.113.31`, rule);
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      stub(async () => {
        await promise;
        return Response.json(
          endpoint === "metar" ? { icao, metar: "" } : ROUTE,
        );
      });
      const pending = get(context(path));
      expect(calls).toHaveLength(1);
      expect((await get(context(path))).status).toBe(429);
      expect(calls).toHaveLength(1);
      resolve();
      expect((await pending).status).toBe(200);
    },
  );

  test.each([
    ["metar", 300],
    ["route", 30],
  ] as const)("%s uses its approved %i second TTL", async (endpoint, ttl) => {
    let now = originalNow();
    Date.now = () => now;
    const icao = freshIcao();
    const path =
      endpoint === "metar"
        ? `/api/v1/metar?icao=${icao}`
        : `/api/v1/route?departure=${icao}&arrival=ZSPD`;
    const get = endpoint === "metar" ? metar : route;
    stub(() =>
      Response.json(endpoint === "metar" ? { icao, metar: "" } : ROUTE),
    );
    await get(context(path));
    now += ttl * 1000 - 1;
    await get(context(path));
    expect(calls).toHaveLength(1);
    now++;
    await get(context(path));
    expect(calls).toHaveLength(2);
  });

  test("keeps METAR and route upstream timeouts at 8 and 10 seconds", async () => {
    const timeouts: number[] = [];
    AbortSignal.timeout = (duration) => {
      timeouts.push(duration);
      return originalTimeout(duration);
    };
    const icao = freshIcao();
    stub((url) =>
      Response.json(url.includes("/metar?") ? { icao, metar: "" } : ROUTE),
    );
    await metar(context(`/api/v1/metar?icao=${icao}`));
    await route(context(`/api/v1/route?departure=${icao}&arrival=ZSPD`));
    expect(timeouts).toEqual([8000, 10000]);
  });
});
