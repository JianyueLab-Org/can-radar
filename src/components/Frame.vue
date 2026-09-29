<script setup lang="ts">
/**
 * 站头：can-ui `CanFrame` 的 map 布局（56px、一条底边、无页脚）。
 *
 * 站头里没有地图控件：它们在 `Radar.vue` 里，和地图状态在同一个岛屿。
 * 留在这里的：
 *
 * - 导航里除了雷达自己，都在主站上，走 `site()`。
 * - 在别处登录完回到这个标签页时整页重载，见 `recheckSession`。
 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import {
  CanFrame,
  originsFromEnv,
  type FrameUser,
  type NavChild,
  type NavItem,
} from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import type { Member } from "@/lib/member";

const props = defineProps<{
  /** `header` 命名空间。 */
  messages: Record<string, unknown>;
  locale: string;
  pathname: string;
  member: Member | null;
  /** 主站地址（服务端的 `webOrigin()`）。 */
  siteOrigin: string;
  /** 服务端用 `signInUrl()` 拼好。 */
  signInHref: string;
}>();

const t = createTranslator(props.messages);
const origins = originsFromEnv(import.meta.env);

/** 主站上的一条路径。 */
const site = (path: string) => `${props.siteOrigin}${path}`;

const user = computed<FrameUser | null>(() =>
  props.member
    ? {
        name: props.member.name,
        id: props.member.username,
        rating: props.member.rating,
      }
    : null,
);

const nav = computed<NavItem[]>(() => [
  { name: t("onlineMap"), href: "/", icon: "viewfinderCircle" },
  { name: t("roster"), href: site("/roster"), icon: "users" },
  { name: t("activities"), href: site("/activities"), icon: "calendarDays" },
  { name: t("downloads"), href: site("/downloads"), icon: "arrowDownTray" },
]);

const profileItems = computed<NavChild[]>(() => [
  { name: t("panel"), href: site("/pilots"), icon: "paperAirplane" },
]);

/* 在别处登录完，回到这个标签页：真的有人了就整页重载。 */
const RECHECK_MS = 15000;
let lastCheck = 0;

async function recheckSession() {
  if (props.member || document.visibilityState !== "visible") return;
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
  <CanFrame
    layout="map"
    current="radar"
    :locale="locale"
    :pathname="pathname"
    :nav="nav"
    :user="user"
    :profile-items="profileItems"
    :sign-in-href="signInHref"
    after-sign-out="reload"
    :home-href="site('/')"
    :messages="messages"
    :origins="origins"
  >
    <slot />
  </CanFrame>
</template>
