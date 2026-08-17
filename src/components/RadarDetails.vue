<script setup lang="ts">
/**
 * 选中的那架飞机 / 那个席位。
 *
 * 它经历过三种形态。最早是挂在标记上的 Leaflet 弹窗 —— 信息正好压在你想看的那
 * 片交通上，跟着飞机走，到了地图边缘还会被切掉。然后是地图**左边**的一栏，内容
 * 对了，但一次只能开一个，而且把地图挤窄了。
 *
 * 现在是浮在地图右上角的一张卡（vatsim-radar 的 `PopupOverlay`）：地图始终是整
 * 屏的，卡片是一摞 —— 选中一架飞机、再点开它的目的地机场，两张卡并排堆着，谁也
 * 不挤掉谁。
 *
 * 内容和分段没有变，变的是它被放在哪儿、以及怎么排。
 */
import { computed, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import { getFacilityName } from "@/lib/facilities";
import { loadAirports, type AirportTable } from "@/lib/airports";
import {
  altitudeColor,
  distanceNm,
  facilityColor,
  flightLevel,
  isOnGround,
  parseFeedTime,
} from "@/lib/radar";
import { ratingTrans } from "@/lib/tools";
import VrInfoPopup, {
  type InfoPopupSection,
} from "@/components/vr/VrInfoPopup.vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { Controller, Pilot } from "@/lib/radarTypes";

const props = defineProps<{
  messages: Record<string, unknown>;
  pilot?: Pilot | null;
  controller?: Controller | null;
  /** True when the selected station is an ATIS rather than a control position. */
  isAtis?: boolean;
  theme: "dark" | "light";
}>();

const emit = defineEmits<{ (e: "close"): void; (e: "locate"): void }>();

const t = createTranslator(props.messages);

const numbers = new Intl.NumberFormat();

/**
 * "3h 12m" since a logon timestamp.
 *
 * The feed's timestamps are UTC without a marker, so they go through
 * `parseFeedTime` — `new Date()` would read them as local and put every
 * duration out by the viewer's offset.
 */
function onlineFor(logonTime: string): string {
  const start = parseFeedTime(logonTime);
  if (!start) return "—";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - start.getTime()) / 60000),
  );
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The same instant in the viewer's own timezone, for the tooltip. */
function localTime(logonTime: string): string {
  return parseFeedTime(logonTime)?.toLocaleString() ?? "—";
}

/**
 * 四个一眼扫过去的数字，放进并排的小方块里。
 *
 * 原来是六个两列的格子，其中「飞行规则」和「应答机」并不是随时要看的东西 —— 它们
 * 挪进了下面的飞行计划一段。方块里只留高度、高度层、地速、航向：这四个是「这架飞
 * 机现在在干什么」，其余都是「它打算干什么」。
 */
const pilotTiles = computed(() => {
  const p = props.pilot;
  if (!p) return [];
  const altitude = Math.round(p.altitude);
  return [
    { label: t("details.altitude"), value: numbers.format(altitude) },
    { label: t("details.level"), value: `FL${flightLevel(altitude)}` },
    { label: t("details.groundspeed"), value: String(p.groundspeed) },
    { label: t("details.heading"), value: `${Math.round(p.heading)}°` },
  ];
});

const pilotRows = computed(() => {
  const p = props.pilot;
  if (!p) return [];
  return [
    { label: t("details.squawk"), value: String(p.transponder ?? "—") },
    { label: t("details.rules"), value: p.flight_plan?.flight_rules || "—" },
  ];
});

const flightPlanRows = computed(() => {
  const fp = props.pilot?.flight_plan;
  if (!fp) return [];
  return [
    { label: t("details.aircraft"), value: fp.aircraft || "—" },
    { label: t("details.cruise"), value: fp.cruising_altitude || "—" },
    {
      label: t("details.tas"),
      value: fp.cruise_tas ? `${fp.cruise_tas} kts` : "—",
    },
    { label: t("details.alternate"), value: fp.alternate || "—" },
  ];
});

