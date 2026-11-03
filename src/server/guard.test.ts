import type { APIContext } from "astro";
import { afterEach, expect, test } from "bun:test";
import { crossOrigin } from "./guard";

afterEach(() => {
  delete process.env.PUBLIC_ORIGIN;
});

test("only unsafe requests require the configured public Origin", () => {
  process.env.PUBLIC_ORIGIN = "https://configured.example";
  for (const method of [
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ]) {
    for (const origin of [
      undefined,
      "null",
      "https://evil.ceruleanavi.net",
      "http://internal.test",
      "https://configured.example",
    ]) {
      const headers = new Headers();
      if (origin !== undefined) headers.set("origin", origin);
      const context = {
        request: new Request("http://internal.test/api/write", {
          method,
          headers,
        }),
      } as APIContext;
      expect(crossOrigin(context)).toBe(
        !["GET", "HEAD", "OPTIONS"].includes(method) &&
          origin !== "https://configured.example",
      );
    }
  }
});
