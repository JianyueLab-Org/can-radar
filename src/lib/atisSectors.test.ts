import { describe, expect, test } from "bun:test";
import {
  allowsExtending,
  extendedCallsign,
  facilitySuffix,
  parseAtisSectors,
} from "./atisSectors";

describe("parseAtisSectors", () => {
  test("reads the EuroScope ATIS3 covering line", () => {
    expect(
      parseAtisSectors([
        "Tokyo Control / Tokyo Kontororu (JA)",
        "Covering sector - T30",
        "AIP levels - Area 1 SFC-UNL",
      ]),
    ).toEqual({
      covering: ["T30"],
      extending: [],
      coveringEntries: [{ name: "T30" }],
      extendingEntries: [],
    });
  });

  test("accepts CRC Covering Sectors and a list", () => {
    expect(parseAtisSectors(["Covering Sectors - T30, T31 T32"])).toEqual({
      covering: ["T30", "T31", "T32"],
      extending: [],
      coveringEntries: [{ name: "T30" }, { name: "T31" }, { name: "T32" }],
      extendingEntries: [],
    });
  });

  test("accepts a short Covering line with multiple sector names", () => {
    expect(parseAtisSectors(["Covering - BJE1 BJE"])).toEqual({
      covering: ["BJE1", "BJE"],
      extending: [],
      coveringEntries: [{ name: "BJE1" }, { name: "BJE" }],
      extendingEntries: [],
    });
  });

  test("reads Extending as same-position airports", () => {
    expect(parseAtisSectors(["Extending - ZSSS"])).toEqual({
      covering: [],
      extending: ["ZSSS"],
      coveringEntries: [],
      extendingEntries: [{ name: "ZSSS" }],
    });
    expect(parseAtisSectors(["Extending - ZSSS, ZSNJ"])).toEqual({
      covering: [],
      extending: ["ZSSS", "ZSNJ"],
      coveringEntries: [],
      extendingEntries: [{ name: "ZSSS" }, { name: "ZSNJ" }],
    });
  });

  test("accepts an empty Extending line", () => {
    expect(parseAtisSectors(["Extending - "])).toEqual({
      covering: [],
      extending: [],
      coveringEntries: [],
      extendingEntries: [],
    });
  });

  test("ignores Covering area and unprefixed extending", () => {
    expect(
      parseAtisSectors([
        "Covering area - Ground movement area",
        "Extending N47 133.55",
      ]),
    ).toEqual({
      covering: [],
      extending: [],
      coveringEntries: [],
      extendingEntries: [],
    });
  });

  test("drops a trailing frequency", () => {
    expect(parseAtisSectors(["Covering Sectors - T30 127.500"])).toEqual({
      covering: ["T30"],
      extending: [],
      coveringEntries: [{ name: "T30", frequency: "127.500" }],
      extendingEntries: [],
    });
  });

  test("does not require the covering line to be second", () => {
    expect(
      parseAtisSectors([
        "RJTG_30_CTR 127.500",
        "Tokyo Control / Tokyo Kontororu (JA)",
        "Covering sectors - T30",
      ]),
    ).toEqual({
      covering: ["T30"],
      extending: [],
      coveringEntries: [{ name: "T30" }],
      extendingEntries: [],
    });
  });

  test("keeps a frequency attached to each covering or extending entry", () => {
    expect(
      parseAtisSectors([
        "Covering [BJN 133.025, BJS 127.350, BJW 128.100, BJE 120.350]",
        "Extending - [ZBHH 133.700]",
      ]),
    ).toEqual({
      covering: ["BJN", "BJS", "BJW", "BJE"],
      extending: ["ZBHH"],
      coveringEntries: [
        { name: "BJN", frequency: "133.025" },
        { name: "BJS", frequency: "127.350" },
        { name: "BJW", frequency: "128.100" },
        { name: "BJE", frequency: "120.350" },
      ],
      extendingEntries: [{ name: "ZBHH", frequency: "133.700" }],
    });
  });
});

describe("extendedCallsign", () => {
  test("copies the logged-on facility onto the other airport", () => {
    expect(facilitySuffix("ZSPD_TWR")).toBe("TWR");
    expect(facilitySuffix("ZSPD_N_TWR")).toBe("TWR");
    expect(extendedCallsign("ZSPD_TWR", "ZSSS")).toBe("ZSSS_TWR");
    expect(extendedCallsign("ZSPD_TWR", "ZSSS_APP")).toBe("ZSSS_TWR");
    expect(extendedCallsign("ZSPD_APP", "ZSSS")).toBe("ZSSS_APP");
    expect(extendedCallsign("ZSPD_GND", "ZSSS")).toBe("ZSSS_GND");
    expect(extendedCallsign("ZSPD_DEL", "ZSSS")).toBe("ZSSS_DEL");
    expect(extendedCallsign("ZSHA_CTR", "ZGGG")).toBe("ZGGG_CTR");
    expect(extendedCallsign("ZSPD_DEP", "ZSSS")).toBe("ZSSS_DEP");
  });

  test("FSS does not extend", () => {
    expect(allowsExtending({ facility: 1, callsign: "PRC_FSS" })).toBe(false);
    expect(allowsExtending({ facility: 6, callsign: "ZSHA_FSS" })).toBe(false);
    expect(allowsExtending({ facility: 4, callsign: "ZSPD_TWR" })).toBe(true);
    expect(allowsExtending({ facility: 6, callsign: "ZSHA_CTR" })).toBe(true);
    expect(allowsExtending({ facility: 5, callsign: "ZSPD_APP" })).toBe(true);
  });
});
