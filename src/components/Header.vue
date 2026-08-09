<script setup lang="ts">
/**
 * 站头。
 *
 * 照 vatsim-radar 的 `ViewHeader` 重做过：56px 高、贴着底色、只有一条发丝底边，
 * 选中的那一项在**下沿**画 2px 的品牌色而不是给自己一块圆角底。理由是这一页的
 * 主体是一张占满屏幕的地图 —— 站头越像一条边框、越不像一块面板，地图就越像是从
 * 屏幕边缘开始的。
 *
 * 原来那份是 can-web 的镜像（h-16、滚动加阴影、活动项一块底色）。**这个站的站头
 * 从此不再是那份镜像**，因为它跟着地图走；另外两个站的那一份没有动。
 *
 * 滚动阴影也跟着去掉了：这一页的 body 永远不滚（`h-dvh overflow-hidden`），那个
 * 监听器从拆分出来的第一天起就没有触发过。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { useOverlay } from "@/lib/useOverlay";
import Icon from "@/components/ui/Icon.vue";
import ThemeLangControls from "@/components/ui/ThemeLangControls.vue";

const props = withDefaults(
  defineProps<{
    loggedIn: boolean;
    messages: Record<string, unknown>;
    /** Current path, used to mark the active nav item. */
    pathname?: string;
    locale?: string;
    /**
     * 主站的地址。
     *
     * 雷达拆出来之后跑在 radar.airwaysn.org，是一个**独立的源**，而这排导航
     * 指向的名册、活动、下载、面板全都在主站上。留着相对路径的话，每一个链接
     * 都会打在雷达自己的域名上然后 404。
     */
    siteOrigin?: string;
  }>(),
  { pathname: "", locale: "zh-cn", siteOrigin: "https://airwaysn.org" },
);

/** 主站上的一条路径。本站只有雷达自己一个页面。 */
const site = (path: string) => `${props.siteOrigin}${path}`;

const t = createTranslator(props.messages);
const mobileMenuOpen = ref(false);

// Escape to close, focus trapped inside, focus returned to the trigger.
const mobilePanel = useOverlay(mobileMenuOpen);

const navigation = computed(() => [
  { name: t("onlineMap"), href: "/" }, // 就是本站
  { name: t("roster"), href: "/roster" },
  { name: t("activities"), href: "/activities" },
  { name: t("downloads"), href: "/downloads" },
  { name: t("docs"), href: "/docs" },
]);

function isActive(href: string) {
  if (!props.pathname) return false;
  const path = props.pathname.replace(/\/+$/, "") || "/";
  const target = href.replace(/\/+$/, "") || "/";
  return path === target || path.startsWith(`${target}/`);
}

/** 主站上的一条导航路径。`/` 是本站自己，不要拼成外链。 */
function navHref(href: string) {
  return href.startsWith("/") && href !== "/" ? site(href) : href;
}
</script>

<template>
  <header class="vh">
    <a href="#main-content" class="vh_skip">{{ t("skipToContent") }}</a>

    <nav class="vh_nav" aria-label="Global">
      <a :href="site('/')" class="vh_logo">
        <span class="sr-only">Cerulean Aviation Network</span>
        <img alt="" src="/logo-full.png" />
      </a>

      <div class="vh_links">
        <a
          v-for="item in navigation"
          :key="item.name"
          class="vh_link"
          :class="{ 'vh_link--active': isActive(item.href) }"
          :href="navHref(item.href)"
          :aria-current="isActive(item.href) ? 'page' : undefined"
        >
          {{ item.name }}
        </a>
      </div>

      <div class="vh_right">
        <div class="vh_section vh_section--controls">
          <ThemeLangControls :locale="locale" />
        </div>

        <div class="vh_section">
          <a class="vh_cta" :href="site(loggedIn ? '/pilots' : '/signin')">
            {{ loggedIn ? t("panel") : t("signin") }}
          </a>
        </div>

        <button type="button" class="vh_burger" @click="mobileMenuOpen = true">
          <span class="sr-only">{{ t("openMenu") }}</span>
          <Icon name="bars3" />
        </button>
      </div>
    </nav>

    <!-- Mobile menu. Deliberately not teleported: the sticky header already
         owns the top stacking context, and Teleport does not survive Astro's
         Vue SSR pass cleanly. -->
    <div
      v-if="mobileMenuOpen"
      class="vh_mobile"
      role="dialog"
      aria-modal="true"
      :aria-label="t('openMenu')"
    >
      <div class="vh_mobile_scrim" @click="mobileMenuOpen = false"></div>
      <div ref="mobilePanel" tabindex="-1" class="vh_mobile_panel">
        <div class="vh_mobile_head">
          <a :href="site('/')" class="vh_logo">
            <span class="sr-only">Cerulean Aviation Network</span>
            <img alt="" src="/logo-full.png" />
          </a>
          <button
            type="button"
            class="vh_burger"
            @click="mobileMenuOpen = false"
          >
            <span class="sr-only">{{ t("closeMenu") }}</span>
            <Icon name="xMark" />
          </button>
        </div>

        <div class="vh_mobile_links">
          <a
            :href="site('/')"
            class="vh_mobile_link"
            :class="{ 'vh_mobile_link--active': pathname === '/' }"
          >
            {{ t("home") }}
          </a>
          <a
            v-for="item in navigation"
            :key="item.name"
            class="vh_mobile_link"
            :class="{ 'vh_mobile_link--active': isActive(item.href) }"
            :href="navHref(item.href)"
          >
            {{ item.name }}
          </a>
        </div>

        <div class="vh_mobile_cta">
          <a
            class="vh_cta vh_cta--block"
            :href="site(loggedIn ? '/pilots' : '/signin')"
          >
            {{ loggedIn ? t("panel") : t("signin") }}
            <Icon name="arrowRight" />
          </a>
        </div>

        <div class="vh_mobile_foot">
          <ThemeLangControls :locale="locale" />
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.vh {
  position: relative;
  z-index: 40;
  flex: none;
  border-bottom: 1px solid var(--vr-stroke);
  background: var(--vr-bg);
}

