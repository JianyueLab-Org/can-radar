<script setup lang="ts">
/**
 * 活动卡 —— 名单那一摞里的第三张，夹在在线交通和预约管制之间。
 *
 * 位置是这三张卡的时间轴：交通说的是**现在**谁在线，活动说的是**将要**发生什么
 * 事，预约说的是那件事和别的时段各会有谁开席。活动排在预约上面，是因为它是那些
 * 席位的由头 —— 先看到「周六有连飞」，下面那一排 ZBAA_TWR、ZSSS_APP 才有意思。
 *
 * **它对所有人可见**，和预约卡里那一半不一样：can-api 的活动列表和活动详情都没
 * 有守卫，一场活动是公告出去的东西。理由和边界写在 `lib/schedule.ts` 顶上。
 *
 * 数据不是自己取的 —— 活动板同时喂着这张卡和预约卡里的活动席位那一段，一份数据
 * 两个读者，所以取数放在 Radar.vue，这里只显示。
 */
import { computed } from "vue";

import VrInfoPopup from "@/components/vr/VrInfoPopup.vue";
import VrBubble from "@/components/vr/VrBubble.vue";
import { createTranslator } from "@/lib/i18n";
import { activityViews, windowLabel, type Activity } from "@/lib/schedule";

const props = defineProps<{
  messages: Record<string, unknown>;
  activities: Activity[];
  /** 页面那只钟。「进行中」和倒计时跟着它走，不跟着取数走。 */
  now: number;
  /** 主站。活动详情是主站的页面，这里只能链过去（AGENTS 第 4 条）。 */
  siteOrigin: string;
}>();

const collapsed = defineModel<boolean>("collapsed", { default: false });

const t = createTranslator(props.messages);

const views = computed(() => activityViews(props.activities, props.now));

/**
 * 「还有多久」。刻度和预约卡那一处是同一套：一小时以内报分钟，一天以内报小时，
 * 再远报天 —— 一场三天后的活动写成「4320 分钟后」是一个要在心里做除法的数字。
 */
function countdown(minutes: number): string {
  const left = Math.max(0, minutes);
  if (left < 60) return t("bookings.inMinutes", { n: left });
  if (left < 24 * 60)
    return t("bookings.inHours", { n: Math.round(left / 60) });
  return t("bookings.inDays", { n: Math.round(left / (24 * 60)) });
}

function href(id: number): string {
  return `${props.siteOrigin}/activities/${id}`;
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
      <span class="ra-title">{{ t("activities.title") }}</span>
      <VrBubble v-if="views.length" type="secondary">
        {{ views.length }}
      </VrBubble>
    </template>

    <template #list>
      <ul role="list" class="ra-rows">
        <li v-for="view in views" :key="view.activity.id">
          <!-- 整行是一个通往主站活动详情的链接。**新标签页打开**：雷达是一张一
               直开着看的图，把它换成一篇活动说明，人回来时要重新等一次地图。 -->
          <a
            class="ra-row"
            :href="href(view.activity.id)"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="ra-row_main">
              <span class="ra-row_head">
                <span class="ra-row_name">{{ view.activity.title }}</span>
                <span v-if="view.activity.professional" class="ra-row_tag">
                  {{ t("activities.professional") }}
                </span>
              </span>

              <span class="ra-row_sub vr-mono">{{
                windowLabel(view.window)
              }}</span>

              <span class="ra-row_meta">
                <span v-if="view.activity.airports.length" class="vr-mono">
                  {{ view.activity.airports.join(" ") }}
                </span>
                <span>
                  {{
                    t("activities.registered", {
                      n: view.activity.registrationCount,
                    })
                  }}
                </span>
                <span v-if="view.activity.positionCount">
                  {{
                    t("activities.seats", {
                      open: view.activity.openPositionCount,
                      total: view.activity.positionCount,
                    })
                  }}
                </span>
              </span>
            </span>

            <span
              class="ra-row_status"
              :class="{ 'ra-row_status--live': view.live }"
            >
              {{
                view.live
                  ? t("activities.live")
                  : countdown(view.minutesToStart)
              }}
            </span>
          </a>
        </li>
      </ul>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
.ra-title {
  margin-right: 4px;
}

.ra-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 -6px;
}

.ra-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;

  padding: 6px;
  border-radius: 3px;

  color: inherit;
  text-decoration: none;

  transition: background-color 0.2s ease;
}
.ra-row:hover {
  background: var(--vr-alpha-8);
}

.ra-row_main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ra-row_head {
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}

.ra-row_name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--vr-t1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ra-row_tag {
  flex: none;
  padding: 1px 4px;
  border: 1px solid var(--vr-brand);
  border-radius: 3px;

  font-family: var(--vr-font-sans);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vr-brand);
}

.ra-row_sub {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.2;
  color: var(--vr-t3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 机场、报名人数、席位数挤在一行。放不下就截断 —— 这三样都是「扫一眼」的信息，
   换行会让每一行活动的高度取决于它办在几个机场。 */
.ra-row_meta {
  display: flex;
  gap: 8px;
  min-width: 0;
  overflow: hidden;

  font-size: 11px;
  line-height: 1.2;
  color: var(--color-faint);
  white-space: nowrap;
}
.ra-row_meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ra-row_status {
  flex: none;
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--vr-t3);
  white-space: nowrap;
}
.ra-row_status--live {
  color: var(--vr-success);
}
</style>
