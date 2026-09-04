# 底图

这一页记的是**为什么用现在这张底图、换的时候有哪些选项、以及自建要付什么代价**。
写下来是因为 2026-09 那几天为了换底图查的东西，散在对话里两个月就没了，而下一次
需要它的时候大概率是三年后。

代码在 `src/components/RadarMap.vue`（`TILES` / `SATELLITE_TILE` /
`MAX_NATIVE_ZOOM`），检查在 `scripts/check-basemap.mjs`。**同一份配置在
can-database 的 `src/lib/mapBase.ts` 有第二份拷贝，两边要一起改。**

## 现状

| 用途 | 服务                                | 数据到 |
| ---- | ----------------------------------- | ------ |
| 深色 | Esri `Canvas/World_Dark_Gray_Base`  | z16    |
| 浅色 | Esri `Canvas/World_Light_Gray_Base` | z16    |
| 卫星 | Esri `World_Imagery`                | z19+   |

三张都在 `server.arcgisonline.com`，免 key，`{z}/{y}/{x}` 顺序（**注意 y 在 x 前
面**，和常见的 XYZ 相反），没有 `{s}` 子域也没有 `{r}` 高清后缀。

## 最要紧的一条：HTTP 200 不等于「有地图」

**2026-09 一周之内栽了两次，两次都是 200，两次都是靠人截图才发现的。**

1. **CARTO 打水印。** `basemaps.cartocdn.com` 开始给没有 API key 的请求回一张**把
   "API KEY REQUIRED" 烤进 PNG 里**的瓦片。状态码 200，图也照画。
2. **Esri 的占位图。** 换到 Esri 之后，超过 z16 返回一张写着 "Map data not yet
   available" 的灰板，**全球每一块都是同一张**（2521 字节，md5
   `f27d9de7f80c13501f470595e327aa6d`，深浅两套共用）。同样 200。

两次都是「探端点看状态码」这种检查完全发现不了的。`scripts/check-basemap.mjs`
就是为这两次写的，它检查四类**内容**不变量，一条状态码以外的可用性都不信：

- **A 占位图**：已知坏哈希不能出现
- **B 空瓦片体积**：一块公海瓦片必须一直很小。水印、报错文字这类东西会画在**每
  一块**瓦片上，包括本该空无一物的那块 —— 这是唯一能抓住 CARTO 那次的判据
- **C 相异性**：四块相距数千公里的城市瓦片必须有四个不同的哈希。这一条**不需要
  预先知道坏哈希**，是通用探测器
- **D `maxNativeZoom` 仍然成立**：声明的那一级必须是真数据

跑在 `.github/workflows/basemap-check.yml`，每天一次 + 改到底图文件时。**不带任
何 Secret，也不往外发通知** —— 工作流失败本身就是通知。这个仓库按规矩不持有
Secret，为一条告警开一个 webhook 不值得。

### 换供应商时必须重新实测「数据深度」

CARTO 的 `dark_all` 铺到 z20，Esri 的 Canvas 只到 z16。换过去时漏了这一维，于是
z17/z18 显示占位图。

这个值**不在服务的 LOD 元数据里**（Esri 那里报到 23，那是切片方案不是数据），
**也不会以错误码的形式告诉你**。只能一级一级抓瓦片看内容。配好之后写进
`MAX_NATIVE_ZOOM`，Leaflet 会用最深那级放大而不是去请求不存在的级别。

## 候选清单

2026-09 实测。分成两类，别混：**真·免 key 公益服务**（无需注册、无额度上限）和
**免费额度**（要 key、有月度上限、多数限非商业）。

### 真·免 key

