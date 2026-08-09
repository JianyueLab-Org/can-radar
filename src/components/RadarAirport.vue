<script setup lang="ts">
/**
 * 一个机场此刻的样子。
 *
 * 和 RadarDetails 并列的第二张卡。选中键是同一把（`apt:` / `pilot:` / `atc:`
 * 三选一），所以同一时刻只会开一张 —— 但它们现在是**堆在同一列里**的浮层，而不
 * 是共用地图左边那一栏，所以将来要让机场和它的某一架进场航班同时开着，只是把选
 * 中键改成一个数组的事。
 *
 * 进离场和在场席位全部从已有的 datafeed 推导（见 airportView.ts），只有天气是一
 * 次网络请求。所以这个面板在数据刷新时会跟着更新，而天气不会每 30 秒重取一次。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { airportSnapshot, fetchMetar } from "@/lib/airportView";
import { getFacilityName } from "@/lib/facilities";
import { createTranslator } from "@/lib/i18n";
import { altitudeColor, facilityColor, flightLevel } from "@/lib/radar";
import VrInfoPopup, {
  type InfoPopupSection,
} from "@/components/vr/VrInfoPopup.vue";
import type { AtisData, Controller, Pilot } from "@/lib/radarTypes";

const props = defineProps<{
  messages: Record<string, unknown>;
  icao: string | null;
  pilots: Pilot[];
  controllers: Controller[];
  atis: AtisData[];
  theme: "dark" | "light";
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", key: string): void;
}>();

const t = createTranslator(props.messages);

const snapshot = computed(() =>
  props.icao
    ? airportSnapshot(props.icao, props.pilots, props.controllers, props.atis)
    : null,
);

const metar = ref<string | null>(null);
const metarLoading = ref(false);
let inflight: AbortController | null = null;

/**
 * 换机场才重取天气，数据刷新不重取。
 *
 * 上一次的请求要中止：连着点三个机场时，三份响应回来的顺序是不保证的，不中止的
 * 话面板上可能停在第一个机场的天气 —— 而标题写着第三个。
 */
