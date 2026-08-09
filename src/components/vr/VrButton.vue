<script setup lang="ts">
/**
 * 按钮 —— 照 vatsim-radar 的 `UiButton`。
 *
 * 和 can-web 那套 `.btn` 的区别不在于样子，而在于**默认形态**：那边的次要按钮
 * 有边框有底色，这边的 `secondary` 是完全透明的，只在 hover 时浮出一层 4% 的
 * 白。地图上的控件几乎全是次要按钮，一整列带框的按钮压在地图上会把底下的航迹
 * 切碎，透明的那一版只在指针经过时才出现。
 *
 * `secondary-black` 是有底的那一种，给**浮在地图上**的控件用 —— 透明按钮压在
 * 卫星底图上会看不见。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    type?: "primary" | "secondary" | "secondary-black" | "destructive" | "link";
    size?: "M" | "S";
    /** 只有图标、没有文字时把按钮压成正方形。 */
    icon?: boolean;
    disabled?: boolean;
    active?: boolean;
    href?: string;
    target?: string;
    title?: string;
    ariaLabel?: string;
  }>(),
  { type: "primary", size: "M", icon: false, disabled: false, active: false },
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

/* 有 href 时渲染成 <a>，否则 <button>。不用 <div> —— vatsim-radar 那边用的是
 * div，键盘上完全够不着。 */
const tag = computed(() => (props.href ? "a" : "button"));

function onClick(event: MouseEvent) {
  if (props.disabled) return;
  emit("click", event);
}
</script>

<template>
  <component
    :is="tag"
    class="vr-btn"
    :class="[
      `vr-btn--${type}`,
      `vr-btn--${size}`,
      { 'vr-btn--icon': icon, 'vr-btn--active': active },
    ]"
    :type="tag === 'button' ? 'button' : undefined"
    :disabled="tag === 'button' ? disabled : undefined"
    :aria-disabled="tag === 'a' && disabled ? 'true' : undefined"
    :href="tag === 'a' ? href : undefined"
    :target="target"
    :rel="target === '_blank' ? 'noreferrer' : undefined"
    :title="title"
    :aria-label="ariaLabel"
    @click="onClick"
  >
    <span v-if="$slots.icon" class="vr-btn_icon"><slot name="icon" /></span>
    <span v-if="$slots.default" class="vr-btn_content"><slot /></span>
  </component>
</template>

<style scoped>
.vr-btn {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;

  min-height: 40px;
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-control);

  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--vr-t2);
  text-align: center;
  text-decoration: none;
  white-space: nowrap;

  appearance: none;
  background: transparent;
  cursor: pointer;

  transition:
    background-color 0.3s ease,
    color 0.3s ease;
}

.vr-btn:focus-visible {
  outline: 2px solid var(--vr-brand);
  outline-offset: 1px;
}

.vr-btn:disabled,
.vr-btn[aria-disabled="true"] {
  opacity: 0.24;
  pointer-events: none;
  cursor: default;
}

.vr-btn_icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}
.vr-btn_icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.vr-btn_content {
  min-width: min-content;
}

/* ——— 形态 ——— */

.vr-btn--primary {
  background: var(--vr-brand);
  color: #fff;
}
.vr-btn--primary:hover:not(:disabled) {
  background: var(--vr-brand-hover);
}
.vr-btn--primary:active:not(:disabled) {
  background: var(--vr-brand-active);
}

.vr-btn--secondary:hover:not(:disabled) {
  background: var(--vr-alpha-8);
  color: var(--vr-t1);
}
.vr-btn--secondary:active:not(:disabled) {
  background: rgb(var(--vr-brand-rgb) / 0.32);
}

.vr-btn--secondary-black {
  background: var(--vr-l3);
}
.vr-btn--secondary-black:hover:not(:disabled) {
  background: var(--vr-l4);
  color: var(--vr-t1);
}
.vr-btn--secondary-black:active:not(:disabled) {
  background: var(--vr-l5);
}

.vr-btn--destructive {
  color: var(--vr-danger);
}
.vr-btn--destructive:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vr-danger) 12%, transparent);
}

.vr-btn--link {
  justify-content: flex-start;
  min-height: auto;
  padding: 0;
  border-radius: 0;
  font-size: 12px;
  color: var(--vr-brand);
  text-decoration: underline;
  text-underline-offset: 0.25em;
  background: transparent;
}
.vr-btn--link:hover:not(:disabled) {
  color: var(--vr-brand-hover);
}
.vr-btn--link.vr-btn--icon {
  width: auto;
  height: auto;
}

/* 被按住的那一个（比如打开着的设置面板）用品牌色描一圈，而不是填满 ——
   填满会和主按钮混淆，而它并不是这一屏的主要动作。 */
.vr-btn--active:not(.vr-btn--primary) {
  color: var(--vr-brand);
  box-shadow: inset 0 0 0 1px var(--vr-brand);
}

/* ——— 尺寸 ——— */

.vr-btn--S {
  min-height: 32px;
  padding: 6px 12px;
  font-size: 12px;
}

.vr-btn--icon {
  width: 40px;
  height: 40px;
  padding: 8px;
}
.vr-btn--S.vr-btn--icon {
  width: 32px;
  height: 32px;
  padding: 8px;
}

/* 手指要 44px。桌面上不动 —— 一列 44px 的地图控件会占掉小半个屏幕高。 */
@media (pointer: coarse) {
  .vr-btn:not(.vr-btn--link) {
    min-height: 44px;
  }
  .vr-btn--icon {
    width: 44px;
    height: 44px;
  }
}
</style>
