<template>
  <header class="content-header" data-cody-region="titlebar" data-cody-component="panel">
    <span class="content-telemetry" aria-hidden="true" />
    <div class="content-leading">
      <slot name="leading" />
    </div>
    <h1 class="content-title">{{ title }}</h1>
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<style scoped>
@reference "../../style.css";

.content-header {
  @apply relative z-50 w-full min-h-14 flex items-center gap-3 px-4;
  background: color-mix(in srgb, var(--color-background) 88%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 68%, transparent);
  backdrop-filter: blur(18px);
}

.content-title {
  @apply m-0 min-w-0 flex-1 truncate text-sm font-semibold leading-6;
  color: var(--color-text);
  letter-spacing: -0.012em;
}

.content-actions {
  @apply flex items-center justify-end gap-1;
}

.content-leading {
  @apply flex items-center gap-1;
}

.content-telemetry {
  position: absolute;
  left: 1rem;
  right: 1rem;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, var(--color-accent) 0 7rem, color-mix(in srgb, var(--color-accent) 22%, transparent) 7rem 28%, transparent 60%);
  box-shadow: 0 0 12px color-mix(in srgb, var(--color-accent) 28%, transparent);
}
</style>
