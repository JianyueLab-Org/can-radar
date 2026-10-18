import { describe, expect, test } from "bun:test";
import { pageTitle } from "@/lib/pageTitle";

describe("pageTitle", () => {
  test("首页只有站名", () => {
    expect(pageTitle(undefined, "zh-cn")).toBe("在线雷达");
    expect(pageTitle(undefined, "en-us")).toBe("Live Radar");
  });
  test("其余页面是 <页面> · <站名>", () => {
    expect(pageTitle("Page not found", "en-us")).toBe(
      "Page not found · Live Radar",
    );
  });
});
