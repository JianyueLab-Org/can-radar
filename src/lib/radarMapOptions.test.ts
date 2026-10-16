import { describe, expect, test } from "bun:test";
import { RADAR_MAP_WORLD_OPTIONS } from "@/lib/radarMapOptions";

describe("radar map world navigation", () => {
  test("keeps overlays visible after crossing a world copy", () => {
    expect(RADAR_MAP_WORLD_OPTIONS.worldCopyJump).toBe(true);
  });
});
