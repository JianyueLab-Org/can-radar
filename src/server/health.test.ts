import { describe, expect, test } from "bun:test";
import { createHealth, healthResponse } from "./health";

describe("health", () => {
  test("ok returns 200 no-store", async () => {
    const res = healthResponse(
      await createHealth({ "can-api": async () => {} })(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { "can-api": "ok" },
    });
  });

  test("failing check returns 503", async () => {
    const res = healthResponse(
      await createHealth({
        "can-api": async () => {
          throw new Error("HTTP 502");
        },
      })(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "fail",
      checks: { "can-api": "HTTP 502" },
    });
  });

  test("caches for 10 s and coalesces concurrent calls", async () => {
    let calls = 0;
    let t = 0;
    const h = createHealth(
      {
        "can-api": async () => {
          calls++;
        },
      },
      () => t,
    );
    await Promise.all([h(), h(), h()]);
    expect(calls).toBe(1);
    t = 9_999;
    await h();
    expect(calls).toBe(1);
    t = 10_000;
    await h();
    expect(calls).toBe(2);
  });
});
