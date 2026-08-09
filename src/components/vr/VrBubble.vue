<script setup lang="ts">
/**
 * 计数的小圆点 —— vatsim-radar 的 `UiBubble`。
 *
 * 和徽章（badge）的分工：徽章说的是**是什么**（状态、席位类型），气泡说的是
 * **有几个**。所以它只吃数字，也永远只有一行。
 */
withDefaults(
  defineProps<{ type?: "primary" | "secondary" | "success" | "danger" }>(),
  { type: "primary" },
);
</script>

<template>
  <span class="vr-bubble" :class="`vr-bubble--${type}`"><slot /></span>
</template>

<style scoped>
.vr-bubble {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-control);

  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.vr-bubble--primary {
  background: var(--vr-brand);
  color: #fff;
}
.vr-bubble--secondary {
  background: var(--vr-alpha-12);
  color: var(--vr-t3);
}
.vr-bubble--success {
  background: var(--vr-success);
  color: #fff;
}
.vr-bubble--danger {
  background: var(--vr-danger);
  color: #fff;
}
</style>