| 候选                | 栅格/矢量   | 深色                  | 条款允许公开高流量          | 大陆可达              | 结论                                  |
| ------------------- | ----------- | --------------------- | --------------------------- | --------------------- | ------------------------------------- |
| **OpenFreeMap**     | **仅矢量**  | ✅ `dark`             | ✅ 明文「无限制」           | ✅ Cloudflare anycast | **免费方案里的第一名**                |
| VersaTiles          | 矢量 + 栅格 | ✅ `eclipse`/`shadow` | ❌ 官方定位「原型和小项目」 | ❌ 德国单机，慢 19×   | 仅自托管可用                          |
| Esri（现用）        | 栅格        | ✅                    | ⚠️ 见下                     | ✅ Akamai，最快       | 能用，有到期日                        |
| OSM 标准图层        | 栅格        | ❌ 无深色             | ⚠️ 捐赠基础设施             | ✅                    | 无深色，不适用                        |
| OSM 官方矢量        | 矢量        | 取决于样式            | ⚠️ 同上                     | ✅                    | 需 MapLibre                           |
| Wikimedia           | 栅格        | ❌                    | ❌ 仅限维基项目             | —                     | **实测按 Referer 封，我们的域名 403** |
| OSM France / German | 栅格        | ❌                    | ❌ 仅非营利且流量适中       | ✅                    | 不可用                                |
| NASA GIBS           | 栅格        | ✅ Black Marble       | ✅                          | ✅                    | 卫星，**z9 封顶**                     |
| EOX s2cloudless     | 栅格        | —                     | ⚠️ **按年份分许可**         | ⚠️ 捷克单机           | 见「卫星」                            |

**要 key 的**：CARTO 500 万/月 · Jawg 375 万瓦片/月 · Stadia 20 万/月 ·
Thunderforest 15 万/月（**免费档允许商业**，少见）· MapTiler 10 万/月（强制 logo）·
Tracestrack 10 万/月 · Mapbox 5 万 map loads/月。

### 关于 Esri 的两件事

**① 有到期日。** `Canvas/World_Dark_Gray_Base` 在 AGOL 上打着 `retiring-2029-12`
标签。`World_Imagery` 不在任何退役名单上，相对安全。

**② 条款存疑。** ArcGIS Location Platform Agreement（E204，2025-11-21 修订）
§3.1.a.4.C 禁止以「免费向第三方分发」的方式使用输出，§3.1.d.2 写「单次请求的输出
不得用于服务多个用户」（这一条否掉任何服务端共享缓存）。此外 legacy API key 已于
2026-07 退役，服务元数据 `exportTilesAllowed: false`。

「Location Platform 协议是否管得到 `server.arcgisonline.com` 这些遗留免费端点」
不是完全没有争议，但**证据足够强，该记在案**。

### OpenFreeMap 的代价

它是免费方案里唯一同时满足「免 key + 深色 + 条款允许公开高流量 + 大陆可达」四条
的，而且有一个 Esri 给不了的优势：**`dark` 样式的 47 个图层里 20 个是路网，一行
`removeLayer` 就能删掉**，剩下正好是我们要的观感。Esri 的路网烤死在像素里删不掉。
瓦片还自带 `aerodrome_label` 图层，**含 `icao` 字段**。

但它**只有矢量**（README 的「不提供」清单第四条就是 raster tile hosting），所以
接进 Leaflet 1.9 必须引入 MapLibre：

- `maplibre-gl` + `maplibre-gl-leaflet` + CSS：**brotli 236 KB / gzip 275 KB**
- 首屏静态资源（样式 / sprite / TileJSON）：约 173 KB
- 瓦片带宽约为栅格的 2–6 倍
- **硬要求 WebGL2**，拿不到就是整个底图不显示 —— 必须保留 Esri 那行
  `L.tileLayer` 作为降级路径
- **大陆专属的坑**：字形按 256 字一段切、每段约 132 KB，CJK 区推算约 10.5 MB。
  必须加 `localIdeographFontFamily: "'Noto Sans CJK SC', sans-serif"`，改用系统
  字体渲染，字形下载归零

另外 **CARTO 的 Positron / Dark Matter 样式本身是开源的**（代码 BSD-3，设计
CC-BY-4.0），且 schema 与 OpenFreeMap 的瓦片 14/14 完全匹配 —— 可以用 CARTO 打磨
过的深色制图跑在 OpenFreeMap 的免费瓦片上，运行时对 CARTO 零依赖。

## 卫星

现用 Esri `World_Imagery`（最快，61 ms）。两个替代：

- **NASA GIBS** —— 免 key，条款最干净（"full and open sharing"），但**z9 封顶**，
  只能做低缩放垫底。注意 **Suomi NPP 数据 2026-11-01 停止投递**，要用
  `VIIRS_NOAA20_*`。响应头是 `no-store`，任何量级流量都得自建缓存
