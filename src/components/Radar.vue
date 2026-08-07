<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import RadarMap from "@/components/RadarMap.vue";
import RadarDetails from "@/components/RadarDetails.vue";
import { getFacilityName } from "@/lib/facilities";
import {
  altitudeColor,
  altitudeLegend,
  facilityColor,
  flightLevel,
} from "@/lib/radar";
import { createTranslator } from "@/lib/i18n";
import BaseBadge from "@/components/ui/BaseBadge.vue";
import Icon from "@/components/ui/Icon.vue";
import Skeleton from "@/components/ui/Skeleton.vue";
import { DATAFEED_URL, type ApiData } from "@/lib/radarTypes";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  readView,
  saveSettings,
  writeView,
  type RadarSettings,
} from "@/lib/radarState";
import {
  EMPTY_FILTER,
  activeAirports,
  isFiltering,
  matchesFilter,
  type TrafficFilter,
} from "@/lib/radarFilter";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const data = ref<ApiData | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const lastUpdate = ref<Date | null>(null);
const theme = ref<"dark" | "light">("light");

// The traffic list is a right rail on desktop and an overlay drawer below it,
// so the map is never squeezed into a sliver on a phone.
const panelOpen = ref(true);
const activeTab = ref<"controllers" | "pilots">("controllers");
/* 筛选是一个对象而不是一个字符串了：文字框只是它的一项，另外三项（高度层、起降
 * 机场）是下拉。**四项一起作用到列表和地图**，见 mapPilots。 */
const filter = ref<TrafficFilter>({ ...EMPTY_FILTER });

/** 这个人的偏好，跟着浏览器走。挂载后才读 —— SSR 时没有 localStorage。 */
const settings = ref<RadarSettings>({ ...DEFAULT_SETTINGS });
const settingsOpen = ref(false);

/** 从 URL 带进来的初始视图，只在挂载时读一次。 */
const initialView = ref(readView(""));

let interval: ReturnType<typeof setInterval> | null = null;
let observer: MutationObserver | null = null;

const lastUpdateLabel = computed(() =>
  lastUpdate.value ? lastUpdate.value.toLocaleTimeString() : t("never"),
);

async function fetchData() {
  try {
    loading.value = true;
    error.value = null;
    const response = await fetch(DATAFEED_URL);
    if (!response.ok) throw new Error(t("error"));
    data.value = (await response.json()) as ApiData;
    lastUpdate.value = new Date();
  } catch (err) {
    error.value = err instanceof Error ? err.message : t("error");
  } finally {
    loading.value = false;
  }
}

function syncTheme() {
  theme.value = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

/**
 * Escape closes whatever is stacked on top of the map.
 *
 * These two surfaces are the only overlays in the app not driven by
 * `useOverlay`, and deliberately so: below `lg` they float over the map behind
 * a backdrop, but from `lg` up they are static columns of the page, where a
 * body scroll lock and a focus trap would be wrong. Escape-to-close is the
 * part that is right at every width, so it is wired by hand here.
 *
 * The details panel is dismissed first — it is the one drawn over the drawer —
 * so a single press never closes both at once.
 */
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (selected.value) {
    selected.value = null;
  } else if (panelOpen.value && window.innerWidth < 1024) {
    // Above `lg` the drawer is page furniture, not an overlay; closing it on
    // Escape there would fight the user rather than help them.
    panelOpen.value = false;
  }
}

onMounted(() => {
  syncTheme();
  settings.value = loadSettings();

  // 先读 URL 再取数据：选中的那个键要在第一帧就传给地图，否则地图会先画一遍没有
  // 选中的画面再跳一次。
  initialView.value = readView(window.location.search);
  if (initialView.value.selected) selected.value = initialView.value.selected;
  // 跟随暗色模式切换（替代 next-themes 响应式）
  observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  // Start collapsed on small screens where the map needs the whole width.
  panelOpen.value = window.innerWidth >= 1024;

  document.addEventListener("keydown", onGlobalKeydown);
  fetchData();
  interval = setInterval(fetchData, 30000);
});

onBeforeUnmount(() => {
  if (interval) clearInterval(interval);
  if (observer) observer.disconnect();
  document.removeEventListener("keydown", onGlobalKeydown);
});

function matches(value: string | undefined): boolean {
  const needle = filter.value.text.trim().toLowerCase();
  if (!needle) return true;
  return (value ?? "").toLowerCase().includes(needle);
}

/**
 * Observers are dropped from the feed here, once, so nothing downstream has to
 * remember to exclude them: they work no position, own no airspace and cannot
 * be called, so they are not traffic — not on the map, not in the list, not in
 * the count.
 */
