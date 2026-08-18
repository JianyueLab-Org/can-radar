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
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import {
  Icon,
  Logo,
  NetworkMenu,
  ThemeLangControls,
  sectionHeadings,
  useOverlay,
  visibleSites,
} from "@jianyuelab-org/can-ui";

const props = withDefaults(
  defineProps<{
    loggedIn: boolean;
    /** 登录着的人的名字，只用来在页眉上显示。空字符串就只显示按钮。 */
    memberName?: string;
    /**
     * 会话等级，只喂给「全网」菜单，决定门户那一条露不露。
     *
     * 可选，缺了就当作没有 —— `visibleSites` 在这种情况下显示得**更少**而不是更
     * 多。这一页大多数访客是登出的，所以这是常态而不是异常。
     */
    rating?: number;
    messages: Record<string, unknown>;
    /** Current path, used to mark the active nav item. */
    pathname?: string;
    locale?: string;
    /**
     * 主站的地址。
     *
     * 雷达拆出来之后跑在 radar.ceruleanavi.net，是一个**独立的源**，而这排导航
     * 指向的名册、活动、下载、面板全都在主站上。留着相对路径的话，每一个链接
     * 都会打在雷达自己的域名上然后 404。
     */
    siteOrigin?: string;
  }>(),
  {
    memberName: "",
    pathname: "",
    locale: "zh-cn",
    siteOrigin: "https://ceruleanavi.net",
  },
);

/** 主站上的一条路径。本站只有雷达自己一个页面。 */
const site = (path: string) => `${props.siteOrigin}${path}`;

const t = createTranslator(props.messages);
const mobileMenuOpen = ref(false);
const signingOut = ref(false);

/**
 * 登出。
 *
 * 成功之后**整页重载**，而不是把 `loggedIn` 改成 false：会话是服务端渲染时读
 * 进来的 prop，页面上还有别处（雷达岛屿里的「我的飞机」）也拿着它。让服务端重
 * 新渲染一次是唯一能保证整页一致的做法，也顺手证明了 cookie 真的清掉了。
 */
async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await fetch("/api/v1/signout", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch {
    // 网络断了。下面照样重载 —— 会话还在的话，页面会重新渲染成登录着的样子，
    // 那正是此刻的事实，比一个「已退出」的假象诚实。
  }
  window.location.reload();
}

// Escape to close, focus trapped inside, focus returned to the trigger.
const mobilePanel = useOverlay(mobileMenuOpen);

/**
 * 这一排是**主站上的页面**，不是站点。
 *
 * 「文档」从这里去掉了：会员文档是一个独立的站（docs.ceruleanavi.net），它现在在
 * 「全网」菜单里，而且是直链。原来这一条写的是 `/docs`，经 `navHref` 拼成主站的
 * `/docs` —— 那个地址今天只剩一个转发页，于是每次点击都是 301 之后再一次请求。
 */
const navigation = computed(() => [
  { name: t("onlineMap"), href: "/" }, // 就是本站
  { name: t("roster"), href: "/roster" },
  { name: t("activities"), href: "/activities" },
  { name: t("downloads"), href: "/downloads" },
]);

/** 「全网」这个词也来自 can-ui —— 它命名的是网络，不是这个站。 */
const networkLabel = computed(() => sectionHeadings(props.locale).menuLabel);

/**
 * 「全网」菜单在手机上没有下拉可用（弹层会被抽屉盖住），所以抽屉里直接把这几条
 * 铺开。数据是同一份 `visibleSites`，只是换个画法 —— 两处各自维护一张清单，正是
 * 这次要消掉的东西。
 */
const networkSites = computed(() =>
  visibleSites({
    locale: props.locale,
    current: "radar",
    rating: props.rating,
    signedIn: props.loggedIn,
    excludeCurrent: true,
  }),
);

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

/* ------------------------------------------------------------------ *
 * 在别处登录完，回到这个标签页
 *
 * 登录入口在主站，所以「登录」是一个跳走的链接（这个站点没有密码表单，也不该
 * 有）。人在那边登录完切回来时，浏览器里已经有会话 cookie 了 —— 但这一页是十
 * 分钟前渲染的，它并不知道。
 *
 * 于是标签页重新拿到焦点时问一次本站的 `/api/v1/session`，真的有人了就整页重
 * 载，让服务端重新渲染。少了这一步，唯一的出路是让人自己按刷新，而「我明明登
 * 录了」是一种没有人会去报的 bug。
 *
 * **只在这一页认为没登录时才问**：这是唯一会变的方向。反过来（会话在别处被登
 * 出）不值得为它每次切回来都打一次请求，何况把人正在看的地图刷掉更烦人。
 * ------------------------------------------------------------------ */