- **EOX s2cloudless** —— 免 key，原生 z14。**许可按年份分**：2016 / 2017 版是
  **CC BY 4.0（允许商业）**，2018–2025 是 CC BY-NC-SA。想要条款干净就用 2016 版，
  代价是影像旧十年 —— 对显示航班位置的底图，海岸线和城市轮廓十年没什么变化

## 航空专用：没有能用的

`open flightmaps`（仅欧洲，中国区实测返回 1,233 字节的空白透明瓦片）、`openAIP`
（要 key，**中国连空域文件都没有**，只有机场和 27 条导航台；日本完整）、FAA
（仅美国）。`ChartBundle` 域名已 NXDOMAIN。

**但我们本来就有更好的数据**：`Sector/` 有九个大陆 FIR 加 RJJJ、RCAA，
`Ground/tools/merge.py` 已经把它渲染成 `ground.json`，而 can-dev 的
`src/lib/groundRender.ts` 已经能把那份 JSON 画到 canvas 上。要空域叠加层，复用这
条已有链路，不要去找瓦片源。

## 自建：已估价，暂缓

**结论是现在不做**，因为「不受制于人」的前提是好维护，而自建换来的是一条要长期
养的流水线。但成本已经摸清了，真要走是一天的活不是一个月：

**关键发现：OSM 官方的海岸线不走 PostGIS。** 它的栅格栈和矢量栈**都直接读**
`osmdata.openstreetmap.de` 上预处理好的 shapefile。所以「平陆地 + 平水域 + 海岸线」
这张图和 planet PBF 无关，不需要 osm2pgsql，不需要 PostgreSQL。

```
osmdata 的 shapefile （23 MB 简化版 z0–9 / 905 MB 全精度 z10+，每天重建）
   ↓  pip install mapnik        ← 4.3.1，自包含 wheel，不用编译 Boost
   ↓  一份手写 XML，两个图层
   ↓  离线烤 → PMTiles
   ↓  pmtiles serve （--bucket 指向 R2；HTTP 后端时一个 Secret 都不需要）
L.tileLayer(url, { maxNativeZoom: N })   ← 前端改一行，零新依赖
```

体量（z0–10 = 140 万瓦片，纯色块 PNG）：约 **0.4–1.1 GB**，塞得进一个容器镜像。

**栅格比矢量更独立**：矢量必须引入一个渲染库，而两个候选一个已停止维护
（`protomaps-leaflet`）、一个要 +236 KB 和 WebGL2（`maplibre-gl-leaflet`），
**且两者都把 Leaflet 钉死在 1.x**。栅格只用 `L.tileLayer`，新增依赖为零。

许可干净：样式可抄 `openstreetmap-carto`（**CC0，LICENSE 明确写「包括制图设计」**）
或 VersaTiles 的 `shadow`（Unlicense）；渲染出的 PNG 属于 ODbL 的 Produced Work
而非 Derivative Database，**样式不会被 share-alike 传染**，唯一义务是角落一行
`© OpenStreetMap contributors`。

参考实现不用自己想：**Tilemaker 自带 coastline-only 配置**
（`process-coastline.lua` 里 `node_function()` 和 `way_function()` 全是空的，整个
瓦片集完全来自 shapefile）。

**托管侧**（如果做）：Cloudflare Free 档单文件可缓存上限 512 MB，所以归档不能让浏
览器直读，要用 `pmtiles serve` 把它拆成小瓦片再让 CDN 缓存。`.mvt` 不在默认可缓存
扩展名表里而 **`.png` 在**，这也是栅格的一个便宜。`pmtiles serve` 永远不发
`Cache-Control`，要靠 Cache Rule 的 Edge TTL 覆盖（**不能用 Response Header
Transform Rule 注入 —— 官方明写缓存决策发生在响应头改写之前**）。

## 什么时候重新考虑

| 触发                               | 动作                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `basemap-check` 报警               | 看失败项。占位图 → 调 `MAX_NATIVE_ZOOM`；水印/统一错误图 → 换供应商 |
| Esri 开始要 key 或打水印           | 切 OpenFreeMap（要接 MapLibre）或 CARTO + 免费 key（改一行）        |
| 2029-12 临近                       | 按上面的步骤自建，或重新评估                                        |
| 用户设备的 WebGL2 覆盖率不再是问题 | OpenFreeMap 变成更优选                                              |
| 需要删掉底图自带的路网             | 只有矢量做得到，Esri 做不到                                         |