watch(
  () => props.icao,
  async (icao) => {
    inflight?.abort();
    metar.value = null;
    if (!icao) return;

    inflight = new AbortController();
    metarLoading.value = true;
    const result = await fetchMetar(icao, inflight.signal);
    // 请求发出之后机场又换了 —— 这一份已经不是要的那个了，丢掉。
    if (props.icao === icao) {
      metar.value = result;
      metarLoading.value = false;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => inflight?.abort());

function isAtisStation(station: Controller | AtisData): boolean {
  return props.atis.some((a) => a.callsign === station.callsign);
}

/**
 * 分段。计数挂在标题右边的小气泡上，所以标题本身不用再写「(12)」。
 *
 * 进离场两段可折叠：一个繁忙机场两边加起来能有几十行，而开这张卡的人多半先看
 * 天气和席位。默认都是展开的 —— 折叠是给「这次不想看」用的，不是默认状态。
 */
const sections = computed<InfoPopupSection[]>(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  return [
    { key: "metar", title: t("airport.metar") },
    {
      key: "stations",
      title: t("airport.onStation"),
      bubble: snap.stations.length || undefined,
    },
    {
      key: "departures",
      title: t("airport.departures"),
      bubble: snap.departures.length || undefined,
      collapsible: true,
    },
    {
      key: "arrivals",
      title: t("airport.arrivals"),
      bubble: snap.arrivals.length || undefined,
      collapsible: true,
    },
  ];
});
</script>

<template>
  <VrInfoPopup
    v-if="snapshot"
    :sections="sections"
    accent="var(--vr-brand)"
    @close="emit('close')"
  >
    <template #title>
      <span class="ra-icao">{{ snapshot.icao }}</span>
      <span class="ra-kind">{{ t("airport.title") }}</span>
    </template>

    <!-- 天气 -->
    <template #metar>
      <p v-if="metarLoading" class="ra-metar ra-metar--dim">…</p>
      <p v-else-if="metar" class="ra-metar">{{ metar }}</p>
      <p v-else class="ra-empty">{{ t("airport.metarUnavailable") }}</p>
    </template>

    <!-- 在场席位 -->
    <template #stations>
      <ul v-if="snapshot.stations.length" class="ra-list" role="list">
        <li v-for="station in snapshot.stations" :key="station.callsign">
          <button
            type="button"
            class="ra-item"
            @click="emit('select', `atc:${station.callsign}`)"
          >
            <span
              class="vr-chip ra-item_chip"
              :style="{ background: facilityColor(station.facility) }"
            >
              {{
                isAtisStation(station)
                  ? "ATIS"
                  : getFacilityName(station.facility)
              }}
            </span>
            <span class="ra-item_callsign">{{ station.callsign }}</span>
            <span class="ra-item_trail vr-mono">{{ station.frequency }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="ra-empty">{{ t("airport.noStations") }}</p>
    </template>

    <!-- 离场 -->
    <template #departures>
      <ul v-if="snapshot.departures.length" class="ra-list" role="list">
        <li v-for="entry in snapshot.departures" :key="entry.pilot.callsign">
          <button
            type="button"
            class="ra-item"
            @click="
              emit('select', `pilot:${entry.pilot.cid || entry.pilot.callsign}`)
            "
          >
            <span
              class="ra-item_dot"
              :style="{
                background: altitudeColor(entry.pilot.altitude, theme),
              }"
              aria-hidden="true"
            />
            <span class="ra-item_callsign">{{ entry.pilot.callsign }}</span>
            <span class="ra-item_route vr-mono">
              → {{ entry.pilot.flight_plan?.arrival || "—" }}
            </span>
            <span class="ra-item_trail vr-mono">
              {{
                entry.onGround
                  ? t("filters.ground")
                  : `FL${flightLevel(entry.pilot.altitude)}`
              }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="ra-empty">{{ t("airport.noDepartures") }}</p>
    </template>

    <!-- 进场 -->
    <template #arrivals>
      <ul v-if="snapshot.arrivals.length" class="ra-list" role="list">
        <li v-for="entry in snapshot.arrivals" :key="entry.pilot.callsign">
          <button
            type="button"
            class="ra-item"
            @click="
              emit('select', `pilot:${entry.pilot.cid || entry.pilot.callsign}`)
            "
          >
            <span
              class="ra-item_dot"
              :style="{
                background: altitudeColor(entry.pilot.altitude, theme),
              }"
              aria-hidden="true"
            />
            <span class="ra-item_callsign">{{ entry.pilot.callsign }}</span>
            <span class="ra-item_route vr-mono">
              {{ entry.pilot.flight_plan?.departure || "—" }} →
            </span>
            <span class="ra-item_trail vr-mono">
              {{
                entry.onGround
                  ? t("filters.ground")
                  : `FL${flightLevel(entry.pilot.altitude)}`
              }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="ra-empty">{{ t("airport.noArrivals") }}</p>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
.ra-icao {
  font-family: var(--vr-font-alt);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.ra-kind {
  margin-left: 8px;
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-faint);
  text-transform: uppercase;
}

.ra-metar {
  padding: 8px;
  border-radius: var(--radius-control);

  font-family: var(--vr-font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--vr-t2);
  overflow-wrap: anywhere;

  background: var(--vr-alpha-4);
}
.ra-metar--dim {
  color: var(--color-faint);
}

.ra-empty {
  font-size: 12px;
  color: var(--color-faint);
}

.ra-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ra-item {
  display: flex;
  gap: 8px;
  align-items: center;

  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 3px;

  font-family: inherit;
  font-size: 12px;
  color: var(--vr-t2);
  text-align: left;

  background: transparent;
  cursor: pointer;

  transition: background-color 0.2s ease;
}
.ra-item:hover {
  background: var(--vr-alpha-8);
}

.ra-item_chip {
  flex: none;
  min-width: 38px;
}

.ra-item_dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.ra-item_callsign {
  flex: none;
  font-family: var(--vr-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--vr-t1);
}

.ra-item_route {
  overflow: hidden;
  min-width: 0;
  font-size: 11px;
  color: var(--color-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ra-item_trail {
  margin-left: auto;
  flex: none;
  font-size: 11px;
  color: var(--color-faint);
}
</style>
