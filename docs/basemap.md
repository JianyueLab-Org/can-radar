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

## 自建：已实测，暂缓

**结论是现在不做**，因为「不受制于人」的前提是好维护，而自建换来的是一条要长期
养的流水线。但成本已经**实际构建并量过了**，不是估算 —— 真要走是一天的活。

### 关键发现：OSM 官方的海岸线不走 PostGIS

它的栅格栈和矢量栈**都直接读** `osmdata.openstreetmap.de` 上预处理好的
shapefile。所以「平陆地 + 平水域 + 海岸线」这张图和 planet PBF 无关，不需要
osm2pgsql，不需要 PostgreSQL。

| 数据                                     | 体积   | 内容                          | 授权     |
| ---------------------------------------- | ------ | ----------------------------- | -------- |
| `land-polygons-split-4326`               | 883 MB | 871,331 多边形 / 7,926 万顶点 | ODbL     |
| `simplified-land-polygons-complete-3857` | 24 MB  | 68,055 / 175 万               | ODbL     |
| `ne_10m_lakes`                           | 2.3 MB | 1,355 / 16 万                 | 公有领域 |

用 **split 版而不是 complete**：实测 split 的 871,331 个要素**一个洞都没有**，
切分网格已经把巨型环状多边形切成单环碎片，正是切瓦片想要的。

### 实测体积（2026-09 实际构建，tippecanoe）

| 档位           |                      归档 |          构建耗时 | 有数据的瓦片 | 去重后唯一瓦片 |
| -------------- | ------------------------: | ----------------: | -----------: | -------------: |
| 全球 z0–8      |               **65.1 MB** |              86 s |       42,543 |         23,917 |
| 全球 z0–10     |              **167.9 MB** |             211 s |      610,458 |        118,412 |
| 全球 z0–12     |              **381.8 MB** |            21 min |       937 万 |        535,983 |
| 东亚区域 z0–14 |               **38.0 MB** |           ~10 min |       149 万 |         71,080 |
| 全球 z0–14     | ≈**0.85–0.95 GB**（外推） | **>2h11m 未跑完** |            — |              — |

**对比：完整 Protomaps 底图全球 z0–12 是 18 GB —— 只留海岸线小 47 倍。**

零要素丢失已验证：三个档的 `tilestats` 都是 `{land: 871331, water: 1355}`，和源
数据一字不差。构建参数里 `--no-feature-limit --no-tile-size-limit` 是保险（实测最
大单瓦片 221 KB，从没碰到 500 KB 上限），`--simplify-only-low-zooms` 保住 maxzoom
的源精度，**不要用** `--drop-densest-as-needed` 那一类，丢一条海岸线就是破图。

### 为什么这么便宜：海岸线是 1.26 维

体积每级只涨 **×1.75**（z1–z11 几何平均 1.738，且随 zoom 继续下降到 1.45），不是
完整底图的 ×2.0，更不是网格的 ×4.0。拆开量是两个相反的效应：

- **含海岸线的瓦片数每级 ×2.40** —— 这是海岸线分形维数的直接测量，**盒计数得
  D ≈ 1.26**（Mandelbrot 对英国海岸线的经典值是 1.25）。所以它不是严格一维的
- **但每块 coast 瓦片的字节数每级 ×0.73** —— 放大后每块装的海岸线变短

  2.40 × 0.73 = **1.75**，正好是实测值。

三个把 O(4ᶻ) 压掉的机制，其中一个和直觉相反：

1. **纯海洋瓦片在矢量集里成本为零** —— tippecanoe 根本不写（z12 全球网格 1678 万
   块只写了 41.7%）。客户端拿水色当背景即可
2. **纯内陆瓦片不是空的**，是 67–97 字节的「一个铺满瓦片的矩形」。但 PMTiles 的
   内容去重把它们折叠掉了：937 万可寻址 → 528 万 RLE 条目 → **53.6 万唯一内容**
3. 唯一 blob 数 ≈ coast 瓦片数（z12：288,193 vs 282,416，差 2%），两把独立尺子对上

### 矢量还是栅格：实测推翻了「栅格更独立」

我原本推荐栅格，理由是它不需要任何渲染库、`L.tileLayer` 改一行。**那个理由本身没
错，但结论错了**，因为这一页的 `maxZoom` 是 18：

