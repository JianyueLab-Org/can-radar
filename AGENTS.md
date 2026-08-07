# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CAN 在线雷达，从 can-web 拆出来。Astro SSR + Vue 岛屿 + Tailwind v4 + Leaflet。
没有登录。README 是给人读的那一份。

## 命令

```bash
bun run dev      # :4323（4321 can-web，4322 can-dev）
bun run lint     # format:check + astro check + vue-tsc
bun run build && bun run start
```

没有测试套件。门禁是 `bun run lint` 加一次 `bun run build`。
`astro check` 看不见 `.vue`，所以 `typecheck` 同时跑 `vue-tsc`——两个都要留着。

## 四条要紧的

**1. 导航数据不进这个仓库，也不进镜像。** AIRAC 派生的商业数据；can-web 敢提
交是因为那个仓库私有，**这个是公开的**。用 `NAVDATA_DIR` 在运行时挂。缺席时
`/api/v1/route` 回 503、地图退回直飞弧线，不会坏 —— 别为了「省事」把它打进镜
像层。

**2. 这个站点不碰数据库。** 航迹走 `/api/v1/track` 转发到 can-api。它是全网最
公开的页面，不该拿着数据库口令。想加新数据时先问：能不能让 can-api 或 can-fsd
去读。

**3. `radarTypes.ts` 是拷贝，两边都在用。** can-web 还要同一份数据源形状。改
它之前记得那边也有一份；真正防漂移的是 can-fsd 的 `datafeed_golden.json`。

**4. 页眉链接要走 `site()`。** 这里是另一个源，写 `href="/roster"` 会打在
radar.airwaysn.org 上然后 404。`siteOrigin` 默认指向主站。

## 别的

- `globals.css` 是从 can-web 整份搬来的，只去掉了 `@tailwindcss/typography`
  （那是给 /docs 长文用的，这里没有长文）。底部的 Leaflet 块是刻意写死的，
  别动 —— can-web 的 CLAUDE.md 也是这么说的。
- 部署见 `deploy/k8s.yaml`。镜像由 CI 推 GHCR，上线是手工 rollout restart：
  jyl-tyo 的 kubectl 走 Omni OIDC，CI 里过不去。
