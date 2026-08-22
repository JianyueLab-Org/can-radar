<script setup lang="ts">
/**
 * 预约管制的那张卡 —— 名单那一摞里的第三张，压在在线交通下面。
 *
 * 它回答的是「等一下有谁开席」，而上面那张回答的是「现在谁在线」。两件事挨着
 * 放是有意的：一个准备飞的人先看有没有人管，看到没有再往下看今晚几点会有 ——
 * 反过来的顺序会让一张多半为空的板子挡在最要紧的名单前面。
 *
 * 数据自己取（和 RadarAirport 的天气一样，卡片各管各的那一次请求），因为它和地
 * 图那份三十秒一刷的数据源完全无关：预约是几小时甚至几天以前写下的，跟着交通刷
 * 新只是白打请求。
 *
 * **这张卡只对登录着的人渲染**，由 Radar.vue 决定（`v-if="signedIn"`）。理由在
 * `lib/reservations.ts` 和那条转发路由里：板子上有成员用户名和备注。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import VrInfoPopup from "@/components/vr/VrInfoPopup.vue";
import VrBubble from "@/components/vr/VrBubble.vue";
import { getFacilityName } from "@/lib/facilities";
import { createTranslator } from "@/lib/i18n";
import { facilityColor } from "@/lib/radar";
import {
  fetchReservations,
  reservationViews,
  type Reservation,
  type ReservationView,
} from "@/lib/reservations";
import type { Controller } from "@/lib/radarTypes";

const props = defineProps<{
  messages: Record<string, unknown>;
  /** 此刻在线的席位，只用来认出「这条预约的人已经上来了」。 */
  controllers: Controller[];
  selected: string | null;
}>();

const emit = defineEmits<{ (e: "select", key: string): void }>();

const collapsed = defineModel<boolean>("collapsed", { default: false });

const t = createTranslator(props.messages);

/** 五分钟重取一次。预约是几小时前写下的，比这更勤没有任何东西会变。 */
const REFRESH_MS = 5 * 60 * 1000;
/** 但「进行中」和「还有多久」得自己走 —— 那两个只跟时间有关，不跟请求有关。 */
const TICK_MS = 30 * 1000;

/** `null` 是取不到，`[]` 是板子空的。两者写的不是同一句话，见 fetchReservations。 */
const reservations = ref<Reservation[] | null>(null);
const loading = ref(true);
const now = ref(Date.now());

let refresh: ReturnType<typeof setInterval> | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let inflight: AbortController | null = null;

async function load() {
  inflight?.abort();
  inflight = new AbortController();
  const result = await fetchReservations(inflight.signal);
  // 中止掉的那一次不要覆盖后来的结果：AbortError 也是 null，直接写回去会把刚
  // 取到的板子擦成「取不到」。
  if (inflight.signal.aborted) return;
  reservations.value = result;
  loading.value = false;
  now.value = Date.now();
}

onMounted(() => {
  load();
  refresh = setInterval(load, REFRESH_MS);
  tick = setInterval(() => (now.value = Date.now()), TICK_MS);
});

onBeforeUnmount(() => {
  if (refresh) clearInterval(refresh);
  if (tick) clearInterval(tick);
  inflight?.abort();
});

const views = computed(() =>
  reservations.value ? reservationViews(reservations.value, now.value) : [],
);

/** 此刻在线的呼号。预约里出现同一个呼号时，那一行就是可以点开的。 */
const onlineCallsigns = computed(
  () => new Set(props.controllers.map((c) => c.callsign.toUpperCase())),
);

function isOnline(view: ReservationView): boolean {
  return onlineCallsigns.value.has(view.reservation.callsign);
}

function selectionKey(view: ReservationView): string {
  return `atc:${view.reservation.callsign}`;
}

/**
 * 「还有多久」。
 *
 * 一小时以内报分钟，一天以内报小时，再远报天 —— 一条三天后的预约写成「4320 分
 * 钟后」是一个要在心里做除法才能读的数字。
 */
function countdown(view: ReservationView): string {
  const minutes = Math.max(0, view.minutesToStart);
  if (minutes < 60) return t("bookings.inMinutes", { n: minutes });
  if (minutes < 24 * 60)
    return t("bookings.inHours", { n: Math.round(minutes / 60) });
  return t("bookings.inDays", { n: Math.round(minutes / (24 * 60)) });
}
</script>

