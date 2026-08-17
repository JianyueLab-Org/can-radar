<script setup lang="ts">
/**
 * 在线交通的那张卡：页签、搜索、筛选、两份列表。
 *
 * 它取代的是原来贴在地图右侧的那一整栏。搬成浮层之后有一件事必须解决 —— 原来那
 * 栏是页面的一列，高度由布局给；现在它浮在地图上，高度得自己定。所以列表区有
 * 一个 `max-height` 并自己滚动，而页签和搜索框 `sticky` 钉在卡片顶部：一张开着
 * 三十行的卡片，滚到底还能直接改筛选条件。
 *
 * 筛选的结果同时作用到列表和地图（见 radarFilter.ts 开头），所以这张卡上的每一
 * 个下拉，改的其实是地图上画哪些飞机。「已筛选」那一行就是在说这件事。
 */
import { computed } from "vue";

import { Icon } from "@jianyuelab-org/can-ui";
import VrInfoPopup from "@/components/vr/VrInfoPopup.vue";
import VrButton from "@/components/vr/VrButton.vue";
import { getFacilityName } from "@/lib/facilities";
import { createTranslator } from "@/lib/i18n";
import { altitudeColor, facilityColor, flightLevel } from "@/lib/radar";
import { isFiltering, type TrafficFilter } from "@/lib/radarFilter";
import type { Controller, Pilot } from "@/lib/radarTypes";

const props = defineProps<{
  messages: Record<string, unknown>;
  controllers: Controller[];
  pilots: Pilot[];
  departureOptions: { icao: string; count: number }[];
  arrivalOptions: { icao: string; count: number }[];
  selected: string | null;
  /** 看这张名单的人自己那架飞机的键。它在名单里也戴一个记号。 */
  mine?: string | null;
  theme: "dark" | "light";
}>();

const emit = defineEmits<{ (e: "select", key: string): void }>();

const filter = defineModel<TrafficFilter>("filter", { required: true });
const tab = defineModel<"controllers" | "pilots">("tab", {
  required: true,
});
const collapsed = defineModel<boolean>("collapsed", { default: false });

const t = createTranslator(props.messages);

const filtering = computed(() => isFiltering(filter.value));

const tabs = computed(() => ({
  controllers: {
    title: t("controllers"),
    count: props.controllers.length,
  },
  pilots: { title: t("pilots"), count: props.pilots.length },
}));

function clearFilter() {
  filter.value = { text: "", altitude: "any", departure: "", arrival: "" };
}

function pilotKey(pilot: Pilot): string {
  return `pilot:${pilot.cid || pilot.callsign}`;
}
</script>

