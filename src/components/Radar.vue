<script setup lang="ts">
/**
 * 雷达页的外壳。
 *
 * 版式照 vatsim-radar：**地图占满整块内容区**，其余一切浮在它上面 —— 左上是状态
 * 条，左下是一列控件，右边是一摞卡片。原来的版式是三栏（详情 | 地图 | 列表），
 * 两侧一开，地图就只剩中间一条；在一台 1366 的笔记本上那条比手机还窄。
 *
 * 浮层的代价是它会挡住底下的地图，所以有三件事是配套的：卡片列是
 * `pointer-events: none`、只有卡片本身接事件，中间那块地图始终可拖；卡片可以逐张
 * 折叠成一条标题；列本身可以整个收起来。
 *
 * 状态（选中了谁、筛选、设置、视口）仍然全部在这里，卡片只是显示 —— 这一点没
 * 变，改的只是它们被摆在哪儿。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import RadarMap from "@/components/RadarMap.vue";
import RadarDetails from "@/components/RadarDetails.vue";
import RadarAirport from "@/components/RadarAirport.vue";
import RadarTraffic from "@/components/RadarTraffic.vue";
import VrButton from "@/components/vr/VrButton.vue";
import VrBubble from "@/components/vr/VrBubble.vue";
import Icon from "@/components/ui/Icon.vue";
import { getFacilityName } from "@/lib/facilities";
import { altitudeLegend, facilityColor } from "@/lib/radar";
import { createTranslator } from "@/lib/i18n";
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

/** 右边那一摞卡片开着还是收着。手机上默认收着 —— 一进来先看地图。 */
const railOpen = ref(true);
/** 交通那张卡自己的折叠状态，和整列的开关是两件事。 */
const trafficCollapsed = ref(false);
const activeTab = ref<"controllers" | "pilots">("controllers");
/* 筛选是一个对象而不是一个字符串：文字框只是它的一项，另外三项（高度层、起降
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
 * Escape 依次收掉压在地图上的东西。
 *
 * 顺序是「后开的先关」：设置浮层 → 选中的卡片 → 整列。一次按键只关一层，否则在
 * 手机上按一下就回到了空地图，而人多半只是想关掉刚点开的那个下拉。
 */
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (settingsOpen.value) {
    settingsOpen.value = false;
  } else if (selected.value) {
    selected.value = null;
  } else if (railOpen.value && window.innerWidth < 1024) {
    railOpen.value = false;
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

  // 手机上一进来先看地图；带着 ?sel= 进来的除外 —— 那种链接的全部意义就是那张卡。
  railOpen.value = window.innerWidth >= 1024 || !!initialView.value.selected;

  document.addEventListener("keydown", onGlobalKeydown);
  fetchData();
  interval = setInterval(fetchData, 30000);
});

onBeforeUnmount(() => {
  if (interval) clearInterval(interval);
  if (observer) observer.disconnect();
  document.removeEventListener("keydown", onGlobalKeydown);
});

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

function matchesText(value: string | undefined): boolean {
  const needle = filter.value.text.trim().toLowerCase();
  if (!needle) return true;
  return (value ?? "").toLowerCase().includes(needle);
}

const filteredControllers = computed(() =>
  controllers.value.filter((c) => matchesText(c.callsign)),
);
const filteredPilots = computed(
  () => data.value?.pilots.filter((p) => matchesFilter(p, filter.value)) ?? [],
);

/** 下拉里只列**当前真的有交通**的机场，按架次排。 */
const departureOptions = computed(() =>
  activeAirports(data.value?.pilots ?? [], "departure"),
);
const arrivalOptions = computed(() =>
  activeAirports(data.value?.pilots ?? [], "arrival"),
);

/**
 * 地图上画哪些飞机。
 *
 * 就是筛出来的那批 —— 地图的增量同步会自己把不在列表里的标记撤掉，所以筛选天然
 * 同步到地图，不需要第二套逻辑。**唯一的例外是选中的那架**：把它筛掉之后详情卡
 * 还开着、地图上却没有它，那是一个自相矛盾的画面。
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

/* 图例。原来它横在状态条里，只在 xl 以上才显示 —— 也就是最需要它的那批小屏幕
 * 看不到。挪进设置浮层：那是一个人主动打开去理解这张图的地方，而不是一条永远
 * 占着一行的装饰。 */
