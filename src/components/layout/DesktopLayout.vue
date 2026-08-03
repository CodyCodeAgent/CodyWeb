<template>
  <div class="desktop-layout" data-cody-region="app-shell" :style="layoutStyle">
    <aside v-if="!isSidebarCollapsed" class="desktop-sidebar" data-cody-region="sidebar">
      <slot name="sidebar" />
    </aside>
    <button
      v-if="!isSidebarCollapsed"
      class="desktop-resize-handle"
      type="button"
      aria-label="Resize sidebar"
      role="separator"
      aria-orientation="vertical"
      :aria-valuemin="MIN_SIDEBAR_WIDTH"
      :aria-valuemax="MAX_SIDEBAR_WIDTH"
      :aria-valuenow="Math.round(sidebarWidth)"
      @mousedown="onResizeHandleMouseDown"
      @keydown="onResizeHandleKeyDown"
    />
    <section class="desktop-main" data-cody-region="workspace">
      <slot name="content" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    isSidebarCollapsed?: boolean
  }>(),
  {
    isSidebarCollapsed: false,
  },
)

const SIDEBAR_WIDTH_KEY = 'cody-web-ui.sidebar-width.v1'
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 620
const DEFAULT_SIDEBAR_WIDTH = 320

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
}

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH

  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(parsed)
}

const sidebarWidth = ref(loadSidebarWidth())
const layoutStyle = computed(() => {
  if (props.isSidebarCollapsed) {
    return {
      '--sidebar-width': '0px',
      '--layout-columns': 'minmax(0, 1fr)',
    }
  }
  return {
    '--sidebar-width': `${sidebarWidth.value}px`,
    '--layout-columns': 'var(--sidebar-width) 1px minmax(0, 1fr)',
  }
})

function saveSidebarWidth(value: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value))
}

function onResizeHandleMouseDown(event: MouseEvent): void {
  event.preventDefault()

  const startX = event.clientX
  const startWidth = sidebarWidth.value

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX
    sidebarWidth.value = clampSidebarWidth(startWidth + delta)
  }

  const onMouseUp = () => {
    saveSidebarWidth(sidebarWidth.value)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onResizeHandleKeyDown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') sidebarWidth.value = MIN_SIDEBAR_WIDTH
  else if (event.key === 'End') sidebarWidth.value = MAX_SIDEBAR_WIDTH
  else sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + (event.key === 'ArrowLeft' ? -16 : 16))
  saveSidebarWidth(sidebarWidth.value)
}
</script>

<style scoped>
@reference "../../style.css";

.desktop-layout {
  @apply h-screen grid overflow-hidden;
  grid-template-columns: var(--layout-columns);
  background: var(--color-background);
  color: var(--color-text);
}

.desktop-sidebar {
  @apply min-h-0 overflow-hidden;
  background: var(--color-surface);
}

.desktop-resize-handle {
  @apply relative w-px cursor-col-resize transition;
  background: var(--color-border);
}

.desktop-resize-handle::before {
  content: '';
  @apply absolute -left-2 -right-2 top-0 bottom-0;
}

.desktop-resize-handle:hover,
.desktop-resize-handle:focus-visible {
  z-index: 2;
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent);
}

.desktop-main {
  @apply min-h-0 overflow-y-hidden overflow-x-visible;
  background: var(--color-background);
}
</style>