<template>
  <VrInfoPopup
    v-model:collapsed="collapsed"
    :sections="[{ key: 'list' }]"
    :closable="false"
    max-height="min(70dvh, 720px)"
  >
    <!-- 不是 `t("title")`。那是整个站点的标题（「在线地图」），作为一张卡的抬头
         读起来像是「这张卡就是地图」—— 而它是地图上有谁的名单。 -->
    <template #title>{{ t("trafficTitle") }}</template>

    <!-- 页签 + 搜索 + 筛选，钉在卡片顶部 -->
    <template #prepend>
      <div class="rt-controls">
        <div class="rt-tabs">
          <button
            v-for="(meta, key) in tabs"
            :key="key"
            type="button"
            role="tab"
            class="rt-tab"
            :class="{ 'rt-tab--active': tab === key }"
            :aria-selected="tab === key"
            @click="tab = key as 'controllers' | 'pilots'"
          >
            {{ meta.title }}
            <span class="rt-tab_count">{{ meta.count }}</span>
          </button>
        </div>

        <div class="rt-search">
          <Icon name="magnifyingGlass" class="rt-search_icon" />
          <input
            v-model="filter.text"
            type="search"
            class="input rt-search_input"
            :placeholder="t('searchPlaceholder')"
            :aria-label="t('searchPlaceholder')"
          />
        </div>

        <!-- 三个下拉只在「飞机」页显示：高度和起降机场对席位没有意义，而一组
             永远灰着的控件比没有这组控件更让人费解。 -->
        <div v-if="tab === 'pilots'" class="rt-filters">
          <select
            v-model="filter.altitude"
            class="input rt-filters_select"
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
            class="input rt-filters_select"
            :aria-label="t('filters.departure')"
          >
            <option value="">{{ t("filters.departure") }}</option>
            <option v-for="a in departureOptions" :key="a.icao" :value="a.icao">
              {{ a.icao }} ({{ a.count }})
            </option>
          </select>

          <select
            v-model="filter.arrival"
            class="input rt-filters_select"
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
        <div v-if="filtering" class="rt-active">
          <span>{{ t("filters.active") }}</span>
          <VrButton type="link" @click="clearFilter">
            {{ t("filters.clear") }}
          </VrButton>
        </div>
      </div>
    </template>

    <template #list>
      <div class="rt-list">
        <!-- 席位 -->
        <ul v-if="tab === 'controllers'" role="list" class="rt-rows">
          <li v-for="(c, index) in controllers" :key="`${c.callsign}-${index}`">
            <button
              type="button"
              class="rt-row"
              :class="{ 'rt-row--selected': selected === `atc:${c.callsign}` }"
              :aria-pressed="selected === `atc:${c.callsign}`"
              @click="emit('select', `atc:${c.callsign}`)"
            >
              <span
                class="vr-chip rt-row_chip"
                :style="{ background: facilityColor(c.facility) }"
              >
                {{ getFacilityName(c.facility) }}
              </span>
              <span class="rt-row_main">
                <span class="rt-row_callsign">{{ c.callsign }}</span>
                <span class="rt-row_sub">{{ c.name }}</span>
              </span>
              <span class="rt-row_trail vr-mono">{{ c.frequency }}</span>
            </button>
          </li>
        </ul>

        <!-- 飞机 -->
        <ul v-else role="list" class="rt-rows">
          <li v-for="(p, index) in pilots" :key="`${p.callsign}-${index}`">
            <button
              type="button"
              class="rt-row"
              :class="{ 'rt-row--selected': selected === pilotKey(p) }"
              :aria-pressed="selected === pilotKey(p)"
              @click="emit('select', pilotKey(p))"
            >
              <span
                class="rt-row_dot"
                :style="{ background: altitudeColor(p.altitude, theme) }"
                aria-hidden="true"
              />
              <span class="rt-row_main">
                <span class="rt-row_callsign">
                  {{ p.callsign }}
                  <!-- 自己那架。名单按呼号排，自己那一行不会总在看得见的地方，
                       所以它得自己认领一个记号 —— 和地图上那架戴的是同一个品牌
                       色的圈。 -->
                  <span v-if="mine === pilotKey(p)" class="rt-row_mine">
                    {{ t("mine.tag") }}
                  </span>
                </span>
                <span class="rt-row_sub vr-mono">
                  {{ p.flight_plan?.departure || "----" }} →
                  {{ p.flight_plan?.arrival || "----" }}
                </span>
              </span>
              <span class="rt-row_figures">
                <span class="rt-row_trail vr-mono"
                  >FL{{ flightLevel(p.altitude) }}</span
                >
                <span class="rt-row_trail rt-row_trail--dim vr-mono">
                  {{ p.groundspeed }} kt
                </span>
              </span>
            </button>
          </li>
        </ul>

        <p
          v-if="(tab === 'controllers' ? controllers : pilots).length === 0"
          class="rt-empty"
        >
          {{
            filtering
              ? t("noMatches")
              : tab === "controllers"
                ? t("noControllers")
                : t("noPilots")
          }}
        </p>
      </div>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
/* 钉住的那一块。`top: 0` 是相对**卡片自己**的滚动容器 —— VrInfoPopup 的头部也
   是 sticky，所以这里要让开它 36px，否则两者会重叠。 */
