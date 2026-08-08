<script setup lang="ts">
/**
 * 一个机场此刻的样子。
 *
 * 和 RadarDetails 并列的第二块详情面板，共用同一个位置 —— 同一时刻只会开一个，
 * 因为选中键是同一把（`apt:` / `pilot:` / `atc:` 三选一）。
 *
 * 进离场和在场席位全部从已有的 datafeed 推导（见 airportView.ts），只有天气是一
 * 次网络请求。所以这个面板在数据刷新时会跟着更新，而天气不会每 30 秒重取一次。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";

import Icon from "@/components/ui/Icon.vue";
import { airportSnapshot, fetchMetar } from "@/lib/airportView";
import { getFacilityName } from "@/lib/facilities";
import { createTranslator } from "@/lib/i18n";
import { altitudeColor, facilityColor, flightLevel } from "@/lib/radar";
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
</script>

<template>
  <aside
    v-if="snapshot"
    class="border-line bg-surface absolute inset-y-0 left-0 z-20 w-full overflow-y-auto border-r p-4 lg:relative lg:w-80 lg:shrink-0"
    role="complementary"
    :aria-label="t('airport.title')"
  >
    <div class="mb-3 flex items-start justify-between gap-2">
      <div>
        <div class="text-lg font-semibold">{{ snapshot.icao }}</div>
        <div class="text-muted text-xs">{{ t("airport.title") }}</div>
      </div>
      <button
        type="button"
        class="btn btn-ghost p-1"
        :aria-label="t('airport.close')"
        @click="emit('close')"
      >
        <Icon name="xMark" class="size-4" />
      </button>
    </div>

    <!-- 天气。放在最上面：管制员开这个面板十次有八次是为了看它。 -->
    <section class="mb-4">
      <h3 class="text-muted mb-1 text-xs font-medium">
        {{ t("airport.metar") }}
      </h3>
      <p
        v-if="metarLoading"
        class="text-muted bg-subtle rounded p-2 font-mono text-xs"
      >
        …
      </p>
      <p
        v-else-if="metar"
        class="bg-subtle rounded p-2 font-mono text-xs break-words"
      >
        {{ metar }}
      </p>
      <p v-else class="text-muted text-xs">
        {{ t("airport.metarUnavailable") }}
      </p>
    </section>

    <!-- 在场席位 -->
    <section class="mb-4">
      <h3 class="text-muted mb-1 text-xs font-medium">
        {{ t("airport.onStation") }}
      </h3>
      <ul v-if="snapshot.stations.length" role="list" class="space-y-1">
        <li v-for="station in snapshot.stations" :key="station.callsign">
          <button
            type="button"
            class="hover:bg-subtle flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            @click="emit('select', `atc:${station.callsign}`)"
          >
            <span
              class="inline-block size-2 shrink-0 rounded-full"
              :style="{ background: facilityColor(station.facility) }"
            ></span>
            <span class="font-medium">{{ station.callsign }}</span>
            <span class="text-muted ml-auto">
              {{
                isAtisStation(station)
                  ? "ATIS"
                  : getFacilityName(station.facility)
              }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="text-muted text-xs">{{ t("airport.noStations") }}</p>
    </section>

    <!-- 离场 -->
    <section class="mb-4">
      <h3 class="text-muted mb-1 text-xs font-medium">
        {{ t("airport.departures") }}
        <span v-if="snapshot.departures.length"
          >({{ snapshot.departures.length }})</span
        >
      </h3>
      <ul v-if="snapshot.departures.length" role="list" class="space-y-1">
        <li v-for="entry in snapshot.departures" :key="entry.pilot.callsign">
          <button
            type="button"
            class="hover:bg-subtle flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            @click="
              emit('select', `pilot:${entry.pilot.cid || entry.pilot.callsign}`)
            "
          >
            <span class="font-medium">{{ entry.pilot.callsign }}</span>
            <span class="text-muted truncate">
              → {{ entry.pilot.flight_plan?.arrival || "—" }}
            </span>
            <span
              class="ml-auto shrink-0 font-mono"
              :style="{ color: altitudeColor(entry.pilot.altitude, theme) }"
            >
              {{
                entry.onGround
                  ? t("filters.ground")
                  : flightLevel(entry.pilot.altitude)
              }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="text-muted text-xs">{{ t("airport.noDepartures") }}</p>
    </section>

    <!-- 进场 -->
    <section>
      <h3 class="text-muted mb-1 text-xs font-medium">
        {{ t("airport.arrivals") }}
        <span v-if="snapshot.arrivals.length"
          >({{ snapshot.arrivals.length }})</span
        >
      </h3>
      <ul v-if="snapshot.arrivals.length" role="list" class="space-y-1">
        <li v-for="entry in snapshot.arrivals" :key="entry.pilot.callsign">
          <button
            type="button"
            class="hover:bg-subtle flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs"
            @click="
              emit('select', `pilot:${entry.pilot.cid || entry.pilot.callsign}`)
            "
          >
            <span class="font-medium">{{ entry.pilot.callsign }}</span>
            <span class="text-muted truncate">
              {{ entry.pilot.flight_plan?.departure || "—" }} →
            </span>
            <span
              class="ml-auto shrink-0 font-mono"
              :style="{ color: altitudeColor(entry.pilot.altitude, theme) }"
            >
              {{
                entry.onGround
                  ? t("filters.ground")
                  : flightLevel(entry.pilot.altitude)
              }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="text-muted text-xs">{{ t("airport.noArrivals") }}</p>
    </section>
  </aside>
</template>