.vh_skip {
  position: absolute;
  left: -9999px;
}
.vh_skip:focus {
  position: absolute;
  z-index: 50;
  top: 10px;
  left: 12px;

  padding: 8px 16px;
  border-radius: var(--radius-control);

  font-size: 13px;
  color: #fff;

  background: var(--vr-brand);
}

.vh_nav {
  display: flex;
  gap: 8px;
  align-items: stretch;

  height: 56px;
  padding: 0 8px;
}

.vh_logo {
  display: flex;
  flex: none;
  align-items: center;
  padding: 0 8px;
}
.vh_logo img {
  width: auto;
  height: 30px;
}

/* ——— 主导航 ——— */

.vh_links {
  display: none;
  align-items: stretch;
  margin-left: 24px;
}

@media (min-width: 1024px) {
  .vh_links {
    display: flex;
  }
}

.vh_link {
  position: relative;

  display: flex;
  align-items: center;

  padding: 8px 16px;

  font-size: 14px;
  font-weight: 500;
  color: var(--vr-t3);
  text-decoration: none;
  white-space: nowrap;

  transition:
    color 0.3s ease,
    background-color 0.3s ease;
}

.vh_link::after {
  content: "";

  position: absolute;
  bottom: -1px;
  left: 0;

  width: 100%;
  height: 0;

  background: var(--vr-brand);

  transition: height 0.3s ease;
}

.vh_link:hover {
  color: var(--vr-t1);
  background: var(--vr-alpha-4);
}

.vh_link--active {
  color: var(--vr-t1);
}
.vh_link--active::after {
  height: 2px;
}

/* ——— 右侧 ——— */

.vh_right {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-left: auto;
}

/* 每一组之间一条竖线，而不是靠间距分组 —— vatsim-radar 的做法。主题/语言和登录
   是两件不同性质的事，间距分不出这一点。 */
.vh_section {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: center;
}
.vh_section + .vh_section {
  padding-left: 12px;
}
.vh_section + .vh_section::before {
  content: "";

  position: absolute;
  top: calc(50% - 12px);
  left: 0;

  height: 24px;
  border-left: 1px solid var(--vr-alpha-12);
}

/* 小屏上主题/语言那一组收起来，它在移动菜单的底部还有一份。 */
.vh_section--controls {
  display: none;
}
@media (min-width: 640px) {
  .vh_section--controls {
    display: flex;
  }
}

.vh_cta {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  justify-content: center;

  min-height: 32px;
  padding: 6px 14px;
  border-radius: var(--radius-control);

  font-size: 13px;
  font-weight: 500;
  color: #fff;
  text-decoration: none;
  white-space: nowrap;

  background: var(--vr-brand);

  transition: background-color 0.3s ease;
}
.vh_cta:hover {
  background: var(--vr-brand-hover);
}
.vh_cta :deep(svg) {
  width: 14px;
  height: 14px;
}
.vh_cta--block {
  width: 100%;
  min-height: 40px;
}

.vh_burger {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-control);

  color: var(--vr-t3);

  background: transparent;
  cursor: pointer;

  transition:
    color 0.3s ease,
    background-color 0.3s ease;
}
.vh_burger:hover {
  color: var(--vr-t1);
  background: var(--vr-alpha-8);
}
.vh_burger :deep(svg) {
  width: 20px;
  height: 20px;
}
@media (min-width: 1024px) {
  .vh_burger {
    display: none;
  }
}

/* ——— 移动菜单 ——— */

.vh_mobile_scrim {
  position: fixed;
  z-index: 50;
  inset: 0;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
  animation: vh-fade 0.2s ease both;
}

.vh_mobile_panel {
  position: fixed;
  z-index: 50;
  inset-block: 0;
  right: 0;

  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;

  width: 100%;
  max-width: 300px;
  padding: 12px 16px 20px;
  border-left: 1px solid var(--vr-stroke);

  background: var(--vr-bg);

  animation: vh-slide 0.22s ease both;
}

@keyframes vh-fade {
  from {
    opacity: 0;
  }
}
@keyframes vh-slide {
  from {
    transform: translateX(100%);
  }
}

.vh_mobile_head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.vh_mobile_links {
  display: flex;
  flex-direction: column;
  margin-top: 20px;
}

.vh_mobile_link {
  position: relative;

  padding: 12px 12px;
  border-radius: var(--radius-control);

  font-size: 15px;
  font-weight: 500;
  color: var(--vr-t2);
  text-decoration: none;
}
.vh_mobile_link:hover {
  background: var(--vr-alpha-8);
}
.vh_mobile_link--active {
  color: var(--vr-t1);
  box-shadow: inset 2px 0 0 var(--vr-brand);
}

.vh_mobile_cta {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--vr-stroke);
}

.vh_mobile_foot {
  margin-top: auto;
  padding-top: 20px;
}

@media (prefers-reduced-motion: reduce) {
  .vh_mobile_scrim,
  .vh_mobile_panel {
    animation: none;
  }
}
</style>
