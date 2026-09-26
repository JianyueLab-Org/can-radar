<script setup lang="ts">
/**
 * 站头 —— can-ui `SiteHeader` 的 `compact` 版，外加这个站自己才有的三件事。
 *
 * 56px、贴底色、只有一条发丝底边、选中项在下沿画一道品牌色：那是照
 * vatsim-radar 的 `ViewHeader` 定下的形状，现在是 `variant="compact"`，住在
 * can-ui 里。这一页的主体是一张铺满屏幕的地图，站头越像一条边框、越不像一块面
 * 板，地图就越像是从屏幕边缘开始的。不吸顶、不监听滚动：这一页的 body 永远不滚。
 *
 * 站头里**没有地图控件**，从来没有过 —— 地图自己的控件都在 `Radar.vue` 里。
 * 留在这一层的：
 *
 * - **导航指向主站。** 名册、活动、下载都在 `siteOrigin` 上，只有「雷达」是本
 *   站。写相对路径会打在雷达自己的域名上然后 404。
 * - **在别处登录完回到这个标签页**，见 `recheckSession`。
 * - **登出后整页重载**，而不是把 `loggedIn` 改成 false：会话是服务端渲染时读进
 *   来的 prop，雷达岛屿里的「我的飞机」也拿着它。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Icon,
  SiteHeader,
  type NavChild,
  type SiteOrigins,
} from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";

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
    /** 主站的地址。这排导航里除了雷达自己，全在主站上。 */
    siteOrigin?: string;
    /** 「全网」菜单里其他站的地址，本地开发时覆盖成 :43xx，见 index.astro。 */
    origins?: SiteOrigins;
  }>(),
  {
    memberName: "",
    rating: undefined,
    pathname: "",
    locale: "zh-cn",
    siteOrigin: "https://ceruleanavi.net",
  },
);

/** 主站上的一条路径。本站只有雷达自己一个页面。 */
const site = (path: string) => `${props.siteOrigin}${path}`;

const t = createTranslator(props.messages);
const signingOut = ref(false);

const navigation = computed<NavChild[]>(() => [
  { name: t("onlineMap"), href: "/" }, // 就是本站
  { name: t("roster"), href: site("/roster") },
  { name: t("activities"), href: site("/activities") },
  { name: t("downloads"), href: site("/downloads") },
]);

const labels = computed(() => ({
  skip: t("skipToContent"),
  menu: t("openMenu"),
  close: t("closeMenu"),
  signIn: t("signin"),
  signOut: t("signout"),
}));

// 名字在按钮左边，不在按钮里：按钮去的是主站的飞行员面板，而名字回答的是「这一
// 页认得我吗」。塞进同一个控件里，两件事都说不清楚。
const ctaHref = computed(() => site(props.loggedIn ? "/pilots" : "/signin"));
const ctaLabel = computed(() => (props.loggedIn ? t("panel") : t("signin")));

/**
 * 登出。成功之后**整页重载**：让服务端重新渲染一次是唯一能保证整页一致的做法，
 * 也顺手证明了 cookie 真的清掉了。
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

/* ------------------------------------------------------------------ *
 * 在别处登录完，回到这个标签页
 *
 * 登录入口在主站，所以「登录」是一个跳走的链接。人在那边登录完切回来时，浏览
 * 器里已经有会话 cookie 了 —— 但这一页是十分钟前渲染的，它并不知道。于是标签页
 * 重新拿到焦点时问一次本站的 `/api/v1/session`，真的有人了就整页重载。
 *
 * **只在这一页认为没登录时才问**：这是唯一会变的方向。反过来不值得为它每次切
 * 回来都打一次请求，何况把人正在看的地图刷掉更烦人。
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
  <SiteHeader
    current="radar"
    variant="compact"
    :locale="locale"
    :pathname="pathname"
    :nav="navigation"
    :signed-in="loggedIn"
    :rating="rating"
    :home-href="site('/')"
    :labels="labels"
    :origins="origins"
  >
    <template #account>
      <span
        v-if="loggedIn && memberName"
        class="hidden max-w-40 truncate text-sm text-muted lg:inline"
      >
        {{ memberName }}
      </span>
      <a :href="ctaHref" class="btn btn-primary px-3 py-1.5 text-sm">
        {{ ctaLabel }}
      </a>
      <button
        v-if="loggedIn"
        type="button"
        class="focus-ring icon-button"
        :disabled="signingOut"
        :title="t('signout')"
        @click="signOut"
      >
        <span class="sr-only">{{ t("signout") }}</span>
        <Icon name="arrowRightOnRectangle" class="size-5" />
      </button>
    </template>

    <template #drawer-extra>
      <p v-if="loggedIn && memberName" class="px-3 text-sm text-faint">
        {{ memberName }}
      </p>
      <a :href="ctaHref" class="btn btn-primary w-full px-4 py-2.5">
        {{ ctaLabel }}
        <Icon name="arrowRight" class="size-4" />
      </a>
      <button
        v-if="loggedIn"
        type="button"
        class="btn btn-ghost w-full px-4 py-2.5"
        :disabled="signingOut"
        @click="signOut"
      >
        <Icon name="arrowRightOnRectangle" class="size-4" />
        {{ t("signout") }}
      </button>
    </template>
  </SiteHeader>
</template>
