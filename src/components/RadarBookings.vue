<script setup lang="ts">
/**
 * 预约管制的那张卡 —— 名单那一摞里的最后一张。
 *
 * 它回答的是「等一下有谁开席」，而在线交通回答的是「现在谁在线」，中间的活动卡
 * 回答的是「等一下有什么事」。
 *
 * 卡上有**两段**，来源和可见性都不一样，这一点是它最要紧的性质：
 *
 * - **活动席位**（`seats`）来自公开的活动板，由 Radar.vue 取好传进来，**人人可
 *   见**。它是「某人报名了某场活动的某个席位」，也就是一句「那天那个时段我开这
 *   个席位」。
 * - **个人预约**（自己取）来自 can-api 的预约板，那条挂在 `WithPilot` 后面，
 *   **登录之后才有**。没登录时这一段连标题都不出现 —— 不是出现之后写一句劝人登
 *   录的话，页眉上那个「登录」已经是入口了。
 *
 * 两段的边界不是这里定的，是两个上游本来就不同的答案；理由写在 `lib/schedule.ts`
 * 顶上。**别为了「统一」把任何一边改成另一边。**
 *
 * 两段各自按时间排，而不是并成一列 —— 一条个人预约和一个活动席位是两种承诺，混
 * 排之后「今晚这场活动有几个人」这件事就要靠眼睛去数。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import VrInfoPopup, {
  type InfoPopupSection,
} from "@/components/vr/VrInfoPopup.vue";
import { getFacilityName } from "@/lib/facilities";
import { createTranslator } from "@/lib/i18n";
import { facilityColor } from "@/lib/radar";
import {
  fetchReservations,
  reservationEntries,
  seatEntries,
  staffingViews,
  windowLabel,
  type ActivitySeat,
  type Reservation,
  type StaffingView,
} from "@/lib/schedule";
import type { Controller } from "@/lib/radarTypes";

const props = defineProps<{
  messages: Record<string, unknown>;
  /** 此刻在线的席位，只用来认出「这条预约的人已经上来了」。 */
  controllers: Controller[];
  selected: string | null;
  /** 活动板里已经有人预约的席位，由 Radar.vue 取好传进来。 */
  seats: ActivitySeat[];
  /** 登录着吗。个人预约那一段的开关，也是要不要向上游问的开关。 */
  signedIn: boolean;
  /** 看这张卡的人的 CID，没登录是 null。只用来给活动席位判 `mine`。 */
  memberId: string | null;
  /** 页面那只钟。 */
  now: number;
  /** 主站。活动席位那一行链回它所属的那场活动（AGENTS 第 4 条）。 */
  siteOrigin: string;
}>();

const emit = defineEmits<{ (e: "select", key: string): void }>();

const collapsed = defineModel<boolean>("collapsed", { default: false });

const t = createTranslator(props.messages);

/** 五分钟重取一次。预约是几小时前写下的，比这更勤没有任何东西会变。 */
const REFRESH_MS = 5 * 60 * 1000;

/** `null` 是取不到，`[]` 是板子空的。两者写的不是同一句话，见 fetchReservations。 */
const reservations = ref<Reservation[] | null>(null);
const loading = ref(true);

let refresh: ReturnType<typeof setInterval> | null = null;
let inflight: AbortController | null = null;

async function load() {
  // 没登录就不问上游 —— 这一页绝大多数请求不带 cookie，而带 cookie 才问是这个站
  // 点的一条规矩（AGENTS 第 5 条）。
  if (!props.signedIn) {
    reservations.value = null;
    loading.value = false;
    return;
  }

  inflight?.abort();
  inflight = new AbortController();
  const result = await fetchReservations(inflight.signal);
  // 中止掉的那一次不要覆盖后来的结果：AbortError 也是 null，直接写回去会把刚取
  // 到的板子擦成「取不到」。
  if (inflight.signal.aborted) return;
  reservations.value = result;
  loading.value = false;
}

onMounted(() => {
  load();
  refresh = setInterval(load, REFRESH_MS);
});

onBeforeUnmount(() => {
  if (refresh) clearInterval(refresh);
  inflight?.abort();
});

// 在另一个标签页登录完再回来时，Header 会把会话认出来 —— 这一段跟着补一次，否则
// 「我明明登录了」要等到下一个五分钟。
watch(() => props.signedIn, load);

const reservationRows = computed<StaffingView[]>(() =>
  reservations.value
    ? staffingViews(reservationEntries(reservations.value), props.now)
    : [],
);

const seatRows = computed<StaffingView[]>(() =>
  staffingViews(seatEntries(props.seats, props.memberId), props.now),
);

/**
 * 分段。个人预约那一段只在登录之后存在 —— 一个永远空着、写着「登录后可见」的分
 * 段，比没有这个分段更让人以为是坏了。
 */
const sections = computed<InfoPopupSection[]>(() => {
  const out: InfoPopupSection[] = [];
  if (props.signedIn) {
    out.push({
      key: "reservations",
      title: t("bookings.reservations"),
      bubble: reservationRows.value.length || undefined,
    });
  }
  out.push({
    key: "seats",
    title: t("bookings.activitySeats"),
    bubble: seatRows.value.length || undefined,
  });
  return out;
});

/** 此刻在线的呼号。预约里出现同一个呼号时，那一行就是可以点开的。 */
const onlineCallsigns = computed(
  () => new Set(props.controllers.map((c) => c.callsign.toUpperCase())),
);

function isOnline(view: StaffingView): boolean {
  return onlineCallsigns.value.has(view.entry.callsign);
}

function selectionKey(view: StaffingView): string {
  return `atc:${view.entry.callsign}`;
}

