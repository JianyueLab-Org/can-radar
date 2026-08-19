/**
 * Rebuild `public/boundaries.geojson` and `public/firs.json` from VATSpy.
 *
 *   node scripts/build-vatspy.mjs [commit-ish]
 *
 * Both files come out of the **same upstream commit**, which is the whole
 * point of doing them in one script. They were pinned separately before, and
 * they drifted: 532 of the 1408 FIR rows in the .dat named a boundary the
 * geojson beside it did not contain — every Japanese ACC sector among them.
 * A callsign whose boundary is missing draws nothing at all, silently, so the
 * drift showed up as "this controller is not on the map" rather than as an
 * error anywhere.
 *
 * `boundaries.geojson` is written verbatim. `firs.json` is derived: it is the
 * `[FIRs]`/`[UIRs]` sections reduced to the one question the map asks —
 * **which polygons does this callsign work** — and nothing else. See
 * `src/lib/firs.ts` for the matching side.
 *
 * Both are CC BY-SA 4.0 and already credited in the map's attribution bar.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Pinned rather than tracking `master`, so a given commit of this repo always
 * draws the same picture. Bump it deliberately, by passing a new one on the
 * command line, and commit the two files it writes together.
 */
const PIN = "0c48fc1664cfc4b9d7f97f744654746f4b72c6b4"; // 2026-08-09

/**
 * 上游 PRC UIR 少了 ZHWH（武汉）。
 *
 * VATSpy 的 `PRC|Beijing Control|…` 只列了八个 FIR，中国大陆有九个 —— 漏掉的正
 * 好是华中那一整块。`PRC_FSS` 是这张网络自己在用的席位（全大陆一个人管），漏一
 * 个 FIR 的表现是地图上华中一块不上色，而旁边八块都亮着，看上去像那个人的管辖
 * 范围就是这样，不像数据缺了一条。
 *
 * 补在这里而不是运行时：`firs.json` 是一份完整的答案表，匹配那一侧不该有特例。
 */
const UIR_EXTRA = { PRC: ["ZHWH"] };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commit = process.argv[2] || PIN;
const base = `https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/${commit}`;

async function download(name) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

const [dat, geojson] = await Promise.all([
  download("VATSpy.dat"),
  download("Boundaries.geojson"),
]);

/** Every boundary id the geojson actually carries. */
const drawn = new Set();
for (const feature of JSON.parse(geojson).features) {
  const id = feature?.properties?.id;
  if (id) drawn.add(String(id));
}

/** `[FIRs]` is `ICAO|Name|Callsign prefix|Boundary`; `[UIRs]` is `ICAO|Name|FIRs`. */
const rows = { FIRs: [], UIRs: [] };
let section = "";
for (const line of dat.split(/\r?\n/)) {
  if (line.startsWith("[")) {
    section = line.trim().slice(1, -1);
    continue;
  }
  const text = line.trim();
  if (!text || text.startsWith(";") || !rows[section]) continue;
  rows[section].push(text.split("|"));
}

/**
 * One entry per (prefix, boundary) pair, deduplicated.
 *
 * A row contributes its callsign prefix (`MEM` for Memphis Center) and, when
 * that differs, its ICAO — a controller may sign on as either, and the ICAO is
 * the only prefix the many rows with an empty callsign column have. An ICAO
 * carrying a hyphen (`RJDG-F01`) is skipped: that spelling is VATSpy's name
 * for a subdivision and can never appear in a callsign, where the separator is
 * always an underscore.
 */
const firs = [];
const seen = new Set();
let orphans = 0;

for (const [icao, name, callsign, boundary] of rows.FIRs) {
  if (!icao || !name) continue;
  const target = boundary || icao;
  if (!drawn.has(target)) {
    orphans++;
    continue;
  }

  for (const prefix of [callsign, icao]) {
    if (!prefix || prefix.includes("-")) continue;
    const key = `${prefix}\0${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firs.push({ prefix, boundary: target, name });
  }
}

const uirs = [];
for (const [icao, name, members] of rows.UIRs) {
  if (!icao || !name || !members) continue;
  const boundaries = [
    ...new Set([...members.split(","), ...(UIR_EXTRA[icao] ?? [])]),
  ]
    .map((value) => value.trim())
    .filter((value) => drawn.has(value));
  if (!boundaries.length) continue;
  uirs.push({ prefix: icao, name, boundaries });
}

const json = JSON.stringify({ version: commit, firs, uirs });
writeFileSync(join(root, "public", "boundaries.geojson"), geojson);
writeFileSync(join(root, "public", "firs.json"), json);

console.log(
  `boundaries.geojson: ${drawn.size} ids, ${(geojson.length / 1024).toFixed(0)} KB\n` +
    `firs.json: ${firs.length} prefixes, ${uirs.length} UIRs, ` +
    `${orphans} FIR rows dropped for having no polygon, ` +
    `${(json.length / 1024).toFixed(0)} KB`,
);