const OBSERVER_FACILITY = 0;

const controllers = computed(
  () =>
    data.value?.controllers.filter((c) => c.facility !== OBSERVER_FACILITY) ??
    [],
);

const filteredControllers = computed(() =>
  controllers.value.filter((c) => matches(c.callsign)),
);
const filteredPilots = computed(
  () => data.value?.pilots.filter((p) => matchesFilter(p, filter.value)) ?? [],
);

const filtering = computed(() => isFiltering(filter.value));

/** 下拉里只列**当前真的有交通**的机场，按架次排。 */
const departureOptions = computed(() =>
  activeAirports(data.value?.pilots ?? [], "departure"),
);
const arrivalOptions = computed(() =>
  activeAirports(data.value?.pilots ?? [], "arrival"),
);

function clearFilter() {
  filter.value = { ...EMPTY_FILTER };
}

/**
 * 地图上画哪些飞机。
 *
 * 就是筛出来的那批 —— 地图的增量同步会自己把不在列表里的标记撤掉，所以筛选天然
 * 同步到地图，不需要第二套逻辑。**唯一的例外是选中的那架**：把它筛掉之后详情面
 * 板还开着、地图上却没有它，那是一个自相矛盾的画面。
 */
const mapPilots = computed(() => {
  const visible = filteredPilots.value;
  const chosen = selectedPilot.value;
  if (!chosen) return visible;
  const key = chosen.cid || chosen.callsign;
  return visible.some((p) => (p.cid || p.callsign) === key)
    ? visible
    : [...visible, chosen];
});

const legend = computed(() => [
  // A hollow swatch, because that is exactly how coverage draws on the map.
  { label: t("legend.range"), class: "border border-airwaysn", ring: true },
  { label: t("legend.activeAreas"), class: "bg-success/70", ring: false },
  {
    label: t("legend.inactiveAreas"),
    class: "bg-[var(--color-faint)]/50",
    ring: false,
  },
]);

// Position tags are colour-coded by facility, so the legend spells the code
// out rather than describing it. Same order as the chips inside a tag.
const facilityLegend = [2, 3, 4, 5, 7, 6].map((facility) => ({
  label: getFacilityName(facility),
  color: facilityColor(facility),
}));

// Aircraft are coloured by altitude, so the legend has to say what the ramp
// means — otherwise the colour is decoration rather than information.
const altitudeScale = computed(() => altitudeLegend(theme.value));

/* Selection is shared between the list and the map: clicking either one
 * highlights the other, and the map opens that aircraft's popup. */
const mapRef = ref<InstanceType<typeof RadarMap> | null>(null);
const selected = ref<string | null>(null);

function select(key: string) {
  selected.value = selected.value === key ? null : key;
  if (selected.value) {
    mapRef.value?.focus(selected.value);
    // On a phone the list covers the map, and the details panel is about to
    // take the other side of it.
    if (window.innerWidth < 1024) panelOpen.value = false;
  }
}

/* The details panel renders whatever is selected. Resolving it from the live
 * data (rather than snapshotting on click) means the figures keep updating
 * while the aircraft is on screen. */
const selectedPilot = computed(() => {
  const key = selected.value;
  if (!key?.startsWith("pilot:")) return null;
  const id = key.slice("pilot:".length);
  return data.value?.pilots.find((p) => (p.cid || p.callsign) === id) ?? null;
});

const selectedStation = computed(() => {
  const key = selected.value;
  if (!key?.startsWith("atc:")) return null;
  const callsign = key.slice("atc:".length);
  return (
    controllers.value.find((c) => c.callsign === callsign) ??
    data.value?.atis.find((a) => a.callsign === callsign) ??
    null
  );
});

const selectedIsAtis = computed(
  () =>
    !!selectedStation.value &&
    !!data.value?.atis.some(
      (a) => a.callsign === selectedStation.value?.callsign,
    ),
);

/** 地图当前的中心和缩放，由地图的 moveend 回报。 */
const viewport = ref<{ lat: number; lon: number; zoom: number } | null>(null);

/**
 * 把「在看什么」写回地址栏。
 *
 * `replaceState` 而不是 `pushState`：地图每拖一下都进一次历史记录的话，返回键就
 * 变成了逐帧倒放，而人按返回是想离开这一页。
 *
 * 只有选中和视口进 URL，设置不进 —— 发给别人的链接不该把我的底图口味带过去。
 */
function syncUrl() {
  if (typeof window === "undefined") return;
  const query = writeView({
    selected: selected.value,
    lat: viewport.value?.lat ?? null,
    lon: viewport.value?.lon ?? null,
    zoom: viewport.value?.zoom ?? null,
  });
  window.history.replaceState(null, "", query || window.location.pathname);
}

