# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CAN 在线雷达，从 can-web 拆出来。Astro SSR + Vue 岛屿 + Tailwind v4 + Leaflet。
**没有自己的登录**，但认得出网络的会话（见第 5 条）。README 是给人读的那一份。

## 命令

```bash
bun run dev      # :4323（4321 can-web，4322 can-dev）
bun run lint     # format:check + astro check + vue-tsc
bun run build && bun run start
```

没有测试套件。门禁是 `bun run lint` 加一次 `bun run build`。
`astro check` 看不见 `.vue`，所以 `typecheck` 同时跑 `vue-tsc`——两个都要留着。

## 五条要紧的

**1. 导航数据不在这个站点里，一点都没有。** 它曾经在（`NAVDATA_DIR` 挂进来、
`src/server/navdata.ts` 解析），现在整件事在 **can-api 的 `internal/navdata/`**，
这边的 `/api/v1/route` 只是一个转发。理由和第 2 条是同一个：AIRAC 派生的商业数
据不该在全网最公开的那个部署里落地。上游 503 时地图照旧退回直飞弧线。**别把它
搬回来**，也别为了「本地方便」把那批文件塞进 `public/` 或镜像层。

**2. 这个站点不碰数据库。** 航迹走 `/api/v1/track` 转发到 can-api。它是全网最
公开的页面，不该拿着数据库口令。想加新数据时先问：能不能让 can-api 或 can-fsd
去读。

**3. `radarTypes.ts` 是拷贝，两边都在用。** can-web 还要同一份数据源形状。改
它之前记得那边也有一份；真正防漂移的是 can-fsd 的 `datafeed_golden.json`。

**4. 页眉链接要走 `site()`。** 这里是另一个源，写 `href="/roster"` 会打在
radar.ceruleanavi.net 上然后 404。`siteOrigin` 默认指向主站。

**5. 这个站点认得出会话，但没有登录。** 两句话都要成立，缺一句就会有人写错东西。

会话 cookie（`can_session`）由 can-api 签发，`COOKIE_DOMAIN` 是**父域**
`.ceruleanavi.net` —— 它必须如此，否则 can-web 和 can-dev 也看不见它。
radar.ceruleanavi.net 是那个域下面的一台主机，所以那枚 cookie 一直都被浏览器送到
这里，只是以前没人读。`src/server/session.ts` 把它转发给 can-api 的
`/api/v1/auth/session` 问一次「这是谁」，就这些。

- **不要在这里验签。** 验签要 `SESSION_SECRET`，而那是「能签发任何人的会话」
  的能力 —— 全网最公开的这个部署不该有第二处存放点。拿 cookie 去问，这个站点
  就永远只是个读者。
- **不要在这里放密码表单。** 登录入口只有主站一个（`/signin`）。多一个输密码
  的地方就是多一个钓鱼面，而这一页恰恰是最多人直接打开的那个。
- **没有 cookie 就不问上游。** 匿名流量是这一页的绝大多数，带 cookie 才调用，
  否则每个爬虫都会变成 can-api 的一次数据库读。
- **认出人的那份 HTML 不能被缓存**（`index.astro` 里那个 `private, no-store`）。
- **`/api/v1/signout` 是本站唯一的写操作**，它连带着 `astro.config.mjs` 里关掉
  的 `checkOrigin` 和 `src/server/guard.ts` —— 三件事一起读，理由写在那两个文件
  里（反代 + TLS 终止会让 Astro 自带的那道检查永远 403）。

登录之后多出来的是两件事，性质不一样，别把第二件当成第一件的延伸。

**认出哪一架飞机是你的**（数据源里的 `cid` 就是成员的 `username`，见
`src/lib/member.ts`），然后在地图和名单上给它一个记号、可以跟着它。这一件**数据
上一个字节都没多要** —— 那架飞机本来就在公开数据源里，登录只是让这一页知道哪一
架是你的。

**预约管制那张卡**（`RadarBookings.vue`）是这个站点第一件**匿名看不到**的东西。
板子上有成员用户名和自由填写的备注，那是网络内部的；上游那条（can-api 的
`GET /api/v1/atc/reservations`）也确实挂在 `WithPilot` 后面。所以本站那条同名转
发（`src/pages/api/v1/atc/reservations.ts`）**没有 cookie 就答 401**，一次上游都
不打，而卡片对匿名访问**整个不渲染** —— 不是渲染出来再写一句劝人登录的话。要让
它公开的话，改的是 can-api 那条路由的守卫，不是这里加个绕过。