const facilityLegend = [2, 3, 4, 5, 7, 6].map((facility) => ({
  label: getFacilityName(facility),
  color: facilityColor(facility),
}));
const altitudeScale = computed(() => altitudeLegend(theme.value));

/* Selection is shared between the list and the map: clicking either one
 * highlights the other, and the map centres on it. */
const mapRef = ref<InstanceType<typeof RadarMap> | null>(null);
const railRef = ref<HTMLElement | null>(null);
const selected = ref<string | null>(null);

function select(key: string | null) {
  selected.value = selected.value === key ? null : key;
  if (!selected.value) return;

  mapRef.value?.focus(selected.value);

  /* 飞机和席位的详情在左边一栏，机场仍然在右边那一摞里 —— 所以「选中之后名单要
   * 怎么办」这件事，两者的答案不一样。
   *
   * 窄屏上没有左右可分，两栏都是压在地图上的底部抽屉，叠在一起就是两层挡板。所
   * 以选中飞机或席位时把名单收起来，让详情独占那块位置；机场卡本身就在名单那一
   * 摞里，收掉名单等于把它一起收掉，那当然不行。 */
  const detailIsOwnColumn = !key?.startsWith("apt:");
  if (detailIsOwnColumn && window.innerWidth < 1024) {
    railOpen.value = false;
    return;
  }

  // 从列表里点开一张卡时，把这一列滚回顶部 —— 新开的卡在最上面，而人的手指可能
  // 停在列表中段。
  railOpen.value = true;
  requestAnimationFrame(() => railRef.value?.scrollTo({ top: 0 }));
}