.rt-controls {
  position: sticky;
  z-index: 1;
  top: 36px;

  display: flex;
  flex-direction: column;
  gap: 8px;

  /* 把 12px 的内边距抵掉，让页签的底边横贯整张卡 —— 一条两端留白的分隔线看着
     像没画完。 */
  margin: -8px -12px 0;
  padding: 8px 12px;

  background: var(--vr-bg);
}

.rt-tabs {
  display: flex;
  align-items: flex-end;
  margin: 0 -12px;
  padding: 0 12px;
  border-bottom: 1px solid var(--vr-stroke);
}

.rt-tab {
  position: relative;

  display: flex;
  flex: 1 1 0;
  gap: 6px;
  align-items: center;
  justify-content: center;

  min-width: 0;
  padding: 8px 12px;
  border: none;

  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--vr-t3);

  background: transparent;
  cursor: pointer;
}

.rt-tab::after {
  content: "";

  position: absolute;
  bottom: -1px;
  left: 0;

  width: 100%;
  height: 0;

  background: transparent;

  transition:
    height 0.3s ease,
    background-color 0.3s ease;
}

.rt-tab:hover:not(.rt-tab--active) {
  color: var(--vr-t1);
}
.rt-tab:hover:not(.rt-tab--active)::after {
  height: 1px;
  background: rgb(var(--vr-brand-rgb) / 0.5);
}

.rt-tab--active {
  color: var(--vr-t1);
  cursor: default;
}
.rt-tab--active::after {
  height: 2px;
  background: var(--vr-brand);
}

.rt-tab_count {
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-faint);
  font-variant-numeric: tabular-nums;
}

.rt-search {
  position: relative;
}

.rt-search_icon {
  position: absolute;
  top: 50%;
  left: 10px;
  transform: translateY(-50%);

  width: 14px;
  height: 14px;

  color: var(--color-faint);

  pointer-events: none;
}

.rt-search_input {
  min-height: 32px;
  padding-left: 30px;
  font-size: 13px;
}

.rt-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.rt-filters_select {
  min-height: 30px;
  padding: 4px 6px;
  font-size: 11px;
}

.rt-active {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;

  font-size: 11px;
  color: var(--color-faint);
}

/* 列表自己滚。上限用 dvh 而不是固定像素：横屏的手机和 4K 的窗口需要的行数差
   得很远，而卡片整体还有一个 max-height 兜着。 */
.rt-list {
  max-height: 46dvh;
  margin: 0 -6px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.rt-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rt-row {
  display: flex;
  gap: 8px;
  align-items: center;

  width: 100%;
  padding: 6px;
  border: none;
  border-radius: 3px;

  font-family: inherit;
  text-align: left;

  background: transparent;
  cursor: pointer;

  transition: background-color 0.2s ease;
}
.rt-row:hover {
  background: var(--vr-alpha-8);
}

/* 选中的那一行用左边一条品牌色的竖杠，而不是整行换底色 —— 底色在一列 hover 也
   会变色的行里分不出「选中」和「指针正好停在这儿」。 */
.rt-row--selected {
  background: var(--vr-alpha-8);
  box-shadow: inset 2px 0 0 var(--vr-brand);
}

.rt-row_chip {
  flex: none;
  min-width: 38px;
}

.rt-row_dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.rt-row_mine {
  margin-left: 6px;
  padding: 1px 4px;
  border: 1px solid var(--vr-brand);
  border-radius: 3px;

  font-family: var(--vr-font);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vr-brand);
  vertical-align: 1px;
}

.rt-row_main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.rt-row_callsign {
  overflow: hidden;
  font-family: var(--vr-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--vr-t1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-row_sub {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-row_figures {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
}

.rt-row_trail {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  color: var(--vr-t3);
}
.rt-row_trail--dim {
  color: var(--color-faint);
}

.rt-empty {
  padding: 24px 0;
  font-size: 12px;
  color: var(--color-faint);
  text-align: center;
}
</style>
