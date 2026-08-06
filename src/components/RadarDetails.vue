<script setup lang="ts">
/**
 * The selected aircraft's or position's details.
 *
 * This used to be a Leaflet popup anchored to the marker, which put the
 * information exactly where it was most in the way: on top of the traffic
 * around the aircraft you were reading about, moving whenever it moved, and
 * clipped by the map edge near the border. vatsim-radar docks the same content
 * in a panel beside the map instead, and that is what this is.
 *
 * It renders whatever is selected — the map and the traffic list share that
 * selection — and nothing when nothing is.
 */
import { computed, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import { getFacilityName } from "@/lib/facilities";
import { loadAirports, type AirportTable } from "@/lib/airports";
import {
  altitudeColor,
  distanceNm,
  flightLevel,
  isOnGround,
  parseFeedTime,
} from "@/lib/radar";
import { ratingTrans } from "@/lib/tools";
import BaseBadge from "@/components/ui/BaseBadge.vue";
import Icon from "@/components/ui/Icon.vue";
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

const pilotStats = computed(() => {
  const p = props.pilot;
  if (!p) return [];
  const altitude = Math.round(p.altitude);
  return [
    { label: t("details.altitude"), value: `${numbers.format(altitude)} ft` },
    { label: t("details.level"), value: `FL${flightLevel(altitude)}` },
    { label: t("details.groundspeed"), value: `${p.groundspeed} kts` },
    { label: t("details.heading"), value: `${Math.round(p.heading)}°` },
    { label: t("details.squawk"), value: String(p.transponder ?? "—") },
    {
      label: t("details.rules"),
      value: p.flight_plan?.flight_rules || "—",
    },
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
const controllerStats = computed(() => {
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

const dotColor = computed(() =>
  props.pilot ? altitudeColor(props.pilot.altitude, props.theme) : "",
);

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
</script>

<template>
  <aside
    v-if="pilot || controller"
    class="absolute inset-y-0 left-0 z-20 flex w-80 max-w-[85vw] flex-col border-r border-subtle bg-surface-raised shadow-popover lg:static lg:z-0 lg:max-w-none lg:shadow-none"
    :aria-label="t('details.title')"
  >
    <!-- Header -->
    <div class="flex shrink-0 items-start gap-2 border-b border-subtle p-3">
      <span
        v-if="pilot"
        class="mt-1.5 size-2.5 shrink-0 rounded-full"
        :style="{ backgroundColor: dotColor }"
        aria-hidden="true"
      ></span>
      <div class="min-w-0 flex-1">
        <p class="truncate font-mono text-base font-semibold text-ink">
          {{ pilot?.callsign ?? controller?.callsign }}
        </p>
        <p class="mt-0.5 flex flex-wrap items-center gap-1.5">
          <BaseBadge
            v-if="pilot"
            :variant="isOnGround(pilot) ? 'neutral' : 'success'"
            size="sm"
          >
            {{
              isOnGround(pilot) ? t("details.onGround") : t("details.airborne")
            }}
          </BaseBadge>
          <BaseBadge
            v-if="controller"
            :variant="isAtis ? 'warning' : 'info'"
            size="sm"
          >
            {{ isAtis ? "ATIS" : getFacilityName(controller.facility) }}
          </BaseBadge>
          <span
            v-if="pilot?.flight_plan?.aircraft"
            class="font-mono text-xs text-muted"
          >
            {{ pilot.flight_plan.aircraft }}
          </span>
        </p>
      </div>

      <button
        type="button"
        class="btn btn-ghost size-8 shrink-0 p-0"
        :aria-label="t('details.locate')"
        :title="t('details.locate')"
        @click="emit('locate')"
      >
        <Icon name="magnifyingGlass" class="size-4" />
      </button>
      <button
        type="button"
        class="btn btn-ghost size-8 shrink-0 p-0"
        :aria-label="t('details.close')"
        :title="t('details.close')"
        @click="emit('close')"
      >
        <Icon name="xMark" class="size-4" />
      </button>
    </div>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <!-- Route -->
      <div v-if="pilot" class="rounded-control bg-surface-sunken p-3">
        <div
          class="flex items-center justify-between gap-2 font-mono text-sm font-semibold text-ink"
        >
          <span>{{ pilot.flight_plan?.departure || "----" }}</span>
          <Icon name="arrowRight" class="size-4 shrink-0 text-faint" />
          <span>{{ pilot.flight_plan?.arrival || "----" }}</span>
        </div>
        <p
          v-if="!pilot.flight_plan"
          class="mt-1 text-center text-xs text-faint"
        >
          {{ t("details.noFlightPlan") }}
        </p>

        <dl
          v-if="remaining"
          class="mt-2 flex items-baseline justify-between gap-3 text-xs"
        >
          <div class="flex items-baseline gap-1.5">
            <dt class="text-faint">{{ t("details.remaining") }}</dt>
            <dd class="tnum font-mono text-ink">{{ remaining.distance }}</dd>
          </div>
          <div v-if="remaining.eta" class="flex items-baseline gap-1.5">
            <dt class="text-faint">{{ t("details.eta") }}</dt>
            <dd class="tnum font-mono text-ink">
              {{ remaining.eta.clock }}
              <span class="text-muted">({{ remaining.eta.duration }})</span>
            </dd>
          </div>
        </dl>
      </div>

      <!-- Live figures -->
      <dl class="grid grid-cols-2 gap-2">
        <div
          v-for="item in pilot ? pilotStats : controllerStats"
          :key="item.label"
          class="rounded-control bg-surface-sunken px-3 py-2"
        >
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ item.label }}
          </dt>
          <dd class="tnum mt-0.5 truncate font-mono text-sm text-ink">
            {{ item.value }}
          </dd>
        </div>
      </dl>

      <!-- Flight plan -->
      <section v-if="pilot?.flight_plan" class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-faint">
          {{ t("details.flightPlan") }}
        </h3>
        <dl class="space-y-1">
          <div
            v-for="row in flightPlanRows"
            :key="row.label"
            class="flex items-baseline justify-between gap-3 text-sm"
          >
            <dt class="shrink-0 text-muted">{{ row.label }}</dt>
            <dd class="truncate font-mono text-ink">{{ row.value }}</dd>
          </div>
        </dl>
        <div
          v-if="pilot.flight_plan.route"
          class="rounded-control bg-surface-sunken p-2"
        >
          <p class="break-words font-mono text-xs leading-relaxed text-muted">
            {{ pilot.flight_plan.route }}
          </p>
        </div>
        <div
          v-if="pilot.flight_plan.remarks"
          class="rounded-control bg-surface-sunken p-2"
        >
          <p class="break-words font-mono text-xs leading-relaxed text-faint">
            {{ pilot.flight_plan.remarks }}
          </p>
        </div>
      </section>

      <!-- ATIS / controller info text -->
      <section v-if="controller?.text_atis?.length" class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-faint">
          {{ isAtis ? t("details.atisText") : t("details.controllerInfo") }}
        </h3>
        <div class="rounded-control bg-surface-sunken p-2">
          <p
            v-for="(line, index) in controller.text_atis"
            :key="index"
            class="break-words font-mono text-xs leading-relaxed text-muted"
          >
            {{ line }}
          </p>
        </div>
      </section>

      <!-- Who and how long. A position carries both in its figures already. -->
      <section
        v-if="pilot"
        class="space-y-1 border-t border-subtle pt-3 text-sm"
      >
        <div class="flex items-baseline justify-between gap-3">
          <span class="shrink-0 text-muted">{{ t("details.member") }}</span>
          <span class="truncate text-ink">{{ pilot.name }}</span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="shrink-0 text-muted">ASN ID</span>
          <span class="tnum font-mono text-ink">{{ pilot.cid }}</span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="shrink-0 text-muted">{{ t("details.online") }}</span>
          <span
            class="tnum truncate text-ink"
            :title="localTime(pilot.logon_time)"
          >
            {{ onlineFor(pilot.logon_time) }}
          </span>
        </div>
      </section>
    </div>
  </aside>
</template>
