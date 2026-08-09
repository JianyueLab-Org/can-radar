# data/

**这里已经没有导航数据了。**

`navdata/` 曾经在这个目录（用 `NAVDATA_DIR` 在运行时挂进来），因为
`/api/v1/route` 是在这个站点里解析航路的。那件事搬去 can-api 了：这个站点是全网
最公开、最没有登录的页面，不该在自己的部署里躺着一份商业 AIRAC 派生数据 —— 和
`/api/v1/track` 当初不搬过来是同一个判断，只是方向相反。

现在 `src/pages/api/v1/route.ts` 只是一个转发，路径一个字没变。导航数据、解析
器和它的黄金对比测试都在 **can-api 的 `internal/navdata/`**；那批文件由集群里
一个卷挂到 can-api 上，见那边的 `deploy/k8s.yaml`。

上游没挂导航数据时会回 `503 navDataUnavailable`，透过来之后地图退回它本来就有
的那条「直飞目的地」弧线。这条降级路径从 can-web 时期就在，没有变。
