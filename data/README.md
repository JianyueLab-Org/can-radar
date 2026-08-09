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

## 本地要看真正的航路时怎么生成

降级弧线是一条直线，看不出 SID/STAR 和航路的形状 —— 想看真的，自己生成一份。
**源数据就在这个 monorepo 里**，不用去别处找：`Sector/NavData/` 下那八个
`PSS*.dat` 正是生成脚本要的东西（脚本里写死的默认路径 `C:/Docs/ATC/Sector/
NavData` 是同一批文件在 Windows 上的位置）。

```bash
cd ../can-web
node scripts/build-navdata.mjs "$PWD/../Sector/NavData"    # 约 20 秒
```

它会写进 **can-web 的** `data/navdata/`（脚本里写死的输出目录）。把它挪到这个
公开仓库之外的任何地方，然后指过去：

```bash
NAVDATA_DIR=/absolute/path/to/navdata bun run dev
```

**别把生成结果留在 can-radar 的工作区里。** 它是商业 AIRAC 派生物，而这个仓库
公开 —— 上面整段说的就是这件事。`.gitignore` 只挡了 `data/navdata/` 这一个路径，
换个目录名就挡不住了。

> monorepo 根目录的 `CLAUDE.md` 说这批文件「已提交进 can-web」。至少在现在的检
> 出里**没有** —— can-web 只有生成脚本。所以那句话不能当成「clone 下来就有」。
