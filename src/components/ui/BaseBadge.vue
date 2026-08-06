<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "success" | "danger" | "warning" | "info" | "neutral";
    size?: "sm" | "md";
    /** Leading status dot — use for live/online style indicators. */
    dot?: boolean;
    /** Animate the dot (only meaningful with `dot`). */
    pulse?: boolean;
  }>(),
  {
    variant: "neutral",
    size: "md",
    dot: false,
    pulse: false,
  },
);

const classes = computed(() => [
  "badge",
  `badge-${props.variant}`,
  props.size === "sm" ? "px-2 py-0.5 text-[0.6875rem]" : "",
]);

const dotClass = computed(() => [
  "size-1.5 shrink-0 rounded-full bg-current",
  props.pulse ? "animate-pulse" : "",
]);
</script>

<template>
  <span :class="classes">
    <span v-if="dot" :class="dotClass" aria-hidden="true"></span>
    <slot />
  </span>
</template>