/* The details card renders whatever is selected. Resolving it from the live
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

/** 选中的机场。`apt:` 前缀是机场标签上那个代码点出来的。 */
const selectedAirport = computed(() => {
  const key = selected.value;
  return key?.startsWith("apt:") ? key.slice("apt:".length) : null;
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

/* ------------------------------------------------------------------ *
 * 地图控件
 * ------------------------------------------------------------------ */

const zoom = computed(() => mapRef.value?.zoom ?? 0);
const zoomRange = computed(() => mapRef.value?.zoomRange ?? [0, 18]);
</script>

<template>
  <div class="radar">
    <!-- 地图。整块内容区都是它。 -->
    <div class="radar_map">
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
        @select="select($event)"
        @move="onMapMove"
      />
      <div v-else class="radar_placeholder">
        <p>{{ loading ? t("loading") : t("noData") }}</p>
      </div>
    </div>

    <!-- 左上：在线数和更新时间 -->
    <div class="radar_status">
      <span class="radar_status_group">
        <span
          class="radar_status_dot"
          :class="{ 'radar_status_dot--stale': !!error }"
          aria-hidden="true"
        />
        <span class="vr-label radar_status_label">{{ t("controllers") }}</span>
        <VrBubble type="secondary">{{ controllers.length }}</VrBubble>
      </span>

      <span class="radar_status_group">
        <span class="vr-label radar_status_label">{{ t("pilots") }}</span>
        <VrBubble>{{ data?.pilots.length ?? 0 }}</VrBubble>
      </span>

      <span v-if="error" class="radar_status_error">{{ error }}</span>
      <span v-else class="radar_status_time vr-mono">{{
        lastUpdateLabel
      }}</span>

      <VrButton
        type="secondary"
        size="S"
        icon
        :disabled="loading"
        :aria-label="t('refresh')"
        :title="t('refresh')"
        @click="fetchData"
      >
        <template #icon>
          <Icon name="arrowPath" :class="{ 'radar-spin': loading }" />
        </template>
      </VrButton>
    </div>

    <!-- 左下：地图控件 -->
    <div class="radar_controls">
      <VrButton
        type="secondary-black"
        size="S"
        icon
        :active="settingsOpen"
        :aria-label="t('settings.title')"
        :title="t('settings.title')"
        @click="settingsOpen = !settingsOpen"
      >
        <template #icon><Icon name="cog6Tooth" /></template>
      </VrButton>

      <VrButton
        class="radar_controls--desktop"
        type="secondary-black"
        size="S"
        icon
        :disabled="zoom >= zoomRange[1]"
        aria-label="+"
        title="+"
        @click="mapRef?.zoomIn()"
      >
        <template #icon><Icon name="plus" /></template>
      </VrButton>

      <VrButton
        class="radar_controls--desktop"
        type="secondary-black"
        size="S"
        icon
        :disabled="zoom <= zoomRange[0]"
        aria-label="−"
        title="−"
        @click="mapRef?.zoomOut()"
      >
        <template #icon><Icon name="minus" /></template>
      </VrButton>

      <VrButton
        type="secondary-black"
        size="S"
        icon
        :aria-label="t('fitAll')"
        :title="t('fitAll')"
        @click="mapRef?.fitAll()"
      >
        <template #icon><Icon name="viewfinderCircle" /></template>
      </VrButton>
    </div>

    <!-- 设置。地图控件那一列的上方，和触发它的按钮挨着。 -->
    <div
      v-if="settingsOpen"
      class="radar_settings vr-appear-bottom"
      role="dialog"
      :aria-label="t('settings.title')"
    >
      <div class="radar_settings_head">
        <span class="vr-h5">{{ t("settings.title") }}</span>
        <button
          type="button"
          class="vr-popup-action"
          :aria-label="t('settings.close')"
          @click="settingsOpen = false"
        >
          <Icon name="xMark" />
        </button>
      </div>

      <div class="radar_settings_body">
        <label class="vr-label radar_settings_k">{{
          t("settings.basemap")
        }}</label>
        <select v-model="settings.basemap" class="input radar_settings_select">
          <option value="auto">{{ t("settings.basemapAuto") }}</option>
          <option value="dark">{{ t("settings.basemapDark") }}</option>
          <option value="light">{{ t("settings.basemapLight") }}</option>
          <option value="satellite">
            {{ t("settings.basemapSatellite") }}
          </option>
        </select>

        <span class="vr-label radar_settings_k">{{
          t("settings.layers")
        }}</span>
        <label class="radar_settings_toggle">
          <input v-model="settings.boundaries" type="checkbox" />
          {{ t("settings.boundaries") }}
        </label>
        <label class="radar_settings_toggle">
          <input v-model="settings.airportTags" type="checkbox" />
          {{ t("settings.airportTags") }}
        </label>
        <label class="radar_settings_toggle">
          <input v-model="settings.rangeRings" type="checkbox" />
          {{ t("settings.rangeRings") }}
        </label>

        <label class="vr-label radar_settings_k">{{
          t("settings.units")
        }}</label>
        <select v-model="settings.units" class="input radar_settings_select">
          <option value="aviation">{{ t("settings.unitsAviation") }}</option>
          <option value="metric">{{ t("settings.unitsMetric") }}</option>
        </select>

        <!-- 图例 -->
        <span class="vr-label radar_settings_k">{{ t("legendTitle") }}</span>
        <div class="radar_legend">
          <span
            v-for="item in facilityLegend"
            :key="item.label"
            class="vr-chip"
            :style="{ backgroundColor: item.color }"
          >
            {{ item.label }}
          </span>
        </div>
        <div class="radar_legend_ramp">
          <span class="radar_legend_ramp_bar" aria-hidden="true">
            <span
              v-for="step in altitudeScale"
              :key="step.label"
              :style="{ backgroundColor: step.color }"
            />
          </span>
          <span class="radar_legend_ramp_ends vr-mono">
            {{ altitudeScale[0].label }} –
            {{ altitudeScale[altitudeScale.length - 1].label }}
          </span>
        </div>
      </div>
    </div>

    <!-- 左侧：选中的飞机 / 席位。

         它在**地图左边**，和右边那一摞名单分开 —— 一边是「网络上有谁」，一边是
         「我正在看谁」。两件事同时占着右边一列时，选中一架飞机会把名单整个推下
         去，而人多半是想一边看这架、一边在名单里挑下一架。

         窄屏上没有「左边」可言，所以它变成底部的一张抽屉，并且**选中的同时把名
         单那张收起来** —— 见 select()。 -->
    <div v-if="selectedPilot || selectedStation" class="radar_detail">
      <RadarDetails
        :messages="messages"
        :pilot="selectedPilot"
        :controller="selectedStation"
        :is-atis="selectedIsAtis"
        :theme="theme"
        @close="selected = null"
        @locate="selected && mapRef?.focus(selected)"
      />
    </div>

    <!-- 右侧那一摞卡片 -->
    <div v-if="railOpen" ref="railRef" class="radar_rail">
      <RadarAirport
        :messages="messages"
        :icao="selectedAirport"
        :pilots="data?.pilots ?? []"
        :controllers="controllers"
        :atis="data?.atis ?? []"
        :theme="theme"
        @close="selected = null"
        @select="select($event)"
      />

      <RadarTraffic
        v-model:filter="filter"
        v-model:tab="activeTab"
        v-model:collapsed="trafficCollapsed"
        :messages="messages"
        :controllers="filteredControllers"
        :pilots="filteredPilots"
        :departure-options="departureOptions"
        :arrival-options="arrivalOptions"
        :selected="selected"
        :theme="theme"
        @select="select($event)"
      />
    </div>

    <!-- 整列的开关。收起来之后它是屏幕上唯一还指向那一列的东西，所以它不能跟着
         一起消失 —— 位置固定在右上角，开合只换图标。 -->
    <VrButton
      class="radar_rail-toggle"
      type="secondary-black"
      size="S"
      icon
      :aria-expanded="railOpen"
      :aria-label="railOpen ? t('hidePanel') : t('showPanel')"
      :title="railOpen ? t('hidePanel') : t('showPanel')"
      @click="railOpen = !railOpen"
    >
      <template #icon>
        <Icon :name="railOpen ? 'xMark' : 'bars3'" />
      </template>
    </VrButton>
  </div>
</template>

<style scoped>
.radar {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--vr-bg);
}

.radar_map {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.radar_placeholder {
  display: flex;
  align-items: center;
  justify-content: center;

  height: 100%;

  font-size: 13px;
  color: var(--color-faint);

  background: var(--vr-l1);
}

/* ——— 左上：状态条 ——— */

.radar_status {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 12px;

  display: flex;
  gap: 10px;
  align-items: center;

  max-width: calc(100% - 24px);
  padding: 4px 6px 4px 10px;
  border: 1px solid var(--vr-stroke);
  border-radius: var(--radius-card);

  background: color-mix(in srgb, var(--vr-bg) 92%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: var(--vr-shadow);
}

.radar_status_group {
  display: flex;
  gap: 6px;
  align-items: center;
}

.radar_status_label {
  color: var(--color-faint);
}

/* 一个还在跳的心跳点。取数失败时停下来并转红 —— 「更新于 12:04」本身不会告诉
   人这个时间已经十分钟没动过了。 */
.radar_status_dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--vr-success);
  animation: radar-pulse 2s ease-in-out infinite;
}
.radar_status_dot--stale {
  background: var(--vr-danger);
  animation: none;
}

@keyframes radar-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.radar_status_time {
  font-size: 11px;
  color: var(--color-faint);
}

.radar_status_error {
  font-size: 11px;
  font-weight: 600;
  color: var(--vr-danger);
}

.radar-spin {
  animation: radar-rotate 1s linear infinite;
}
@keyframes radar-rotate {
  to {
    transform: rotate(360deg);
  }
}

/* ——— 左下：控件 ——— */

.radar_controls {
  position: absolute;
  z-index: 5;
  bottom: 28px;
  left: 12px;

  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ——— 设置 ——— */

.radar_settings {
  position: absolute;
  z-index: 6;
  bottom: 28px;
  left: 56px;

  width: 260px;
  max-width: calc(100vw - 80px);
  max-height: calc(100dvh - 160px);
  overflow-y: auto;
  border: 1px solid var(--vr-stroke);
  border-radius: var(--radius-card);

  background: var(--vr-bg);
  box-shadow: var(--vr-shadow);
}

.radar_settings_head {
  position: sticky;
  top: 0;

  display: flex;
  align-items: center;
  justify-content: space-between;

  padding: 8px 12px;
  border-bottom: 1px solid var(--vr-stroke);

  background: var(--vr-bg);
}

.radar_settings_body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 12px;
}

.radar_settings_k {
  margin-top: 6px;
  color: var(--color-faint);
}
.radar_settings_k:first-child {
  margin-top: 0;
}

.radar_settings_select {
  min-height: 32px;
  font-size: 12px;
}

.radar_settings_toggle {
  display: flex;
  gap: 8px;
  align-items: center;

  font-size: 12px;
  color: var(--vr-t2);

  cursor: pointer;
}
.radar_settings_toggle input {
  accent-color: var(--vr-brand);
}

.radar_legend {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.radar_legend_ramp {
  display: flex;
  gap: 8px;
  align-items: center;
}

.radar_legend_ramp_bar {
  display: flex;
  overflow: hidden;
  border-radius: 2px;
}
.radar_legend_ramp_bar span {
  width: 18px;
  height: 8px;
}

.radar_legend_ramp_ends {
  font-size: 10px;
  color: var(--color-faint);
}

/* ——— 左侧：详情 ——— */

.radar_detail {
  position: absolute;
  z-index: 5;
  /* 让开左上角的状态条（12 + 40 高 + 12 的空隙）。 */
  top: 64px;
  left: 12px;
  /* 也让开左下角那一列控件：四个 32px 的方块加三道 8px 的缝是 152px，控件本身
     从 bottom: 28px 起，再留 12px 的空隙。写死这个数是因为控件的数量是写死的 ——
     加第五个按钮时这里要跟着改，所以两处都留了这句注释。 */
  bottom: 192px;

  display: flex;
  flex-direction: column;

  width: 380px;
  max-width: calc(100vw - 24px);
  overflow-y: auto;
  scrollbar-width: none;

  /* 和右边那一列同理：只有卡片接事件，空白处仍然是可以拖的地图。 */
  pointer-events: none;
}
.radar_detail::-webkit-scrollbar {
  display: none;
}

/* ——— 右侧的卡片列 ——— */

.radar_rail {
  position: absolute;
  z-index: 5;
  top: 12px;
  right: 12px;
  bottom: 12px;

  display: flex;
  flex-direction: column;
  gap: 8px;

  width: 380px;
  max-width: calc(100vw - 24px);
  overflow-y: auto;
  scrollbar-width: none;

  /* 列本身不接事件，只有卡片接 —— 卡片之间的缝隙和列底部的空白仍然是可以拖动
     的地图。少了这一条，右边 380px 宽的一条就整个变成了死区。 */
  pointer-events: none;
}
.radar_rail::-webkit-scrollbar {
  display: none;
}

/* 给右上角那个开关让出位置。 */
.radar_rail > :first-child {
  margin-top: 40px;
}

.radar_rail-toggle {
  position: absolute;
  z-index: 6;
  top: 12px;
  right: 12px;
}

/* ——— 手机 ——— */

@media (max-width: 1023px) {
  /* 卡片列变成底部的一张抽屉。放在下面而不是仍然贴右边：单手够得着的是屏幕
     下半部分，而右上角是最够不着的那个角。 */
  /* 抽屉的下沿要让开版权条那一行。抽屉盖住它的话，署名就只在抽屉关着的时候
     可见 —— VATSpy 是 CC BY-SA，署名得在展示它的地方一直看得到。 */
  /* 详情在窄屏上也是同一张底部抽屉 —— 没有左右可分。它和名单永远不会同时出现
     （select() 里选中飞机/席位时把名单收掉），所以两者可以占同一块位置。 */
  .radar_detail,
  .radar_rail {
    top: auto;
    right: 8px;
    bottom: 22px;
    left: 8px;

    width: auto;
    max-height: 58dvh;
  }

  .radar_rail > :first-child {
    margin-top: 0;
  }

  /* 控件挪到右边中段：左下角被抽屉占了，而右上角是那个开关。 */
  .radar_controls {
    top: 64px;
    bottom: auto;
    left: auto;
    right: 12px;
  }

  /* 缩放按钮在触摸屏上是多余的 —— 双指捏合更快，而那两个按钮正好占掉抽屉上面
     仅剩的一点地图。 */
  .radar_controls--desktop {
    display: none;
  }

  .radar_settings {
    top: 64px;
    right: 56px;
    bottom: auto;
    left: auto;
  }

  .radar_status {
    gap: 8px;
    padding: 3px 5px 3px 8px;
  }

  /* 手机上这行文字会把状态条挤到换行。心跳点和数字已经说明了同样的事。 */
  .radar_status_time {
    display: none;
  }
}
</style>
