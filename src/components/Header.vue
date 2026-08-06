<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
const scrolled = ref(false);

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

function onScroll() {
  scrolled.value = window.scrollY > 8;
}

onMounted(() => {
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
});
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
</script>

<template>
  <header
    :class="[
      'sticky top-0 z-40 bg-chrome transition-shadow duration-200',
      scrolled
        ? 'border-b border-subtle shadow-card'
        : 'border-b border-transparent',
    ]"
  >
    <a
      href="#main-content"
      class="btn btn-primary sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50"
    >
      {{ t("skipToContent") }}
    </a>

    <nav
      aria-label="Global"
      class="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8"
    >
      <a :href="site('/')" class="-m-1.5 shrink-0 p-1.5">
        <span class="sr-only">Cerulean Aviation Network</span>
        <img
          alt="Cerulean Aviation Network"
          src="/logo-full.png"
          class="h-10 w-auto"
        />
      </a>

      <div class="hidden lg:ml-4 lg:flex lg:items-center lg:gap-1">
        <a
          v-for="item in navigation"
          :key="item.name"
          :href="
            item.href.startsWith('/') && item.href !== '/'
              ? site(item.href)
              : item.href
          "
          :aria-current="isActive(item.href) ? 'page' : undefined"
          :class="[
            'rounded-control px-3 py-2 text-sm font-semibold transition-colors',
            isActive(item.href)
              ? 'bg-surface-sunken text-airwaysn'
              : 'text-muted hover:bg-surface-sunken hover:text-ink',
          ]"
        >
          {{ item.name }}
        </a>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <div class="hidden sm:block">
          <ThemeLangControls :locale="locale" />
        </div>
        <a
          :href="site(loggedIn ? '/pilots' : '/signin')"
          class="btn btn-primary hidden px-4 py-2 sm:inline-flex"
        >
          {{ loggedIn ? t("panel") : t("signin") }}
          <Icon name="arrowRight" class="size-4" />
        </a>

        <button
          type="button"
          class="-mr-2 inline-flex size-10 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-sunken hover:text-ink lg:hidden"
          @click="mobileMenuOpen = true"
        >
          <span class="sr-only">{{ t("openMenu") }}</span>
          <Icon name="bars3" class="size-6" />
        </button>
      </div>
    </nav>

    <!-- Mobile menu. Deliberately not teleported: the sticky header already
         owns the top stacking context, and Teleport does not survive Astro's
         Vue SSR pass cleanly. -->
    <div
      v-if="mobileMenuOpen"
      class="lg:hidden"
      role="dialog"
      aria-modal="true"
      :aria-label="t('openMenu')"
    >
      <div
        class="animate-overlay-in fixed inset-0 z-50 bg-gray-900/40 backdrop-blur-sm"
        @click="mobileMenuOpen = false"
      ></div>
      <div
        ref="mobilePanel"
        tabindex="-1"
        class="animate-drawer-in-right fixed inset-y-0 right-0 z-50 flex w-full max-w-xs flex-col overflow-y-auto overscroll-contain border-l border-subtle bg-surface px-6 py-5 shadow-popover"
      >
        <div class="flex items-center justify-between">
          <a :href="site('/')" class="-m-1.5 p-1.5">
            <span class="sr-only">Cerulean Aviation Network</span>
            <img alt="" src="/logo-full.png" class="h-10 w-auto" />
          </a>
          <button
            type="button"
            class="-mr-2 inline-flex size-10 items-center justify-center rounded-control text-muted hover:bg-surface-sunken hover:text-ink"
            @click="mobileMenuOpen = false"
          >
            <span class="sr-only">{{ t("closeMenu") }}</span>
            <Icon name="xMark" class="size-6" />
          </button>
        </div>

        <div class="mt-6 flex flex-col gap-1">
          <a
            :href="site('/')"
            :class="[
              'rounded-control px-3 py-2.5 text-base font-semibold transition-colors',
              pathname === '/'
                ? 'bg-surface-sunken text-airwaysn'
                : 'text-ink hover:bg-surface-sunken',
            ]"
          >
            {{ t("home") }}
          </a>
          <a
            v-for="item in navigation"
            :key="item.name"
            :href="
              item.href.startsWith('/') && item.href !== '/'
                ? site(item.href)
                : item.href
            "
            :class="[
              'rounded-control px-3 py-2.5 text-base font-semibold transition-colors',
              isActive(item.href)
                ? 'bg-surface-sunken text-airwaysn'
                : 'text-ink hover:bg-surface-sunken',
            ]"
          >
            {{ item.name }}
          </a>
        </div>

        <div class="mt-6 border-t border-subtle pt-6">
          <a
            :href="site(loggedIn ? '/pilots' : '/signin')"
            class="btn btn-primary w-full px-4 py-2.5"
          >
            {{ loggedIn ? t("panel") : t("signin") }}
            <Icon name="arrowRight" class="size-4" />
          </a>
        </div>

        <div class="mt-auto pt-6">
          <ThemeLangControls :locale="locale" />
        </div>
      </div>
    </div>
  </header>
</template>
