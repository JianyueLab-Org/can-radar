<script setup lang="ts">
/**
 * 分区标题 —— vatsim-radar 的 `UiBlockTitle`。
 *
 * 浮层里的每一段之间不画整条分隔线，而是给下一段一个**顶边 + 小标题**。分隔线
 * 把面板切成互不相干的格子，顶边则读作「这一段属于上面那一段之后」，在一个
 * 360px 宽、要塞下十几组数据的面板里差别很明显。
 *
 * 可折叠时整行是一个按钮 —— 只把箭头做成热区的话，在触摸屏上几乎点不中。
 */
defineProps<{
  /** 传了就可折叠；不传就是一个静态标题。 */
  collapsed?: boolean | null;
  bubble?: string | number;
}>();

const emit = defineEmits<{ "update:collapsed": [value: boolean] }>();
</script>

<template>
  <component
    :is="collapsed === null || collapsed === undefined ? 'div' : 'button'"
    class="vr-block-title"
    :class="{
      'vr-block-title--collapsible':
        collapsed !== null && collapsed !== undefined,
    }"
    :type="collapsed === null || collapsed === undefined ? undefined : 'button'"
    :aria-expanded="
      collapsed === null || collapsed === undefined ? undefined : !collapsed
    "
    @click="
      collapsed === null || collapsed === undefined
        ? undefined
        : emit('update:collapsed', !collapsed)
    "
  >
    <span class="vr-block-title_text vr-label"><slot /></span>
    <slot name="bubble">
      <span v-if="bubble !== undefined" class="vr-block-title_bubble">
        {{ bubble }}
      </span>
    </slot>
    <span class="vr-block-title_spacer" />
    <svg
      v-if="collapsed !== null && collapsed !== undefined"
      class="vr-block-title_chevron"
      :class="{ 'vr-block-title_chevron--collapsed': collapsed }"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m19.5 15.75-7.5-7.5-7.5 7.5" />
    </svg>
  </component>
</template>

<style scoped>
.vr-block-title {
  display: flex;
  gap: 8px;
  align-items: center;

  width: 100%;
  padding: 8px 0 0;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);

  color: var(--color-ink);
  text-align: left;

  background: transparent;
}

.vr-block-title--collapsible {
  cursor: pointer;
  transition: color 0.3s ease;
}
.vr-block-title--collapsible:hover {
  color: var(--color-can);
}

.vr-block-title_bubble {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: var(--radius-control);

  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;

  background: color-mix(in srgb, var(--color-ink) 12%, transparent);
}

.vr-block-title_spacer {
  flex: 1 1 auto;
}

.vr-block-title_chevron {
  flex: none;
  width: 12px;
  height: 12px;
  transition: transform 0.3s ease;
}
.vr-block-title_chevron--collapsed {
  transform: rotate(180deg);
}
</style>