<template>
  <VrInfoPopup
    v-model:collapsed="collapsed"
    :sections="[{ key: 'list' }]"
    :closable="false"
    max-height="min(50dvh, 480px)"
  >
    <template #title>
      <span class="rb-title">{{ t("bookings.title") }}</span>
      <VrBubble v-if="views.length" type="secondary">
        {{ views.length }}
      </VrBubble>
    </template>

    <template #list>
      <p v-if="loading" class="rb-empty">…</p>

      <!-- 取不到和板子空的分开说。合成一句的话，上游挂了会显示成「今晚没有人预
           约」，而那是这张卡最不该说错的一句。 -->
      <p v-else-if="!reservations" class="rb-empty">
        {{ t("bookings.error") }}
      </p>
      <p v-else-if="!views.length" class="rb-empty">
        {{ t("bookings.empty") }}
      </p>

      <ul v-else role="list" class="rb-rows">
        <li v-for="view in views" :key="view.reservation.id">
          <!-- 已经上线的那一条是可以点开的（点开的是地图上那个席位）；还没上线
               的点了没有东西可选，所以它就不是个按钮 —— 一个按下去什么都不发生
               的行，比一行普通文字更让人以为是坏了。 -->
          <component
            :is="isOnline(view) ? 'button' : 'div'"
            :type="isOnline(view) ? 'button' : undefined"
            class="rb-row"
            :class="{
              'rb-row--clickable': isOnline(view),
              'rb-row--selected': selected === selectionKey(view),
            }"
            :aria-pressed="
              isOnline(view) ? selected === selectionKey(view) : undefined
            "
            @click="isOnline(view) && emit('select', selectionKey(view))"
          >
            <span
              class="vr-chip rb-row_chip"
              :style="{ background: facilityColor(view.facility) }"
            >
              {{ getFacilityName(view.facility) }}
            </span>

            <span class="rb-row_main">
              <span class="rb-row_callsign">
                {{ view.reservation.callsign }}
                <span v-if="view.reservation.mine" class="rb-row_tag">
                  {{ t("bookings.mine") }}
                </span>
                <span
                  v-if="isOnline(view)"
                  class="rb-row_tag rb-row_tag--online"
                >
                  {{ t("bookings.online") }}
                </span>
              </span>

              <span class="rb-row_sub vr-mono">
                <template v-if="view.window.date">
                  {{ view.window.date }}
                </template>
                {{ view.window.start }}–{{ view.window.end }}Z
              </span>

              <span
                v-if="view.reservation.description"
                class="rb-row_note"
                :title="view.reservation.description"
              >
                {{ view.reservation.description }}
              </span>
            </span>

            <span class="rb-row_figures">
              <span
                class="rb-row_status"
                :class="{ 'rb-row_status--live': view.live }"
              >
                {{ view.live ? t("bookings.live") : countdown(view) }}
              </span>
              <span v-if="view.reservation.username" class="rb-row_who vr-mono">
                {{ view.reservation.username }}
              </span>
            </span>
          </component>
        </li>
      </ul>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
.rb-title {
  margin-right: 4px;
}

/* 和交通那张卡同一套行样式（`.rt-*`）。两处各写一份是因为 scoped style 不跨组
   件，而把它提到 vr-theme.css 里会让那份文件开始收纳只有一个调用方的东西。 */
.rb-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 -6px;
}

.rb-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;

  width: 100%;
  padding: 6px;
  border: none;
  border-radius: 3px;

  font-family: inherit;
  text-align: left;

  background: transparent;

  transition: background-color 0.2s ease;
}

.rb-row--clickable {
  cursor: pointer;
}
.rb-row--clickable:hover {
  background: var(--vr-alpha-8);
}

.rb-row--selected {
  background: var(--vr-alpha-8);
  box-shadow: inset 2px 0 0 var(--vr-brand);
}

.rb-row_chip {
  flex: none;
  min-width: 38px;
  margin-top: 1px;
}

.rb-row_main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.rb-row_callsign {
  overflow: hidden;
  font-family: var(--vr-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--vr-t1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rb-row_tag {
  margin-left: 6px;
  padding: 1px 4px;
  border: 1px solid var(--vr-brand);
  border-radius: 3px;

  font-family: var(--vr-font-sans);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vr-brand);
  vertical-align: 1px;
}
.rb-row_tag--online {
  border-color: var(--vr-success);
  color: var(--vr-success);
}

.rb-row_sub {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  color: var(--vr-t3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 备注是自由填写的，最长 500 字。一行截断加一个 title —— 让它换行的话，一条长
   备注能把整张卡撑成一屏。 */
.rb-row_note {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rb-row_figures {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
}

.rb-row_status {
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--vr-t3);
  white-space: nowrap;
}
.rb-row_status--live {
  color: var(--vr-success);
}

.rb-row_who {
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-faint);
}

.rb-empty {
  padding: 16px 0;
  font-size: 12px;
  color: var(--color-faint);
  text-align: center;
}
</style>