/**
 * Four figures for a position. Facility is not among them — the badge in the
 * header already says CTR — and neither is `visual_range`, which describes how
 * far the controller can see rather than anything a reader of this panel needs.
 * Who is working it and for how long is the more useful pair.
 */
const controllerRows = computed(() => {
  const c = props.controller;
  if (!c) return [];
  const rating = ratingTrans(c.rating, "en", "short");
  return [
    { label: t("details.frequency"), value: c.frequency },
    { label: t("details.member"), value: `${c.name} (${c.cid})` },
    {
      label: t("details.rating"),
      value: typeof rating === "string" ? rating : String(c.rating),
    },
    { label: t("details.online"), value: onlineFor(c.logon_time) },
  ];
});

/** 卡片头部左侧那一小条色标。飞机用它的高度色，席位用它的席位色 —— 和地图上
 *  那个标记是同一个颜色，所以两边对得上。 */
const accent = computed(() => {
  if (props.pilot) return altitudeColor(props.pilot.altitude, props.theme);
  if (props.controller)
    return facilityColor(props.isAtis ? 7 : props.controller.facility);
  return null;
});

/*
 * How far there is left to go, and when that runs out.
 *
 * Both come from the destination's coordinates, so the airport table is pulled
 * in the first time a flight with a filed arrival is selected — the map shares
 * the same copy.
 *
 * The distance is the great circle to the field, not the distance along the
 * filed route, so it reads a little short on a flight that is not going
 * straight there. The ETA divides it by the current groundspeed, which assumes
 * the aircraft keeps its present speed and heading: fine at cruise, optimistic
 * on the descent, meaningless on the ground — so a stationary aircraft gets no
 * ETA at all rather than a fictional one.
 */
const airportTable = ref<AirportTable | null>(null);

watch(
  () => props.pilot?.flight_plan?.arrival,
  async (arrival) => {
    if (arrival && !airportTable.value)
      airportTable.value = await loadAirports();
  },
  { immediate: true },
);

/** Below this groundspeed an ETA would be arithmetic, not information. */
const MIN_ETA_GROUNDSPEED = 30;

const remaining = computed(() => {
  const pilot = props.pilot;
  const icao = pilot?.flight_plan?.arrival?.trim().toUpperCase();
  const destination = icao ? airportTable.value?.[icao] : null;
  if (!pilot || !destination) return null;

  const nm = distanceNm([pilot.latitude, pilot.longitude], destination);
  const hours =
    pilot.groundspeed >= MIN_ETA_GROUNDSPEED ? nm / pilot.groundspeed : null;

  return {
    distance: `${Math.round(nm)} nm`,
    eta:
      hours === null
        ? null
        : {
            clock: new Date(Date.now() + hours * 3600_000).toLocaleTimeString(
              [],
              {
                hour: "2-digit",
                minute: "2-digit",
              },
            ),
            duration:
              hours >= 1
                ? `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`
                : `${Math.max(1, Math.round(hours * 60))}m`,
          },
  };
});

/**
 * 这张卡分几段。
 *
 * 由数据决定而不是写死：没有飞行计划的飞机不该有一段空的「飞行计划」标题，而
 * ATIS 也没有航路那一段。`collapsedDefault` 给了两段 —— 航路原文和备注都很长，
 * 默认展开会把下面的东西全推出屏幕。
 */
const sections = computed<InfoPopupSection[]>(() => {
  const list: InfoPopupSection[] = [];

  if (props.pilot) {
    list.push({ key: "route" });
    list.push({ key: "figures" });
    if (props.pilot.flight_plan) {
      list.push({ key: "plan", title: t("details.flightPlan") });
      if (props.pilot.flight_plan.route)
        list.push({
          key: "routeText",
          title: "ROUTE",
          collapsible: true,
          collapsedDefault: true,
        });
      if (props.pilot.flight_plan.remarks)
        list.push({
          key: "remarks",
          title: "RMK",
          collapsible: true,
          collapsedDefault: true,
        });
    }
    // 无标题：这一段的第一行本来就叫「成员」，再给它一个同名的段标题是同一个词
    // 连着出现两次。没有标题时 VrBlockTitle 只画一条顶边 —— 也就是原来这一段的
    // 样子。
    list.push({ key: "who" });
  }

  if (props.controller) {
    list.push({ key: "figures" });
    if (props.controller.text_atis?.length)
      list.push({
        key: "atisText",
        title: props.isAtis
          ? t("details.atisText")
          : t("details.controllerInfo"),
      });
  }

  return list;
});
</script>

