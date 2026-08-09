<script setup lang="ts">
/**
 * 下划线页签 —— vatsim-radar 的 `UiTabs`。
 *
 * 选中的那一页在下沿画 2px 的品牌色，没选中的只是灰字；hover 时先浮出一条半透
 * 明的 1px，作为「这里能点」的提示。整条页签栏自己带一条底边，所以它同时也是
 * 内容区的上边界，不需要再补一条分隔线。
 */
interface Tab {
  title: string;
  /** 计数，跟在标题后面。 */
  count?: number | string;
  disabled?: boolean;
}

defineProps<{
  tabs: Record<string, Tab>;
  fullWidth?: boolean;
}>();

const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="vr-tabs" :class="{ 'vr-tabs--full': fullWidth }" role="tablist">
    <button
      v-for="(tab, key) in tabs"
      :key="key"
      type="button"
      role="tab"
      class="vr-tabs_tab vr-2b"
      :class="{
        'vr-tabs_tab--active': key === model,
        'vr-tabs_tab--disabled': tab.disabled,
      }"
      :aria-selected="key === model"
      :disabled="tab.disabled"
      @click="model = key"
    >
      {{ tab.title }}
      <span v-if="tab.count !== undefined" class="vr-tabs_count">
        {{ tab.count }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.vr-tabs {
  display: flex;
  align-items: flex-end;

  height: 40px;
  border-bottom: 1px solid var(--vr-stroke);
}

.vr-tabs_tab {
  position: relative;

  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;

  height: 100%;
  padding: 8px 16px;
  border: none;

  font-family: inherit;
  color: var(--vr-t3);
  white-space: nowrap;

  background: transparent;
  cursor: pointer;
}

.vr-tabs--full .vr-tabs_tab {
  flex: 1 1 0;
  min-width: 0;
}

/* 指示条画在自己的伪元素上而不是 border-bottom：border 会把按钮的高度撑掉
   两像素，选中和未选中的文字基线就对不齐了。 */
.vr-tabs_tab::after {
  content: "";

  position: absolute;
  bottom: -1px;
  left: 0;

  width: 100%;
  height: 0;

  background: transparent;

  transition:
    height 0.3s ease,
    background-color 0.3s ease;
}

.vr-tabs_tab:hover:not(.vr-tabs_tab--active, .vr-tabs_tab--disabled) {
  color: var(--vr-t1);
}
.vr-tabs_tab:hover:not(.vr-tabs_tab--active, .vr-tabs_tab--disabled)::after {
  height: 1px;
  background: rgb(var(--vr-brand-rgb) / 0.5);
}

.vr-tabs_tab--active {
  color: var(--vr-t1);
  cursor: default;
}
.vr-tabs_tab--active::after {
  height: 2px;
  background: var(--vr-brand);
}

.vr-tabs_tab--disabled {
  opacity: 0.2;
  pointer-events: none;
}

.vr-tabs_count {
  font-family: var(--vr-font-alt);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-faint);
  font-variant-numeric: tabular-nums;
}
</style>
