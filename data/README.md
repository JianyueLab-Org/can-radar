# data/

`navdata/` 是**故意不在这个仓库里**的。

它是把 `BOTP2G BOTPU W47 VEXEB` 这样一串航路变成地图上一条线的东西，由
can-web 的 `scripts/build-navdata.mjs` 从一个 AIRAC 周期生成。那批文件是商业
导航数据库的派生物 —— can-web 把它们提交进自己仓库的唯一理由是那个仓库私有，
而**这个仓库是公开的**。

运行时用 `NAVDATA_DIR` 指过去：

```bash
NAVDATA_DIR=/srv/navdata bun run start
```

集群里由一个挂载卷提供，见 `deploy/k8s.yaml`。

文件不在也不会坏：`/api/v1/route` 回 `503 navDataUnavailable`，地图退回它本来
就有的那条「直飞目的地」弧线。这是 can-web 时期就设计好的降级路径。