<template>
  <VrInfoPopup
    v-if="pilot || controller"
    :sections="sections"
    :accent="accent"
    @close="emit('close')"
  >
    <template #title>
      <span class="vr-mono">{{ pilot?.callsign ?? controller?.callsign }}</span>
    </template>

    <!-- 定位键放在头部的动作区，和折叠、关闭排在一起。原来它是标题右边两个
         幽灵按钮之一，看上去和标题同级，其实是对整张卡的操作。 -->
    <template #actions>
      <button
        type="button"
        class="vr-popup-action"
        :aria-label="t('details.locate')"
        :title="t('details.locate')"
        @click="emit('locate')"
      >
        <Icon name="mapPin" />
      </button>
    </template>

    <!-- 头部下面那一条：状态和机型。不进任何一段，因为它是这张卡的副标题。 -->
    <template #prepend>
      <div class="rd-subtitle">
        <span
          v-if="pilot"
          class="vr-chip"
          :style="{
            backgroundColor: isOnGround(pilot)
              ? 'var(--vr-t3)'
              : 'var(--vr-success)',
          }"
        >
          {{
            isOnGround(pilot) ? t("details.onGround") : t("details.airborne")
          }}
        </span>
        <span
          v-if="controller"
          class="vr-chip"
          :style="{
            backgroundColor: facilityColor(isAtis ? 7 : controller.facility),
          }"
        >
          {{ isAtis ? "ATIS" : getFacilityName(controller.facility) }}
        </span>
        <span v-if="pilot?.flight_plan?.aircraft" class="rd-subtitle_aircraft">
          {{ pilot.flight_plan.aircraft }}
        </span>
      </div>
    </template>

    <!-- 航路条 -->
    <template #route>
      <div v-if="pilot" class="rd-route">
        <div class="rd-route_line">
          <span class="rd-route_icao">
            {{ pilot.flight_plan?.departure || "----" }}
          </span>
          <span class="rd-route_arrow" aria-hidden="true">
            <Icon name="arrowRight" />
          </span>
          <span class="rd-route_icao">
            {{ pilot.flight_plan?.arrival || "----" }}
          </span>
        </div>

        <p v-if="!pilot.flight_plan" class="rd-route_none">
          {{ t("details.noFlightPlan") }}
        </p>

        <dl v-if="remaining" class="rd-route_eta">
          <div>
            <dt class="vr-row_k">{{ t("details.remaining") }}</dt>
            <dd class="vr-mono">{{ remaining.distance }}</dd>
          </div>
          <div v-if="remaining.eta">
            <dt class="vr-row_k">{{ t("details.eta") }}</dt>
            <dd class="vr-mono">
              {{ remaining.eta.clock }}
              <span class="rd-route_dim">({{ remaining.eta.duration }})</span>
            </dd>
          </div>
        </dl>
      </div>
    </template>

    <!-- 实时数字 -->
    <template #figures>
      <template v-if="pilot">
        <div class="vr-tiles">
          <div v-for="tile in pilotTiles" :key="tile.label" class="vr-tile">
            <span class="vr-tile_k">{{ tile.label }}</span>
            <span class="vr-tile_v">{{ tile.value }}</span>
          </div>
        </div>
        <div class="vr-rows">
          <div v-for="row in pilotRows" :key="row.label" class="vr-row">
            <span class="vr-row_k">{{ row.label }}</span>
            <span class="vr-row_v vr-mono">{{ row.value }}</span>
          </div>
        </div>
      </template>

      <div v-else class="vr-rows">
        <div v-for="row in controllerRows" :key="row.label" class="vr-row">
          <span class="vr-row_k">{{ row.label }}</span>
          <span class="vr-row_v">{{ row.value }}</span>
        </div>
      </div>
    </template>

    <!-- 飞行计划 -->
    <template #plan>
      <div class="vr-rows">
        <div v-for="row in flightPlanRows" :key="row.label" class="vr-row">
          <span class="vr-row_k">{{ row.label }}</span>
          <span class="vr-row_v vr-mono">{{ row.value }}</span>
        </div>
      </div>
    </template>

    <template #routeText>
      <p class="rd-raw">{{ pilot?.flight_plan?.route }}</p>
    </template>

    <template #remarks>
      <p class="rd-raw rd-raw--dim">{{ pilot?.flight_plan?.remarks }}</p>
    </template>

    <template #atisText>
      <div class="rd-atis">
        <p
          v-for="(line, index) in controller?.text_atis ?? []"
          :key="index"
          class="rd-raw"
        >
          {{ line }}
        </p>
      </div>
    </template>

    <!-- 谁在飞，飞了多久 -->
    <template #who>
      <div v-if="pilot" class="vr-rows">
        <div class="vr-row">
          <span class="vr-row_k">{{ t("details.member") }}</span>
          <span class="vr-row_v">{{ pilot.name }}</span>
        </div>
        <div class="vr-row">
          <span class="vr-row_k">ASN ID</span>
          <span class="vr-row_v vr-mono">{{ pilot.cid }}</span>
        </div>
        <div class="vr-row">
          <span class="vr-row_k">{{ t("details.online") }}</span>
          <span class="vr-row_v vr-mono" :title="localTime(pilot.logon_time)">
            {{ onlineFor(pilot.logon_time) }}
          </span>
        </div>
      </div>
    </template>
  </VrInfoPopup>
