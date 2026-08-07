# can-radar — CAN 在线雷达

Cerulean Aviation Network 的在线雷达，从 can-web 拆出来的那一块。
Astro SSR + Vue 岛屿 + Tailwind v4 + Leaflet，形状和 can-web / can-dev 一致。

**没有登录**，也不该有：数据全部来自 can-fsd 的公开数据源，它在 can-web 里的
时候就不在 `PROTECTED_PREFIXES` 里。

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
| 在线飞机与管制席位 | can-fsd 的数据源 `https://data.airwaysn.org/v1/data.json`，浏览器直接读    |
| 已飞航迹           | 本站 `/api/v1/track` —— **一个转发**，真正读 `flightPosition` 的是 can-api |
| 航路解析           | 本站 `/api/v1/route`，服务端读 `data/navdata`                              |

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
- 页眉里的导航指回主站（`siteOrigin`，默认 `https://airwaysn.org`）：这里是另
  一个源，相对路径会打在雷达自己的域名上然后 404。
- 拿不到主站的会话（HttpOnly，绑在 airwaysn.org 上），所以页眉一律按未登录渲
  染。点过去落在主站，本来就登录着的人会直接进面板。

## 部署

见 [`deploy/k8s.yaml`](deploy/k8s.yaml)（jyl-tyo，`radar.airwaysn.org`）。
`.github/workflows/deploy.yml` 出镜像并滚动 Deployment，走组织里那份可复用工
作流。上线不再需要手工 `rollout restart` —— 那一步没有部署记录，也没人知道线
上跑的是哪个 commit。集群的 kubectl 走 Omni 的 OIDC，CI 里非交互地过不去，所
以 CI 用的是直连 API server 的 `deployer` 服务账号（`KUBECONFIG_B64`）。
