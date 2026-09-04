#!/usr/bin/env node
/**
 * 底图健康检查 —— 防的不是「请求失败」，是「请求成功但图不能看」。
 *
 * 这个脚本存在的理由是两次真实事故，两次都是 **HTTP 200**，两次都是靠人截图
 * 才发现的：
 *
 *  1. 2026-09 CARTO 开始给没有 API key 的请求回一张**把 "API KEY REQUIRED"
 *     烤进 PNG 里**的瓦片。状态码 200，图也照画，探端点的检查一个都没报警。
 *  2. 2026-09 换到 Esri 之后，z17 以上返回一张写着 "Map data not yet
 *     available" 的占位图。同样 200，同样没人发现。
 *
 * 所以这里**一条都不检查状态码以外的"可用性"**，而是检查四类内容不变量。每一
 * 条都对应一种真实的失效方式：
 *
 *  A. 占位图  —— 已知的坏哈希不能出现。抓住的是「这一级根本没数据」。
 *  B. 空瓦片体积 —— 一块公海瓦片必须一直很小。水印、报错文字、"需要 key" 这类
 *     东西都会**画在每一块瓦片上**，包括本该空无一物的那块 —— 于是它会变大。
 *     这是唯一一条能抓住 CARTO 那次的判据。
 *  C. 相异性 —— 四块相距很远的城市瓦片必须有四个不同的哈希。任何形式的「统一
 *     错误图」都会让它们变成同一张。
 *  D. maxNativeZoom 仍然成立 —— 声明的那一级必须是真数据。再深一级**是**占位
 *     图则只记一笔不报错：那说明供应商补了数据，是好消息，可以调高。
 *
 * 没有任何 secret，也不往外发通知：跑在 GitHub Actions 的定时任务里，失败本身
 * 就是通知。这一条是刻意的 —— 这个仓库是公开的，而且按规矩**不持有任何
 * Secret**（见 AGENTS.md 开头）。
 *
 * 用法：node scripts/check-basemap.mjs
 */

import { createHash } from "node:crypto";

/** 经纬度 → 瓦片号。Esri 的路径是 {z}/{y}/{x}，注意顺序和常见的 XYZ 相反。 */
function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  return { x, y, z };
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const esri = (svc, { z, x, y }) =>
  `${ESRI}/${svc}/MapServer/tile/${z}/${y}/${x}`;

/**
 * 已知的坏哈希。
 *
 * `f27d9de7…` 是 Esri 的 "Map data not yet available"，**全球每一块都是同一
 * 张**（2521 字节）—— 正因为它是全局常量，钉死哈希才是可靠的判据。发现新的坏
 * 图就往这里加，别删旧的。
 */
const KNOWN_BAD = new Map([
  [
    "f27d9de7f80c13501f470595e327aa6d",
    'Esri "Map data not yet available" 占位图（深浅两套用的是同一张）',
  ],
]);

/**
 * 四个相距很远的城市点。选城市是因为它们的瓦片内容一定不同 —— 拿海面或沙漠做
 * 相异性检查会误报，那些地方本来就是同一张空图（实测甘肃 z13–16 全是一个哈希）。
 */
const CITIES = [
  ["上海", 31.14, 121.81],
  ["北京", 40.08, 116.58],
  ["洛杉矶", 33.94, -118.41],
  ["伦敦", 51.47, -0.45],
];

/** 一块公海。用来量「本该空无一物的瓦片有多大」。 */
const OPEN_OCEAN = ["中太平洋", 0, -150];

const LAYERS = [
  {
    name: "深色 Dark Gray Canvas",
    svc: "Canvas/World_Dark_Gray_Base",
    maxNativeZoom: 16, // 必须和 RadarMap.vue 的 MAX_NATIVE_ZOOM.canvas 一致
    oceanMaxBytes: 6000,
  },
  {
    name: "浅色 Light Gray Canvas",
    svc: "Canvas/World_Light_Gray_Base",
    maxNativeZoom: 16,
    oceanMaxBytes: 6000,
  },
  {
    name: "卫星 World Imagery",
    svc: "World_Imagery",
    maxNativeZoom: 18, // 实测 z19 仍有数据，这里跟着地图的 maxZoom 走
    oceanMaxBytes: 40000, // 影像的"空"瓦片是一片海水，本来就比矢量渲染的大
  },
];

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