function onMapMove(next: { lat: number; lon: number; zoom: number }) {
  viewport.value = next;
  syncUrl();
}

watch(selected, syncUrl);
watch(settings, (next) => saveSettings(next), { deep: true });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Status bar -->
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-subtle bg-surface-raised px-4 py-2"
    >
      <div class="flex items-center gap-2">
        <Icon name="signal" class="size-4 text-airwaysn" />
        <h1 class="text-sm font-semibold text-ink">{{ t("title") }}</h1>
      </div>

      <div class="flex items-center gap-2">
        <BaseBadge variant="info" size="sm">
          {{ controllers.length }} {{ t("controllers") }}
        </BaseBadge>
        <BaseBadge variant="success" size="sm" dot :pulse="!loading">
          {{ data?.pilots.length ?? 0 }} {{ t("pilots") }}
        </BaseBadge>
      </div>

      <ul
        class="hidden items-center gap-4 xl:flex"
        :aria-label="t('legendTitle')"
      >
        <li class="flex items-center gap-1">
          <span
            v-for="item in facilityLegend"
            :key="item.label"
            class="rounded px-1 py-px text-[10px] font-semibold text-white"
            :style="{ backgroundColor: item.color }"
          >
            {{ item.label }}
          </span>
        </li>
        <li
          v-for="item in legend"
          :key="item.label"
          class="flex items-center gap-1.5 text-xs text-muted"
        >
          <span
            :class="[
              'shrink-0 rounded-full',
              item.ring ? 'size-2.5' : 'size-2',
              item.class,
            ]"
            aria-hidden="true"
          ></span>
          {{ item.label }}
        </li>
        <li class="flex items-center gap-1.5 text-xs text-muted">
          <span>{{ t("legend.altitude") }}</span>
          <span class="flex items-center gap-px" aria-hidden="true">
            <span
              v-for="step in altitudeScale"
              :key="step.label"
              class="h-2 w-4"
              :style="{ backgroundColor: step.color }"
              :title="step.label"
            ></span>
          </span>
          <span class="tnum text-faint">
            {{ altitudeScale[0].label }}–{{
              altitudeScale[altitudeScale.length - 1].label
            }}
          </span>
        </li>
      </ul>

      <div class="ml-auto flex items-center gap-2">
        <span v-if="error" class="text-xs font-medium text-danger">
          {{ error }}
        </span>
        <span v-else class="hidden text-xs text-faint sm:inline">
          {{ t("lastUpdate") }} {{ lastUpdateLabel }}
        </span>

        <button
          type="button"
          class="btn btn-ghost size-8 p-0"
          :disabled="loading"
          :aria-label="t('refresh')"
          :title="t('refresh')"
          @click="fetchData"
        >
          <Icon
            name="arrowPath"
            :class="['size-4', loading ? 'animate-spin' : '']"
          />
        </button>

        <button
          type="button"
          class="btn btn-secondary px-2.5 py-1.5 text-xs"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        >
          <Icon name="cog6Tooth" class="size-4" />
          <span class="hidden sm:inline">{{ t("settings.title") }}</span>
        </button>

        <button
          type="button"
          class="btn btn-secondary px-2.5 py-1.5 text-xs"
          :aria-expanded="panelOpen"
          @click="panelOpen = !panelOpen"
        >
          <Icon name="bars3" class="size-4" />
          <span class="hidden sm:inline">
            {{ panelOpen ? t("hidePanel") : t("showPanel") }}
          </span>
        </button>
      </div>
    </div>

    <!-- Settings. A small popover rather than a drawer: it is four toggles and
         a radio group, and taking the whole side of the screen for that would
         push the map out of the way to change how the map looks. -->
    <div
      v-if="settingsOpen"
      class="border-line bg-surface absolute top-14 right-3 z-30 w-64 rounded-lg border p-3 shadow-lg"
      role="dialog"
      :aria-label="t('settings.title')"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">{{ t("settings.title") }}</span>
        <button
          type="button"
          class="btn btn-ghost p-1"
          :aria-label="t('settings.close')"
          @click="settingsOpen = false"
        >
          <Icon name="xMark" class="size-4" />
        </button>
      </div>

      <label class="text-muted mb-1 block text-xs">{{
        t("settings.basemap")
      }}</label>
      <select v-model="settings.basemap" class="input mb-3 w-full text-xs">
        <option value="auto">{{ t("settings.basemapAuto") }}</option>
        <option value="dark">{{ t("settings.basemapDark") }}</option>
        <option value="light">{{ t("settings.basemapLight") }}</option>
        <option value="satellite">{{ t("settings.basemapSatellite") }}</option>
      </select>

      <span class="text-muted mb-1 block text-xs">{{
        t("settings.layers")
      }}</span>
      <label class="mb-1 flex items-center gap-2 text-xs">
        <input v-model="settings.boundaries" type="checkbox" />
        {{ t("settings.boundaries") }}
      </label>
      <label class="mb-1 flex items-center gap-2 text-xs">
        <input v-model="settings.airportTags" type="checkbox" />
        {{ t("settings.airportTags") }}
      </label>
      <label class="mb-3 flex items-center gap-2 text-xs">
        <input v-model="settings.rangeRings" type="checkbox" />
        {{ t("settings.rangeRings") }}
      </label>

      <label class="text-muted mb-1 block text-xs">{{
        t("settings.units")
      }}</label>
      <select v-model="settings.units" class="input w-full text-xs">
        <option value="aviation">{{ t("settings.unitsAviation") }}</option>
        <option value="metric">{{ t("settings.unitsMetric") }}</option>
      </select>
    </div>

    <!-- Details + map + traffic list -->
    <div class="relative flex min-h-0 flex-1">
      <!-- Backdrop for the details panel, which overlays the map on a phone -->
      <div
        v-if="selectedPilot || selectedStation"
        class="animate-overlay-in absolute inset-0 z-10 bg-gray-900/40 backdrop-blur-sm lg:hidden"
        @click="selected = null"
      ></div>

      <RadarDetails
        :messages="messages"
        :pilot="selectedPilot"
        :controller="selectedStation"
        :is-atis="selectedIsAtis"
        :theme="theme"
        @close="selected = null"
        @locate="selected && mapRef?.focus(selected)"
      />

      <div class="relative min-w-0 flex-1">
        <RadarMap
          v-if="data"
          ref="mapRef"
          :controllers="controllers"
          :pilots="mapPilots"
          :atis="data.atis"
          :theme="theme"
          :selected="selected"
          :settings="settings"
          :initial-view="initialView"
          @select="selected = $event"
          @move="onMapMove"
        />
        <div
          v-else
          class="flex h-full items-center justify-center bg-surface-sunken"
        >
          <Skeleton
            v-if="loading"
            variant="text"
            :count="4"
            :label="t('loading')"
          />
          <p v-else class="text-sm text-muted">{{ t("noData") }}</p>
        </div>
      </div>

      <!-- Backdrop for the drawer form -->
      <div
        v-if="panelOpen"
        class="animate-overlay-in absolute inset-0 z-10 bg-gray-900/40 backdrop-blur-sm lg:hidden"
        @click="panelOpen = false"
      ></div>

      <aside
        v-if="panelOpen"
        class="animate-drawer-panel absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85vw] flex-col border-l border-subtle bg-surface-raised shadow-popover lg:static lg:z-0 lg:max-w-none lg:shadow-none"
      >
        <!-- Tabs -->
        <div class="flex shrink-0 border-b border-subtle">
          <button
            v-for="tab in ['controllers', 'pilots'] as const"
            :key="tab"
            type="button"
            :class="[
              'flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab
                ? 'border-airwaysn text-airwaysn'
                : 'border-transparent text-muted hover:text-ink',
            ]"
            @click="activeTab = tab"
          >
            {{ t(tab) }}
            <span class="ml-1 text-xs text-faint">
              {{
                tab === "controllers"
                  ? filteredControllers.length
                  : filteredPilots.length
              }}
            </span>
          </button>
        </div>

        <div class="shrink-0 border-b border-subtle p-3">
          <div class="relative">
            <Icon
              name="magnifyingGlass"
              class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
            />
            <input
              v-model="filter.text"
              type="search"
              :placeholder="t('searchPlaceholder')"
              :aria-label="t('searchPlaceholder')"
              class="input pl-9 text-sm"
            />
          </div>

          <!-- 三个下拉只在「飞机」页显示：高度和起降机场对席位没有意义，而一组
               永远灰着的控件比没有这组控件更让人费解。 -->
          <div
            v-if="activeTab === 'pilots'"
            class="mt-2 grid grid-cols-3 gap-1.5"
          >
            <select
              v-model="filter.altitude"
              class="input text-xs"
              :aria-label="t('filters.altitude')"
            >
              <option value="any">{{ t("filters.altitude") }}</option>
              <option value="ground">{{ t("filters.ground") }}</option>
              <option value="low">{{ t("filters.low") }}</option>
              <option value="mid">{{ t("filters.mid") }}</option>
              <option value="high">{{ t("filters.high") }}</option>
            </select>

            <select
              v-model="filter.departure"
              class="input text-xs"
              :aria-label="t('filters.departure')"
            >
              <option value="">{{ t("filters.departure") }}</option>
              <option
                v-for="a in departureOptions"
                :key="a.icao"
                :value="a.icao"
              >
                {{ a.icao }} ({{ a.count }})
              </option>
            </select>

            <select
              v-model="filter.arrival"
              class="input text-xs"
              :aria-label="t('filters.arrival')"
            >
              <option value="">{{ t("filters.arrival") }}</option>
              <option v-for="a in arrivalOptions" :key="a.icao" :value="a.icao">
                {{ a.icao }} ({{ a.count }})
              </option>
            </select>
          </div>

          <!-- 说清楚地图也跟着筛了。不说的话，看到地图上只剩三架的人第一反应是
               网络掉线了，而不是自己刚才选了个筛选条件。 -->
          <div
            v-if="filtering"
            class="mt-2 flex items-center justify-between text-xs"
          >
            <span class="text-muted">{{ t("filters.active") }}</span>
            <button
              type="button"
              class="btn btn-ghost px-2 py-0.5"
              @click="clearFilter"
            >
              {{ t("filters.clear") }}
            </button>
          </div>
        </div>

        <!-- Controllers -->
        <div
          v-if="activeTab === 'controllers'"
          class="min-h-0 flex-1 overflow-y-auto p-2"
        >
          <ul v-if="filteredControllers.length" role="list" class="space-y-1">
            <li
              v-for="(controller, index) in filteredControllers"
              :key="`${controller.callsign}-${index}`"
            >
              <button
                type="button"
                :class="[
                  'w-full rounded-control p-2.5 text-left transition-colors',
                  selected === `atc:${controller.callsign}`
                    ? 'bg-surface-sunken ring-1 ring-airwaysn'
                    : 'hover:bg-surface-sunken',
                ]"
                :aria-pressed="selected === `atc:${controller.callsign}`"
                @click="select(`atc:${controller.callsign}`)"
              >
                <span class="flex items-center justify-between gap-2">
                  <span
                    class="truncate font-mono text-sm font-semibold text-airwaysn"
                  >
                    {{ controller.callsign }}
                  </span>
                  <span
                    class="shrink-0 rounded bg-info-bg px-1.5 py-0.5 font-mono text-xs text-info-fg"
                  >
                    {{ controller.frequency }}
                  </span>
                </span>
                <span class="mt-0.5 block truncate text-xs text-muted">
                  {{ getFacilityName(controller.facility) }}
                </span>
                <span class="block truncate text-xs text-faint">{{
                  controller.name
                }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="px-3 py-8 text-center text-sm text-muted">
            {{ filtering ? t("noMatches") : t("noControllers") }}
          </p>
        </div>

        <!-- Pilots -->
        <div v-else class="min-h-0 flex-1 overflow-y-auto p-2">
          <ul v-if="filteredPilots.length" role="list" class="space-y-1">
            <li
              v-for="(pilot, index) in filteredPilots"
              :key="`${pilot.callsign}-${index}`"
            >
              <button
                type="button"
                :class="[
                  'w-full rounded-control p-2.5 text-left transition-colors',
                  selected === `pilot:${pilot.cid || pilot.callsign}`
                    ? 'bg-surface-sunken ring-1 ring-success'
                    : 'hover:bg-surface-sunken',
                ]"
                :aria-pressed="
                  selected === `pilot:${pilot.cid || pilot.callsign}`
                "
                @click="select(`pilot:${pilot.cid || pilot.callsign}`)"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span
                      class="size-2 shrink-0 rounded-full"
                      :style="{
                        backgroundColor: altitudeColor(pilot.altitude, theme),
                      }"
                      aria-hidden="true"
                    ></span>
                    <span
                      class="truncate font-mono text-sm font-semibold text-ink"
                    >
                      {{ pilot.callsign }}
                    </span>
                  </span>
                  <span class="tnum shrink-0 text-xs text-faint">
                    FL{{ flightLevel(pilot.altitude) }}
                  </span>
                </span>
                <span
                  class="mt-0.5 block truncate font-mono text-xs text-muted"
                >
                  {{ pilot.flight_plan?.departure || "----" }}
                  &rarr;
                  {{ pilot.flight_plan?.arrival || "----" }}
                </span>
                <span class="tnum block truncate text-xs text-faint">
                  {{ pilot.groundspeed }} kts
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="px-3 py-8 text-center text-sm text-muted">
            {{ filtering ? t("noMatches") : t("noPilots") }}
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