/**
 * 「还有多久」。
 *
 * 一小时以内报分钟，一天以内报小时，再远报天 —— 一条三天后的预约写成「4320 分钟
 * 后」是一个要在心里做除法才能读的数字。
 */
function countdown(minutes: number): string {
  const left = Math.max(0, minutes);
  if (left < 60) return t("bookings.inMinutes", { n: left });
  if (left < 24 * 60)
    return t("bookings.inHours", { n: Math.round(left / 60) });
  return t("bookings.inDays", { n: Math.round(left / (24 * 60)) });
}

function activityHref(view: StaffingView): string | null {
  return view.entry.activityId === null
    ? null
    : `${props.siteOrigin}/activities/${view.entry.activityId}`;
}
</script>

<template>
  <VrInfoPopup
    v-model:collapsed="collapsed"
    :sections="sections"
    :closable="false"
    max-height="min(50dvh, 480px)"
  >
    <template #title>{{ t("bookings.title") }}</template>

    <!-- 个人预约。登录之后才有这一段。 -->
    <template #reservations>
      <p v-if="loading" class="rb-empty">…</p>

      <!-- 取不到和板子空的分开说。合成一句的话，上游挂了会显示成「今晚没有人预
           约」，而那是这张卡最不该说错的一句。 -->
      <p v-else-if="!reservations" class="rb-empty">
        {{ t("bookings.error") }}
      </p>
      <p v-else-if="!reservationRows.length" class="rb-empty">
        {{ t("bookings.empty") }}
      </p>

      <ul v-else role="list" class="rb-rows">
        <li v-for="view in reservationRows" :key="view.entry.key">
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
              :style="{ background: facilityColor(view.entry.facility) }"
            >
              {{ getFacilityName(view.entry.facility) }}
            </span>

            <span class="rb-row_main">
              <span class="rb-row_callsign">
                {{ view.entry.callsign }}
                <span v-if="view.entry.mine" class="rb-row_tag">
                  {{ t("bookings.mine") }}
                </span>
                <span
                  v-if="isOnline(view)"
                  class="rb-row_tag rb-row_tag--online"
                >
                  {{ t("bookings.online") }}
                </span>
              </span>

              <span class="rb-row_sub vr-mono">{{
                windowLabel(view.window)
              }}</span>

              <span
                v-if="view.entry.note"
                class="rb-row_note"
                :title="view.entry.note"
              >
                {{ view.entry.note }}
              </span>
            </span>

            <span class="rb-row_figures">
              <span
                class="rb-row_status"
                :class="{ 'rb-row_status--live': view.live }"
              >
                {{
                  view.live
                    ? t("bookings.live")
                    : countdown(view.minutesToStart)
                }}
              </span>
              <span v-if="view.entry.username" class="rb-row_who vr-mono">
                {{ view.entry.username }}
              </span>
            </span>
          </component>
        </li>
      </ul>
    </template>

    <!-- 活动报名的席位。公开的，人人可见。 -->
    <template #seats>
      <p v-if="!seatRows.length" class="rb-empty">
        {{ t("bookings.noSeats") }}
      </p>

      <ul v-else role="list" class="rb-rows">
        <li v-for="view in seatRows" :key="view.entry.key">
          <!-- 已经上线的点开的是**地图上那个席位**；还没上线的整行链去主站那场活
               动 —— 一个活动席位的下一句话总是「那是什么活动」，而那篇说明在主站
               上。两者不会同时成立，所以这一行只有一种去处，不必猜。 -->
          <component
            :is="isOnline(view) ? 'button' : 'a'"
            :type="isOnline(view) ? 'button' : undefined"
            :href="isOnline(view) ? undefined : activityHref(view)"
            :target="isOnline(view) ? undefined : '_blank'"
            :rel="isOnline(view) ? undefined : 'noopener noreferrer'"
            class="rb-row rb-row--clickable"
            :class="{ 'rb-row--selected': selected === selectionKey(view) }"
            :aria-pressed="
              isOnline(view) ? selected === selectionKey(view) : undefined
            "
            @click="isOnline(view) && emit('select', selectionKey(view))"
          >
            <span
              class="vr-chip rb-row_chip"
              :style="{ background: facilityColor(view.entry.facility) }"
            >
              {{ getFacilityName(view.entry.facility) }}
            </span>

            <span class="rb-row_main">
              <span class="rb-row_callsign">
                {{ view.entry.callsign }}
                <span v-if="view.entry.mine" class="rb-row_tag">
                  {{ t("bookings.mine") }}
                </span>
                <span
                  v-if="isOnline(view)"
                  class="rb-row_tag rb-row_tag--online"
                >
                  {{ t("bookings.online") }}
                </span>
              </span>

              <span class="rb-row_sub vr-mono">{{
                windowLabel(view.window)
              }}</span>

              <!-- 活动标题就是这一行的备注：它说清楚这个席位为什么会有人。 -->
              <span
                v-if="view.entry.note"
                class="rb-row_note"
                :title="view.entry.note"
              >
                {{ view.entry.note }}
              </span>
            </span>

            <span class="rb-row_figures">
              <span
                class="rb-row_status"
                :class="{ 'rb-row_status--live': view.live }"
              >
                {{
                  view.live
                    ? t("bookings.live")
                    : countdown(view.minutesToStart)
                }}
              </span>
              <span v-if="view.entry.username" class="rb-row_who vr-mono">
                {{ view.entry.username }}
              </span>
            </span>
          </component>
        </li>
      </ul>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
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
  color: inherit;
  text-align: left;
  text-decoration: none;

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

/* 备注是自由填写的，最长 500 字；活动标题也可能很长。一行截断加一个 title ——
   让它换行的话，一条长备注能把整张卡撑成一屏。 */
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
