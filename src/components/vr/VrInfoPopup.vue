<script setup lang="ts">
/**
 * 浮层卡片 —— vatsim-radar 的 `PopupOverlay`，这套设计里最认得出来的一件。
 *
 * 它取代的是原来那个「右侧固定栏 + 左侧详情抽屉」的两栏结构。区别不只是位置：
 * 原来的详情面板一次只能开一个，而这是一**摞**卡片，选中一架飞机、再点开它的
 * 目的地机场，两张卡并排堆着，互相不挤掉对方。地图始终是整屏的，卡片浮在上面。
 *
 * 三件事是刻意的：
 *
 * - **头部 `position: sticky`。** 卡片内容比 600px 高时自己滚动，标题和关闭键
 *   要一直够得着 —— 否则想关掉一张长卡片得先滚回顶部。
 * - **折叠只收内容，不收头部。** 收起来之后还剩一条 36px 的标题条，它就是这张
 *   卡的书签；整张收掉就等于关掉了，那已经有一个关闭键了。
 * - **分区标题由 `sections` 声明，而不是调用方自己拼。** 这样每张卡的段间距、
 *   顶边、折叠行为都一样 —— 三个不同的人写三张卡，出来还是一套。
 */
import { computed, ref, watch } from "vue";
import VrBlockTitle from "@/components/vr/VrBlockTitle.vue";

export interface InfoPopupSection {
  key: string;
  title?: string;
  collapsible?: boolean;
  collapsedDefault?: boolean;
  bubble?: string | number;
}

const props = withDefaults(
  defineProps<{
    sections?: InfoPopupSection[];
    collapsible?: boolean;
    closable?: boolean;
    maxHeight?: string;
    /** 头部左侧的一小块色标，用来一眼分出这是飞机、席位还是机场。 */
    accent?: string | null;
  }>(),
  {
    collapsible: true,
    closable: true,
    maxHeight: "min(600px, calc(100dvh - 140px))",
    accent: null,
  },
);

const emit = defineEmits<{ close: [] }>();

const collapsed = defineModel<boolean>("collapsed", { default: false });

/** 哪几段被收起来了。按 key 记，所以换一架飞机不会把展开状态带过去。 */
const collapsedSections = ref<string[]>([]);
/* 只在第一次见到某一段时应用它的 collapsedDefault —— 否则数据每 30 秒刷新一次
 * 重算 sections，人手动展开的段会被重新收回去。 */
const seen = new Set<string>();

watch(
  () => props.sections,
  (sections) => {
    for (const section of sections ?? []) {
      if (seen.has(section.key)) continue;
      seen.add(section.key);
      if (section.collapsedDefault) collapsedSections.value.push(section.key);
    }
  },
  { immediate: true, deep: true },
);

const sections = computed(() => props.sections ?? []);

function isCollapsed(key: string) {
  return collapsedSections.value.includes(key);
}

function toggleSection(key: string) {
  collapsedSections.value = isCollapsed(key)
    ? collapsedSections.value.filter((k) => k !== key)
    : [...collapsedSections.value, key];
}
</script>

<template>
  <section
    class="vr-popup vr-appear-right"
    :class="{ 'vr-popup--collapsed': collapsed }"
    :style="{ '--vr-popup-max-height': maxHeight }"
  >
    <header class="vr-popup_header">
      <span
        v-if="accent"
        class="vr-popup_accent"
        :style="{ backgroundColor: accent }"
        aria-hidden="true"
      />
      <h2 class="vr-popup_title vr-h5"><slot name="title" /></h2>

      <div class="vr-popup_actions">
        <slot name="actions" />

        <button
          v-if="collapsible"
          type="button"
          class="vr-popup_action"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <svg
            class="vr-popup_chevron"
            :class="{ 'vr-popup_chevron--collapsed': collapsed }"
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
        </button>

        <button
          v-if="closable"
          type="button"
          class="vr-popup_action vr-popup_action--close"
          @click="emit('close')"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </header>

    <div v-if="!collapsed" class="vr-popup_body">
      <slot name="prepend" />

      <div
        v-for="(section, index) in sections"
        :key="section.key"
        class="vr-popup_section"
      >
        <VrBlockTitle
          v-if="index !== 0 || section.title || section.collapsible"
          :collapsed="section.collapsible ? isCollapsed(section.key) : null"
          :bubble="section.bubble"
          @update:collapsed="toggleSection(section.key)"
        >
          <slot :name="`${section.key}Title`">{{ section.title }}</slot>
        </VrBlockTitle>

        <div
          v-if="!section.collapsible || !isCollapsed(section.key)"
          class="vr-popup_section_content"
        >
          <slot :name="section.key" />
        </div>
      </div>

      <div v-if="$slots.footer" class="vr-popup_footer">
        <slot name="footer" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.vr-popup {
  --vr-popup-padding: 12px;

  display: flex;
  flex-direction: column;
  overflow-y: auto;
  /* 卡片自己滚动，但滚动条不要在里面画一条槽出来 —— 一摞卡片各带一条槽会把
     右边缘切得很碎。 */
  scrollbar-width: none;

  width: 100%;
  max-height: var(--vr-popup-max-height);
  padding-bottom: 8px;
  border: 1px solid var(--vr-stroke);
  border-radius: var(--radius-card);

  color: var(--vr-t2);
  text-align: left;

  background: var(--vr-bg);
  box-shadow: var(--vr-shadow);

  pointer-events: auto;
}
.vr-popup::-webkit-scrollbar {
  display: none;
}

.vr-popup_header {
  position: sticky;
  z-index: 2;
  top: 0;

  display: flex;
  gap: 8px;
  align-items: center;

  padding: 8px var(--vr-popup-padding);
  border-bottom: 1px solid var(--vr-stroke);

  background: var(--vr-bg);

  transition: border-bottom-color 0.5s ease;
}
.vr-popup--collapsed .vr-popup_header {
  border-bottom-color: transparent;
}

.vr-popup_accent {
  flex: none;
  width: 3px;
  height: 16px;
  border-radius: 2px;
}

.vr-popup_title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--vr-t1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vr-popup_actions {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

.vr-popup_action {
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
.vr-popup_action svg {
  width: 14px;
  height: 14px;
}
.vr-popup_action:hover {
  color: var(--vr-brand);
}
/* 关闭键 hover 成红色，并且左边有一条竖线把它和别的动作分开 —— 它是唯一一个
   会丢掉当前这张卡的动作。 */
.vr-popup_action--close {
  padding-left: 8px;
  width: 28px;
  border-left: 1px solid var(--vr-alpha-12);
}
.vr-popup_action--close:hover {
  color: var(--vr-danger);
}

.vr-popup_chevron {
  transition: transform 0.3s ease;
}
.vr-popup_chevron--collapsed {
  transform: rotate(180deg);
}

.vr-popup_body {
  display: flex;
  flex-direction: column;
  gap: 16px;

  margin-top: 8px;
  padding: 0 var(--vr-popup-padding);
}

.vr-popup_section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vr-popup_section_content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vr-popup_footer {
  position: sticky;
  bottom: -8px;

  margin: 0 calc(var(--vr-popup-padding) * -1) -8px;
  padding: 8px var(--vr-popup-padding);

  background: var(--vr-bg);
}
</style>