## 外观：这个站不再跟 can-web 一套皮

界面照 [VATSIM Radar](https://github.com/VATSIM-Radar/vatsim-radar) 重做过 ——
近黑的层级面、1px 发丝边框、4px/8px 的小圆角、Libre Franklin + Jura + Roboto
Mono，以及**浮在整屏地图上的一摞卡片**取代原来的三栏。

**`globals.css` 仍然是 can-web 那份的镜像，一个字都没改。** 换皮的整件事在
`src/styles/vr-theme.css` 里，它排在 globals.css **后面**加载，把语义记号
（`--surface*`、`--border-*`、`--color-ink|muted|faint`、两个圆角）和 `.btn`
/ `.input` / `.badge` 重新指向另一套值。所以没被重写的组件也跟着变了样子。
两件事别踩：

- 那份文件里**不能有 Tailwind 的 at-rule**。`@theme` 只在 Tailwind 处理的入口
  里展开，写在那儿不生效，但看上去像能用。
- 它**不进任何 `@layer`**，这正是它能覆盖的原因 —— 未分层的规则在级联里排在所有
  分层规则之上，与选择器权重无关。

**品牌色没有跟着换。** vatsim-radar 用 `blue500 #3B6CEC`，这里仍然是 CAN 自己的
`#4c92c1`：三个站刚统一到网络自己的标识上，为了套一层皮把品牌色也换掉是本末倒
置。要换只是 `--vr-brand` 那三行。**席位色是照搬的**（DEL/GND/TWR/APP/CTR/ATIS），
那是约定不是装饰。

**`leaflet.css` 在 `BaseLayout.astro` 里引，不在 RadarMap.vue 里。** 从组件里引
的话它是岛屿的动态样式表，浏览器插在 `<head>` 末尾，反过来盖住外观层里同权重的
规则 —— 版权条会留着一串默认的亮蓝链接、比例尺是一块白底。顺序由布局说了算。
另外 `vr-theme.css` 里针对版权条的几条带 `:root` 前缀，是为了压过 globals.css
里 `.dark .leaflet-control-attribution` 那一档权重。

**站头也换了，而且它从此不再是 can-web 的镜像**（56px、只有一条底边、选中项在下
沿画 2px）。另外两个站的那份没有动。

**浮层分两栏，分工是「我在看谁」和「网络上有谁」。** 左边只有一张卡：选中的飞机
或席位（`RadarDetails`）。右边是名单那一摞：机场卡（`RadarAirport`）、交通列表
（`RadarTraffic`），以及压在它下面的预约卡（`RadarBookings`，只对登录着的人出
现）。分开是因为两者常常要同时看 —— 挤在同一列时，选中一架飞机会把名单整个推下
去，而人多半正想在名单里挑下一架。

那一摞的顺序不是随手排的：交通说的是「现在谁在线」，预约说的是「等一下有谁开
席」。一个准备飞的人先问前者，问不到才往下看后者 —— 反过来会让一张多半为空的板
子挡在最要紧的名单前面。

左栏的 `bottom` 是写死的 192px，让开左下角那一列控件（四个 32px 方块 + 三道 8px
的缝 + 空隙）。**加第五个按钮时这个数要跟着改**，两处都留了注释。

窄屏上没有左右可分，两栏都是底部抽屉、占同一块位置；`select()` 里选中飞机或席位
时把名单收起来，所以它们永远不会同时出现。机场卡是个例外 —— 它本来就在名单那一
摞里，收掉名单等于把它一起收掉。

`src/components/vr/` 是这套设计的原件：`VrInfoPopup` 是那张卡（vatsim-radar 的
`PopupOverlay`），`VrButton` / `VrTabs` / `VrBlockTitle` / `VrBubble` 是它周围
的零件。新面板套 `VrInfoPopup` 并用 `sections` 声明分段，别自己拼一遍卡片外壳。

## public/ 里那五个数据文件

`airports.json`（VATSpy，机场坐标）、`boundaries.geojson`（VATSpy，FIR 多边形）、
`firs.json`（VATSpy，呼号前缀 → 边界 id）、`airport-codes.json`（VATSpy，三字代码
→ ICAO）、`tracon.geojson`（SimAware，进近空域）。两个数据源都在版权条里署了名，
都是 **CC BY-SA 4.0** —— 可以随仓库分发，这也是它们和 `data/navdata/` 的根本区
别：navdata 是商业 AIRAC 派生物，永远不进这个公开仓库。

**其中两个是补回来的。** 从 can-web 拆出来时只带走了 `tracon.geojson`，另外两个
留在了原地，于是这个站从拆分那天起：航路线画不出来（`loadAirports()` 404 之后
返回 `{}`，`airportAt()` 永远是 null，那条「直飞目的地」的降级弧线也就没有终
点）、管制区边界一片空白、详情卡上的「剩余 / 预计到达」两行从来没出现过 ——
而版权条一直在署名它并没有装的那批数据。Dockerfile 是 `COPY . .`，k8s 只挂
navdata 的卷，所以没有任何运行时通路能补上它们：文件不在仓库里就是不在。

**`boundaries.geojson`、`firs.json` 和 `airport-codes.json` 必须出自同一个上游
commit**，所以它们由**这个仓库的** `scripts/build-vatspy.mjs` 一起生成（commit
写死在脚本里，改了要把三个文件一起提交）：

```bash
node scripts/build-vatspy.mjs [commit-ish]
```

以前不是这样 —— 两份分别取自不同时候的上游，于是 `.dat` 里 1408 条 FIR 中有 532
条指向这边没有的多边形，日本的 ACC 扇区几乎全在里面。**匹配不到边界的席位是无声
消失的**（不画多边形，CTR 也不落机场标牌），所以那种漂移的表现是「这个人没上
线」而不是任何一处报错。`airports.json` 仍然是 can-web 的（`scripts/build-airports.mjs`），
这边是拷贝。

## 区调呼号怎么对上多边形：`src/lib/firs.ts`

多边形只带一个 id（`KZME`），管制员登录用的是另一套写法（`MEM_22_CTR`）。对照表
是 VATSpy.dat 的 `[FIRs]`/`[UIRs]`，编译进 `firs.json`，匹配照 vatsim-radar 的
判据：**按下划线分段的最长前缀赢**。

这以前是一堆手写规则（互相 `startsWith`、把 `A_B_CTR` 读成 `A-B` 扇区、三条写死
的 `lax→kzla`/`hkg→vhhk`/`tpe→rcaa`），能猜中的只有「呼号第一段就是边界 id」这
一种情况。中国和港台恰好都是这样，所以本网自己的空域一直是对的，而**北美整个错
过** —— 美国的前缀是三字代码，`MEM` 和 `KZME` 没有公共前缀。日本的小扇区错得更
隐蔽：`RJDG_01_CTR` 会匹配上父 FIR，于是「有人管 F01 扇区」画成了「有人管整个福
冈」。

三件事别踩：

- **按段比较，不是裸的 `startsWith`**（上游是裸的）。VATSpy 里既有 `RJTG` 又有
  `RJTG_O`（东京 T36 扇区），裸判断会把 `RJTG_OCEANIC_CTR` 判进 T36。
- **`_O_` 不再表示海洋区。** 上游已经把东京海洋区拆成独立的 `RJJJ`，`RJTG_O` 现
  在是 T36 的前缀。海陆之分只剩 `_FSS` 这一条判据，而且它是**同一个 id 两个要素
  之间挑一个**（现在只有 `KZNY`、`SUEO` 用得上），不是过滤条件。
- **上游的 `PRC` UIR 少了 ZHWH（武汉）。** 大陆九个 FIR 它只列了八个，补在
  `scripts/build-vatspy.mjs` 的 `UIR_EXTRA` 里 —— 少了它的表现是 `PRC_FSS` 上线
  时华中一块不上色，旁边八块都亮着，看上去像管辖范围本来如此。

`ZBAA_C_CTR` 匹配到的是整个 `ZBAA`：上游把北京的中央扇区拆成了 `ZBAA-E`/
`ZBAA-SW`，`ZBAA-C` 这个多边形已经不存在了，而扇区包里还有这个席位。退回父 FIR
是这种情况下唯一能做对的事。`RJCG_*`（札幌）则是 VATSpy 根本没有的 FIR，匹配不
到任何东西 —— 它在右边的席位列表里照样出现，只是地图上没有它的空域。

## 北美的本场席位报的是三字代码

`MEM_TWR` 而不是 `KMEM_TWR`。而这张图别处认的全是 ICAO —— 飞行计划里写 `KMEM`，
`airports.json` 按 ICAO 索引坐标，METAR 也按 ICAO 查。所以在补上
`airport-codes.json`（VATSpy.dat 的 `[Airports]`，`IATA/LID` 那一列）之前，**北
美每一个机场卡都是空的**：席位那一栏列得出来（它和标牌用的是同一个前缀），进离
场、天气、坐标全部对不上，而三者都是「查不到就安静地不显示」，看上去像那个机场
此刻没有航班。解析在 `src/lib/airportCodes.ts`，判据照 vatsim-radar 的
`realIata` / `iata` 两层。

- **本场席位（放行/地面/塔台/通播）两张表都查，进近只查真的那张。** VATSpy 把机
  场的备用写法放在 `IsPseudo=1` 的行上（多伦多的 `YYZ` 就在那儿），但同一批假行
  里还混着进近的代码 —— `SCT` 挂在 KLAX 上、`NCT` 挂在 KSFO 上。塔台认得出 `YYZ`
  是好事，把南加进近的标牌写成「KLAX」不是：它管的是一整片终端区，不是那一个场。
- **本身就是某个机场 ICAO 的代码不进表**（`LEVS` 既是 LECU 的 LID，又是同一个场
  的另一个 ICAO 写法）。查表的一方分不清手里那串是哪一种，让它原样通过就对了。
- **`ownsAirspace` 现在是共享的**（`lib/facilities.ts`）。机场卡以前靠「呼号第一
  段等于机场 ICAO」自然把区调滤掉 —— `ZSHA` 不是任何机场。北美把这个巧合打破
  了：`MEM_22_CTR` 的 `MEM` 解析得出 `KMEM`，孟菲斯区调会冒充成一个坐在孟菲斯机
  场里的席位。**这条只对 `controllers` 那一份用**，通播的 facility 也可能是 7，
  一起滤会把机场卡上的通播滤掉。

## 空闲的扇区划分不画

`boundaries.geojson` 的 1102 个要素里有 633 个是扇区划分（`ADR-E`、`RJDG-F01`），
它们画在自己所属 FIR 的多边形之上 —— 全铺开就是每个被拆过的 FIR 一圈外框加几条
内部分割线，叠成一张网。所以**没人管的时候只画 FIR 本身**（`idleHiddenBoundaries`）。

判据是「父 FIR 也在这份数据里」，不是「id 里有连字符」：有 32 个子扇区找不到父
要素，包括这张网络自己的 `ZJSY-*`（三亚，父要素叫 `ZJSA`）和 `TEH-*`，按连字符
一刀切会让那几块空域整个消失。

一旦有人上了某个扇区，syncBoundaries 照常把它挪进 boundariesLayer 高亮 —— 「这
块被拆开的空域现在有人管」正是必须画出来的信息。

## 地图上的向量颜色在 `lib/radar.ts`

管制区填色（`AREA_COLORS`）和航路线（`ROUTE_COLORS`）是 JS 字面量，不是
vr-theme.css 的记号 —— 地图开着 `preferCanvas`，多边形和折线画进 canvas，而
canvas 的 `strokeStyle` 不认 CSS 自定义属性，`var(--vr-t3)` 传给 Leaflet 只会
得到一条什么都不画的线。

放在 `lib/radar.ts` 而不是地图组件里，是因为**设置里的图例要用同一批值**。两边
各写一份色号，是那种改了一边、另一边悄悄开始说谎的东西。

`AREA_COLORS.idle` 跟主题走，所以主题的 watch 里要调 `syncBoundaries()` 重新
上色。

## 别的

- `globals.css` 是从 can-web 整份搬来的，只去掉了 `@tailwindcss/typography`
  （那是给 /docs 长文用的，这里没有长文）。底部的 Leaflet 块是刻意写死的，
  别动 —— can-web 的 CLAUDE.md 也是这么说的。它现在被 `vr-theme.css` 盖了一层，
  但**仍然是镜像**：要同步 can-web 的改动，照样整份覆盖过来就行。
- 地图底部的版权条把 VATSpy 和 SimAware **各署名了两次** —— 一次在
  `tileLayer` 的 `attribution` 里，一次在后面的 `addAttribution()` 里。重构前
  它挤在角落没人注意，现在整条横在地图下沿。这是授权文本，没有顺手改掉。
- 部署见 `deploy/k8s.yaml`。镜像由 CI 推 GHCR，上线是手工 rollout restart：
  jyl-tyo 的 kubectl 走 Omni OIDC，CI 里过不去。