/** 两次探测之间至少隔这么久。切标签页是个高频动作。 */
const RECHECK_MS = 15000;
let lastCheck = 0;

async function recheckSession() {
  if (props.loggedIn || document.visibilityState !== "visible") return;

  const now = Date.now();
  if (now - lastCheck < RECHECK_MS) return;
  lastCheck = now;

  try {
    const response = await fetch("/api/v1/session", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const body = (await response.json()) as { user?: unknown };
    if (body.user) window.location.reload();
  } catch {
    // 断网、限流。下次切回来再说。
  }
}

onMounted(() => {
  document.addEventListener("visibilitychange", recheckSession);
  window.addEventListener("focus", recheckSession);
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", recheckSession);
  window.removeEventListener("focus", recheckSession);
});
</script>

<template>
  <header class="vh">
    <a href="#main-content" class="vh_skip">{{ t("skipToContent") }}</a>

    <nav class="vh_nav" aria-label="Global">
      <a :href="site('/')" class="vh_logo">
        <span class="sr-only">Cerulean Aviation Network</span>
        <Logo alt="" />
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
          <!-- 这一页在拆分之后曾经是全网跨站链接最少的一个：除了主站，哪儿也去
               不了。菜单本身来自 can-ui，所以这里不再有第二份「网络上有哪些站」
               的清单。 -->
          <NetworkMenu
            :locale="locale"
            current="radar"
            :rating="rating"
            :signed-in="loggedIn"
          />
          <ThemeLangControls :locale="locale" />
        </div>

        <div class="vh_section">
          <!-- 名字在按钮左边，不在按钮里：那个按钮去的是主站的飞行员面板，而
               名字回答的是「这一页认得我吗」。塞进同一个控件里，两件事都说不
               清楚。 -->
          <span v-if="loggedIn && memberName" class="vh_who">
            {{ memberName }}
          </span>
          <a class="vh_cta" :href="site(loggedIn ? '/pilots' : '/signin')">
            {{ loggedIn ? t("panel") : t("signin") }}
          </a>
          <button
            v-if="loggedIn"
            type="button"
            class="vh_burger vh_signout"
            :disabled="signingOut"
            :title="t('signout')"
            @click="signOut"
          >
            <span class="sr-only">{{ t("signout") }}</span>
            <Icon name="arrowRightOnRectangle" />
          </button>
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
            <Logo alt="" />
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

          <!-- 全网。桌面上这是一个下拉；在抽屉里铺开，因为一个弹层从抽屉里弹出
               来只会被抽屉自己盖住。 -->
          <template v-if="networkSites.length">
            <div class="vh_mobile_sep">{{ networkLabel }}</div>
            <a
              v-for="site in networkSites"
              :key="site.key"
              class="vh_mobile_link"
              :href="site.href"
            >
              {{ site.name }}
            </a>
          </template>
        </div>

        <div class="vh_mobile_cta">
          <span v-if="loggedIn && memberName" class="vh_who vh_who--block">
            {{ memberName }}
          </span>
          <a
            class="vh_cta vh_cta--block"
            :href="site(loggedIn ? '/pilots' : '/signin')"
          >
            {{ loggedIn ? t("panel") : t("signin") }}
            <Icon name="arrowRight" />
          </a>
          <button
            v-if="loggedIn"
            type="button"
            class="vh_mobile_link vh_mobile_signout"
            :disabled="signingOut"
            @click="signOut"
          >
            <Icon name="arrowRightOnRectangle" />
            {{ t("signout") }}
          </button>
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

/* ——— 登录着的那个人 ——— */

.vh_who {
  overflow: hidden;

  max-width: 12ch;

  font-size: 13px;
  color: var(--vr-t2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vh_who--block {
  display: block;
  max-width: none;
  margin-bottom: 10px;
  text-align: center;
}

/* 退出在这个宽度下是一个图标 —— 它和「飞行员面板」不是一个重量级的动作，给它
   同样大的一块会让人误点。小屏上收起来，移动菜单里有一条带文字的。 */
.vh_signout {
  display: none;
}
@media (min-width: 640px) {
  .vh_signout {
    display: inline-flex;
  }
}
.vh_signout:disabled {
  opacity: 0.5;
  cursor: default;
}

.vh_mobile_signout {
  display: flex;
  gap: 10px;
  align-items: center;

  width: 100%;
  margin-top: 8px;
  border: none;

  color: var(--vr-t3);

  background: transparent;
  cursor: pointer;
}
.vh_mobile_signout :deep(svg) {
  width: 18px;
  height: 18px;
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

.vh_mobile_sep {
  margin: 0.75rem 0 0.25rem;
  padding: 0 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-faint, #9ca3af);
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