</template>

<style scoped>
/* 头部动作区的按钮。和 VrInfoPopup 自己的折叠/关闭长一样 —— 那两个是组件内部
   的，这个是插槽传进去的，所以样式要在这边写一份。 */
.rd-subtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.rd-subtitle_aircraft {
  font-family: var(--vr-font-mono);
  font-size: 12px;
  color: var(--color-faint);
}

.rd-route {
  display: flex;
  flex-direction: column;
  gap: 8px;

  padding: 10px;
  border-radius: var(--radius-control);

  background: var(--vr-alpha-4);
}

.rd-route_line {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}

.rd-route_icao {
  font-family: var(--vr-font-alt);
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  color: var(--vr-t1);
}

.rd-route_arrow {
  display: flex;
  flex: none;
  color: var(--color-faint);
}
.rd-route_arrow :deep(svg) {
  width: 16px;
  height: 16px;
}

.rd-route_none {
  font-size: 12px;
  color: var(--color-faint);
  text-align: center;
}

.rd-route_eta {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  font-size: 13px;
  color: var(--vr-t1);
}
.rd-route_eta > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rd-route_dim {
  color: var(--color-faint);
}

/* 原文（航路、备注、ATIS）。等宽 + 允许换行 —— 一条 200 字符的航路必须能折。 */
.rd-raw {
  font-family: var(--vr-font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--vr-t2);
  overflow-wrap: anywhere;
}
.rd-raw--dim {
  color: var(--color-faint);
}

.rd-atis {
  display: flex;
  flex-direction: column;
  gap: 2px;

  padding: 8px;
  border-radius: var(--radius-control);

  background: var(--vr-alpha-4);
}
</style>

<style>
/* 插槽传进 VrInfoPopup 头部的按钮，样式不能靠 scoped —— 它渲染在子组件的
   作用域里。这一条是全局的，名字带 `vr-popup-action` 前缀避免撞车。 */
.vr-popup-action {
  display: flex;
  align-items: center;
  justify-content: center;

  width: 20px;
  height: 20px;
  padding: 0;
  border: none;

  color: var(--vr-t3);

  background: transparent;
  cursor: pointer;

  transition: color 0.3s ease;
}
.vr-popup-action svg {
  width: 14px;
  height: 14px;
}
.vr-popup-action:hover {
  color: var(--vr-brand);
}
</style>
