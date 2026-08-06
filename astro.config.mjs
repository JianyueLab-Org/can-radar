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
 * 这个站点**没有登录**，也不该有。它在 can-web 里的时候就不在
 * PROTECTED_PREFIXES 里，数据全部来自 can-fsd 的公开数据源。
 */
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [vue()],
  vite: { plugins: [tailwindcss()] },
});
