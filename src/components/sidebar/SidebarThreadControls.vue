<template>
  <div class="sidebar-thread-controls">
    <button
      class="sidebar-thread-controls-button"
      type="button"
      :aria-label="isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      :title="isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      @click="$emit('toggle-sidebar')"
    >
      <IconTablerLayoutSidebarFilled v-if="isSidebarCollapsed" class="sidebar-thread-controls-icon" />
      <IconTablerLayoutSidebar v-else class="sidebar-thread-controls-icon" />
    </button>

    <button
      class="sidebar-thread-controls-button"
      type="button"
      :aria-label="refreshButtonLabel"
      :title="refreshButtonLabel"
      @click="$emit('refresh')"
    >
      <IconTablerRefresh class="sidebar-thread-controls-icon" />
    </button>

    <slot />

    <button
      v-if="showNewThreadButton"
      class="sidebar-thread-controls-button"
      type="button"
      aria-label="Start new thread"
      title="Start new thread"
      @click="$emit('start-new-thread')"
    >
      <IconTablerFilePencil class="sidebar-thread-controls-icon" />
    </button>
  </div>
</template>

<script setup lang="ts">
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerLayoutSidebar from '../icons/IconTablerLayoutSidebar.vue'
import IconTablerLayoutSidebarFilled from '../icons/IconTablerLayoutSidebarFilled.vue'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'

defineProps<{
  isSidebarCollapsed: boolean
  refreshButtonLabel: string
  showNewThreadButton?: boolean
}>()

defineEmits<{
  'toggle-sidebar': []
  refresh: []
  'start-new-thread': []
}>()
</script>

<style scoped>
@reference "../../style.css";

.sidebar-thread-controls {
  @apply flex flex-row flex-nowrap items-center gap-2;
}

.sidebar-thread-controls-button {
  @apply h-6.75 w-6.75 rounded-md border border-transparent bg-transparent theme-muted flex items-center justify-center transition hover:theme-border hover:theme-bg-subtle;
}

.sidebar-thread-controls-icon {
  @apply w-4 h-4;
}
</style>
