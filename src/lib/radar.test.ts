import { describe, expect, test } from "bun:test";
import { arc } from "@/lib/radar";

describe("arc across the antimeridian", () => {
  test("unwraps a short leg", () => {
    const path = arc([50, 179.5], [50, -179.5]);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual([50, 179.5]);
    expect(path[1][0]).toBe(50);
    expect(path[1][1]).toBeCloseTo(180.5);
  });

  test("unwraps a short leg the other way", () => {
    const path = arc([50, -179.5], [50, 179.5]);
    expect(path[1][1]).toBeCloseTo(-180.5);
  });

  test("leaves an ordinary short leg alone", () => {
    expect(arc([39, 116], [39.2, 116.3])).toEqual([
      [39, 116],
      [39.2, 116.3],
    ]);
  });

  test("keeps a chained run continuous", () => {
    const waypoints: [number, number][] = [
      [50, 179],
      [50, 179.8],
      [50, -179.6],
      [50, -179],
    ];
    let from = waypoints[0];
    const run = [from];
    for (const to of waypoints.slice(1)) {
      const leg = arc(from, to);
      run.push(...leg.slice(1));
      from = leg[leg.length - 1];
    }
    for (let i = 1; i < run.length; i++) {
      expect(Math.abs(run[i][1] - run[i - 1][1])).toBeLessThan(180);
    }
  });
});
