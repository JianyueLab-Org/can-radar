// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * 在线雷达。从 can-web 拆出来的那一块，形状不变：Astro SSR + Vue 岛屿 +
 * Tailwind v4，地图是 Leaflet。
 *
 * `output: "server"` 是必须的：/api/v1/route 要在服务端读 data/navdata 下那几
 * 个几十兆的 gz，把航路解析成坐标。那些文件是按查找键排好序、就地二分的
 * （见 src/server/navdata.ts），预渲染没有意义。
 *
 * 这个站点**没有自己的登录**，也不该有：没有密码表单、没有会话格式、没有数据
 * 库口令。它只是认得出浏览器**本来就带着**的那枚网络会话 cookie（can-api 签
 * 的，Domain 是父域 `.ceruleanavi.net`），认出来之后能把你自己的那架飞机指出来。
 * 登录入口仍然只有主站一个，见 `src/server/session.ts`。
 */
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [vue()],

  /**
   * **必须关掉，否则登出那个 POST 永远是 403。**
   *
   * Astro 在 SSR 下默认开着 `checkOrigin`：它从 `Host` 头推出本站的 origin，
   * 再和浏览器发来的 `Origin` 比对。这个站跑在 TLS 终止的反代后面 —— 推出来
   * 的是 `http://radar.ceruleanavi.net`，浏览器发的是 `https://…`，**永远对不
   * 上**。can-web 从一开始就关掉了它，can-dev 是踩了才关的，而两边第一个撞上
   * 的都是登出。
   *
   * 在这个仓库里这一条是新长出来的：`/api/v1/signout` 之前，这个站点一个写操
   * 作都没有，所以这个默认值从来没有机会伤到人。
   *
   * 关掉不等于不检查 —— 写操作的 Origin 由 `src/server/guard.ts` 比对**显式
   * 配置**的 `PUBLIC_ORIGIN`，那个值不是从请求头推的，反代动不了它。
   */
  security: { checkOrigin: false },

  vite: {
    plugins: [tailwindcss()],

    /**
     * can-ui 发的是**源码**（`.vue` / `.ts` / `.css`）而不是构建产物。代价是必须
     * 告诉 Vite 不要把它当外部依赖：不加这行，SSR 会去 `require` 一个 `.vue`
     * 文件，首屏直接 500。
     */
    ssr: { noExternal: ["@jianyuelab-org/can-ui"] },
  },
});
