import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("外观只用 can-ui 的记号", () => {
  test("vr-theme.css 已删除", () => {
    expect(existsSync("src/styles/vr-theme.css")).toBe(false);
  });
  test("src 里没有 --vr-* 变量", () => {
    const hits = files("src")
      .filter(
        (path) =>
          /\.(vue|ts|astro|css)$/.test(path) &&
          !path.endsWith("tokens.test.ts"),
      )
      .filter((path) => /--vr-/.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });
  test("不用毛玻璃", () => {
    const hits = files("src")
      .filter((path) => /\.(vue|css)$/.test(path))
      .filter((path) =>
        /backdrop-filter:\s*blur/.test(readFileSync(path, "utf8")),
      );
    expect(hits).toEqual([]);
  });
});