|                |                                    矢量 pmtiles |      栅格 PNG（朴素金字塔） |
| -------------- | ----------------------------------------------: | --------------------------: |
| z0–12 归档     |                                      **382 MB** |   2.90 GB（去重后 0.65 GB） |
| z0–14 归档     |                                     **≈0.9 GB** |    ≈37 GB（去重后 ≈2.6 GB） |
| 一屏流量 @z8   |                                         79.8 KB |                 **37.9 KB** |
| 一屏流量 @z12  |                                     **27.5 KB** |                     39.2 KB |
| 一屏流量 @z14  |                                      **5.5 KB** |                     25.5 KB |
| z14 以上的观感 |               几何重渲染，**边缘永远 1px 锐利** | **糊**。z14→z18 是 16× 放大 |
| 前端改动       | +37.7 KB gzip 的 `protomaps-leaflet` + 约 30 行 |             约 2 行，零依赖 |

**决定性的是最后两行的第一行。** 任何有限的栅格瓦片集在 z18 上都会被放大，而
「海岸线精度越高越好」这个诉求恰恰在放大时才被看见。要在栅格上避免，得构建到
z18 —— 那是 z14 的 256 倍瓦片数，TB 量级。

栅格的 O(4ᶻ) 来自 40% 的纯内陆瓦片，每块都要一个独立的 103 字节文件；**把栅格也
装进 PMTiles 做内容去重能修好这一项**（纯水/纯陆瓦片逐字节相同），但仍是矢量的
3 倍，且放大糊的问题修不了。

注意 `protomaps-leaflet` **只有 37.7 KB gzip**，不是 MapLibre 那 236 KB —— 而且
这里只用到它两个 `PolygonSymbolizer`，`RadarMap.vue` 其余 2000 多行一行不动。它
处于 maintenance mode 这件事仍然成立，但**用它百分之一的表面积**，真要换渲染器也
比换一整套底图样式容易得多。

### 两个会咬人的细节

**低 zoom 必须用 simplified 源。** 全精度源做出来的 z0 瓦片是 **197,785 字节 /
28,991 个要素**；simplified 源是 76,140 字节 / 4,006 个要素。z0–z5 用
`simplified-land-polygons-complete-3857`、z6+ 用 split 全精度，是标准做法，也是把
「打开地图时 canvas 要画三万个多边形」这个卡顿掐掉的办法。

**内陆水域只有一半是白送的。** 里海在 OSM 里标成 `natural=coastline`，是从 land
polygons 里挖掉的 —— 高精度湖岸免费拿到。但**五大湖、贝加尔湖、咸海完全不在里
面**，只画 land 层的话它们会渲染成实心陆地，必须靠 `ne_10m_lakes` 补。而 NE 10m
是 1:1000 万精度，大约只够撑到 z7–z8，z12 以上湖岸会看到明显折线。

### 托管侧

Cloudflare Free 档单文件可缓存上限 512 MB，所以归档不能让浏览器直读，要用
`pmtiles serve` 把它拆成小瓦片再让 CDN 缓存。`.mvt` 不在默认可缓存扩展名表里
（`.png` 在），所以要一条 Cache Rule 打开 Eligible for cache。`pmtiles serve` 永远
不发 `Cache-Control`，要靠 Cache Rule 的 Edge TTL 覆盖 —— **不能用 Response Header
Transform Rule 注入，官方明写缓存决策发生在响应头改写之前**。

许可干净：样式可抄 `openstreetmap-carto`（**CC0，LICENSE 明确写「包括制图设计」**）
或 VersaTiles 的 `shadow`（Unlicense）；渲染出的瓦片属于 ODbL 的 Produced Work 而
非 Derivative Database，**样式不会被 share-alike 传染**，唯一义务是角落一行
`© OpenStreetMap contributors`。

参考实现不用自己想：**Tilemaker 自带 coastline-only 配置**
（`process-coastline.lua` 里 `node_function()` 和 `way_function()` 全是空的，整个
瓦片集完全来自 shapefile）。

## 什么时候重新考虑

| 触发                               | 动作                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `basemap-check` 报警               | 看失败项。占位图 → 调 `MAX_NATIVE_ZOOM`；水印/统一错误图 → 换供应商         |
| Esri 开始要 key 或打水印           | 切 OpenFreeMap（要接 MapLibre）或 CARTO + 免费 key（改一行）                |
| 2029-12 临近                       | 按上面的步骤自建，或重新评估                                                |
| 用户设备的 WebGL2 覆盖率不再是问题 | OpenFreeMap 变成更优选                                                      |
| 需要删掉底图自带的路网             | 只有矢量做得到，Esri 做不到                                                 |
| 真要自建                           | 走矢量不走栅格（见上）；先做全球 z0–12，实测 382 MB / 21 分钟，够用再往上加 |