async function get(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "can-radar-basemap-check (+https://radar.ceruleanavi.net)",
    },
    signal: AbortSignal.timeout(20000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    bytes: buf.length,
    md5: createHash("md5").update(buf).digest("hex"),
  };
}

/** 基本健康 + 已知坏哈希。返回结果，顺带把问题记进 failures。 */
async function probe(label, url, { minBytes = 500 } = {}) {
  let r;
  try {
    r = await get(url);
  } catch (e) {
    fail(`${label}：请求失败 —— ${e.message}`);
    return null;
  }
  if (r.status !== 200) {
    fail(`${label}：HTTP ${r.status}`);
    return r;
  }
  if (!r.type.startsWith("image/")) {
    fail(`${label}：Content-Type 不是图片（${r.type}）`);
  }
  if (r.bytes < minBytes) {
    fail(`${label}：瓦片只有 ${r.bytes} 字节，疑似空图或错误页`);
  }
  const bad = KNOWN_BAD.get(r.md5);
  if (bad) fail(`${label}：命中已知坏图 —— ${bad}（md5 ${r.md5}）`);
  return r;
}

for (const layer of LAYERS) {
  const z = layer.maxNativeZoom;

  // A + C + E：四个城市，在声明的最深一级
  const seen = new Map();
  for (const [city, lat, lon] of CITIES) {
    const label = `${layer.name} · ${city} z${z}`;
    const r = await probe(label, esri(layer.svc, tileOf(lat, lon, z)));
    if (!r || r.status !== 200) continue;
    if (seen.has(r.md5)) {
      fail(
        `${layer.name}：${city} 和 ${seen.get(r.md5)} 的瓦片**内容完全相同**` +
          `（md5 ${r.md5}）—— 相距数千公里的城市不该是同一张图，八成在发统一的错误图`,
      );
    }
    seen.set(r.md5, city);
  }

  // B：公海瓦片必须一直很小。变大 = 有东西被画在了每一块瓦片上（水印/报错）
  const [oceanName, oLat, oLon] = OPEN_OCEAN;
  const ocean = await probe(
    `${layer.name} · ${oceanName} z8`,
    esri(layer.svc, tileOf(oLat, oLon, 8)),
    { minBytes: 100 },
  );
  if (ocean?.status === 200 && ocean.bytes > layer.oceanMaxBytes) {
    fail(
      `${layer.name}：公海瓦片 ${ocean.bytes} 字节，超过 ${layer.oceanMaxBytes} 的上限 —— ` +
        `一块本该空无一物的瓦片变大，通常意味着有水印或报错文字被画到了每一块图上`,
    );
  }

  // D：再深一级是不是还是占位图。是 → 现状正确，只记一笔；不是 → 供应商补了
  //    数据，可以调高 maxNativeZoom（好消息，不报错）
  let deeper;
  try {
    deeper = await get(esri(layer.svc, tileOf(31.14, 121.81, z + 1)));
  } catch {
    deeper = null;
  }
  if (deeper?.status === 200 && !KNOWN_BAD.has(deeper.md5)) {
    note(
      `${layer.name}：z${z + 1} 现在有真数据了（${deeper.bytes} 字节，md5 ` +
        `${deeper.md5.slice(0, 8)}）—— maxNativeZoom 也许可以从 ${z} 调高。` +
        `调之前请多测几个地区，Esri 的数据深度**不是全球一致的**。`,
    );
  }
}

for (const n of notes) console.log(`ℹ️  ${n}`);

if (failures.length) {
  console.error(`\n❌ 底图检查失败，${failures.length} 项：\n`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(
    `\n处理方式见 docs/basemap.md：那里有候选底图清单、各自的条款和到期日，` +
      `以及自建的具体步骤。`,
  );
  process.exit(1);
}

console.log(`\n✅ 底图检查通过（${LAYERS.length} 个图层）`);
