# can-radar — CAN 在线雷达

Cerulean Aviation Network 的在线雷达，从 can-web 拆出来的那一块。
Astro SSR + Vue 岛屿 + Tailwind v4 + Leaflet，形状和 can-web / can-dev 一致。

**整张图不需要登录**，一如既往：数据全部来自 can-fsd 的公开数据源，它在
can-web 里的时候就不在 `PROTECTED_PREFIXES` 里。

登录着的成员多一件事 —— **雷达认得出哪一架是你的飞机**：地图和名单上给它一个
记号，可以让画面一直跟着它。这不需要这个站点长出一套登录：网络的会话 cookie
本来就带到这里来了（can-api 签在父域 `.ceruleanavi.net` 上），这边只是读一下。
密码表单仍然只在主站有一个，这边也仍然没有数据库口令。见「登录是怎么回事」。

## 命令

```bash
bun install
bun run dev      # :4323（4321 是 can-web，4322 是 can-dev）
bun run lint     # format:check + astro check + vue-tsc
bun run build && bun run start
```

## 它从哪儿拿数据

| 数据               | 来源                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| 在线飞机与管制席位 | can-fsd 的数据源 `https://data.ceruleanavi.net/v1/data.json`，浏览器直接读 |
| 已飞航迹           | 本站 `/api/v1/track` —— **一个转发**，真正读 `flightPosition` 的是 can-api |
| 航路解析           | 本站 `/api/v1/route`，服务端读 `data/navdata`                              |

地图底图之外的那几块静态数据在 `public/`：机场坐标、FIR 多边形、进近空域，外加两
张给北美用的对照表 —— `firs.json`（呼号前缀 → FIR，没有它 `MEM_22_CTR` 在地图上
找不到自己的空域）和 `airport-codes.json`（三字代码 → ICAO，没有它 `MEM_TWR` 点开
的机场卡是空的）。三者必须出自同一个 VATSpy commit，一起刷新：

```bash
node scripts/build-vatspy.mjs
# 写 public/{boundaries.geojson,firs.json,airport-codes.json}
```

航迹为什么是转发而不是直连数据库：`flightPosition` 的 schema 归 can-api 所有，
而这个站点是整个网络上最公开、被爬得最凶的一个页面。让最暴露的东西持有数据库
口令，是这次拆分最不该做的事。顺带的好处是不用给 can-api 开 CORS —— 转发在服务
端，浏览器那边始终是同源的。

## 导航数据不在仓库里

`data/navdata` 是 AIRAC 派生的商业数据。can-web 把它提交进自己仓库的唯一理由
是那个仓库私有 —— 它的 `data/navdata/README.md` 写着「一旦公开或者被 fork 出
去，这个理由就不成立」。**本仓库是公开的**，所以文件既不进 git 也不进公开镜像。

运行时用 `NAVDATA_DIR` 指过去。集群里推荐用一个 PVC（longhorn 已装），因为整
套 5.9 MB 塞不进一个 1 MiB 上限的 Secret。

缺席不会坏：`/api/v1/route` 回 `503 navDataUnavailable`，地图退回它本来就有的
直飞弧线。这是 can-web 时期就设计好的降级路径，所以第一次上线可以先不挂，把
这件事和部署分开验。

## 和 can-web 的关系

- `radarTypes.ts` 是**拷贝**不是搬走：can-web 还要用同一份数据源形状（
  `FlightPlan.vue` 的 `tracked_by` 锁、`PilotsDashboard.vue`、`LiveNetwork.vue`、
  `server/fsd.ts`）。两份会不会漂移，真正的看门人是 can-fsd 的
  `testdata/datafeed_golden.json` 契约测试。
- 页眉里的导航指回主站（`siteOrigin`，默认 `https://ceruleanavi.net`）：这里是另
  一个源，相对路径会打在雷达自己的域名上然后 404。
- 会话是**共享的**，见下一节。登录页在主站，这边只读不签。

## 登录是怎么回事

这个站点没有自己的登录：没有密码表单、没有会话格式、没有 `SESSION_SECRET`。
它做的只是读一枚**本来就送到这里**的 cookie。

can-api 签发会话时把 cookie 的 Domain 设成父域 `.ceruleanavi.net`（它必须如此，
否则 can-web 和 can-dev 也看不见它）。radar.ceruleanavi.net 是那个域下面的一台主
机，浏览器于是把它一并带过来 —— 服务端渲染时拿它去问一次 can-api 的
`/api/v1/auth/session`，就知道来的人是谁了。

| 动作     | 在哪儿发生                                                             |
| -------- | ---------------------------------------------------------------------- |
| 登录     | 主站 `/signin`。这边只有一个链接过去，**没有密码表单**                 |
| 认出是谁 | 本站服务端 `src/server/session.ts` → can-api `/api/v1/auth/session`    |
| 登出     | 本站 `/api/v1/signout` —— 转发给 can-api，把它回的 `Set-Cookie` 传回去 |

为什么不在这边验签：验签需要 `SESSION_SECRET`，那是「能签发任何人的会话」的能
力。把它放进全网最公开的这个部署，省下的只是一次内网 HTTP，换来的是多一处可能
泄露的密钥。拿 cookie 去问，这个站点就永远只是个读者。

登出为什么反而在这边：这是那种开在副屏上一整天的页面，让人为了退出跳去主站，
多数人会直接关标签页 —— 而那不叫退出。它仍然不是凭据路径：cookie 的作废由签发
它的服务决定，这边只负责把那个 `Set-Cookie` 原样带回来。

**登录之后多出来的功能只有一个**：认出哪一架飞机是你的。数据源里每架飞机的
`cid` 就是成员的 CAN ID（`user.username`，can-fsd 登录时就是拿它查的表），所以
一个字符串比较就够了 —— 一个字节的额外数据都不用要。认出来之后：地图上那架戴
一个品牌色的圈、名单里那一行有个记号，以及可以让画面一直跟着它（拖动地图就停，
这个选择记在浏览器里）。

### 环境变量

| 变量             | 作用                       | 不设的话                        |
| ---------------- | -------------------------- | ------------------------------- |
| `CAN_API_ORIGIN` | 航迹、天气、会话都问它     | `https://api.ceruleanavi.net`   |
| `CAN_WEB_ORIGIN` | 页眉导航和登录入口指向哪儿 | `https://ceruleanavi.net`       |
| `PUBLIC_ORIGIN`  | 校验登出请求的 `Origin`    | `http://localhost:4323`（开发） |

`PUBLIC_ORIGIN` 在部署里**必须设**：不设的话它是开发机的地址，浏览器发来的
`Origin` 和它对不上，登出会稳定地 403。见 `src/server/guard.ts`。

## 部署

见 [`deploy/k8s.yaml`](deploy/k8s.yaml)（jyl-tyo，`radar.ceruleanavi.net`）。
`.github/workflows/deploy.yml` 出镜像并滚动 Deployment，走组织里那份可复用工
作流。上线不再需要手工 `rollout restart` —— 那一步没有部署记录，也没人知道线
上跑的是哪个 commit。集群的 kubectl 走 Omni 的 OIDC，CI 里非交互地过不去，所
以 CI 用的是直连 API server 的 `deployer` 服务账号（`KUBECONFIG_B64`）。
