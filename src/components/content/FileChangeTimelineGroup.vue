<template>
  <section class="file-change-group-shell">
    <details
      class="file-change-group-card"
      data-testid="file-change-group-card"
      data-kind="fileChange"
      :data-tone="toolStatusTone(group.status)"
      :data-update-count="group.updateCount"
    >
    <summary class="file-change-group-summary">
      <IconTablerChevronRight class="file-change-group-chevron" aria-hidden="true" />
      <span class="file-change-group-headline">
        <strong>Changed</strong>
        <span>{{ fileChangeCountLabel(group.fileCount) }}</span>
        <small v-if="group.updateCount > 1">{{ fileChangeUpdateLabel(group.updateCount) }}</small>
      </span>
      <span class="file-change-group-status">{{ formatToolStatus(group.status) }}</span>
    </summary>

    <div class="file-change-group-body">
      <ol class="file-change-group-updates">
        <li
          v-for="(message, batchIndex) in group.messages"
          :key="message.id"
          class="file-change-group-update"
          data-file-change-update
        >
          <header>
            <span>Update {{ String(batchIndex + 1) }}</span>
            <strong>{{ fileChangeCountLabel(fileChangeMessageCount(message)) }}</strong>
          </header>

          <ul v-if="fileChangeMessageDetails(message).length > 0">
            <li
              v-for="(detail, detailIndex) in fileChangeMessageDetails(message)"
              :key="`${message.id}:${detail}:${String(detailIndex)}`"
            >
              {{ detail }}
            </li>
          </ul>

          <section v-if="message.tool?.output" class="file-change-group-output">
            <div>
              <span>{{ message.tool.outputLabel || 'Diff' }}</span>
              <button
                v-if="isToolOutputTruncated(message.tool.output)"
                type="button"
                @click="toggleOutput(message.id)"
              >
                {{ toolOutputToggleLabel(isOutputExpanded(message.id)) }}
              </button>
            </div>
            <pre><code>{{ renderedOutput(message) }}</code></pre>
          </section>
        </li>
      </ol>
    </div>
    </details>
    <button
      class="file-change-group-open-button"
      type="button"
      aria-label="在代码工作台打开变更"
      title="在代码工作台打开变更"
      @click="emit('openChanges')"
    />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { UiMessage } from '../../types/codex'
import type { FileChangeMessageGroup } from '../../composables/threadToolTimelineRules'
import {
  buildToolOutputPreview,
  fileChangeCountLabel,
  fileChangeMessageCount,
  fileChangeMessageDetails,
  fileChangeUpdateLabel,
  formatToolStatus,
  isToolOutputTruncated,
  toolOutputToggleLabel,
  toolStatusTone,
} from '../../composables/threadToolTimelineRules'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'

defineProps<{
  group: FileChangeMessageGroup
}>()
const emit = defineEmits<{ openChanges: [] }>()

const expandedOutputIds = ref<Record<string, boolean>>({})

function isOutputExpanded(messageId: string): boolean {
  return expandedOutputIds.value[messageId] === true
}

function toggleOutput(messageId: string): void {
  expandedOutputIds.value = {
    ...expandedOutputIds.value,
    [messageId]: !isOutputExpanded(messageId),
  }
}

function renderedOutput(message: UiMessage): string {
  const output = message.tool?.output ?? ''
  if (!output || isOutputExpanded(message.id) || !isToolOutputTruncated(output)) return output
  return buildToolOutputPreview(output)
}
</script>

<style scoped>
.file-change-group-shell {
  position: relative;
  width: min(100%, 47.5rem);
}

.file-change-group-card {
  width: 100%;
  overflow: clip;
  border: 1px solid color-mix(in srgb, var(--color-success) 34%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-success) 5%, var(--color-panel));
  color: var(--color-text);
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-success) 72%, transparent);
}

.file-change-group-summary {
  min-height: 2.75rem;
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  list-style: none;
  transition: background-color var(--motion-fast) ease, border-color var(--motion-fast) ease;
}

.file-change-group-summary::-webkit-details-marker { display: none; }
.file-change-group-summary:hover { background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.file-change-group-summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }

.file-change-group-chevron {
  width: 1rem;
  height: 1rem;
  color: var(--color-text-muted);
  transition: transform var(--motion-fast) ease;
}

.file-change-group-card[open] .file-change-group-chevron { transform: rotate(90deg); }

.file-change-group-headline {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  overflow: hidden;
  font-family: var(--font-mono);
  white-space: nowrap;
  text-align: left;
}

.file-change-group-open-button {
  position: absolute;
  z-index: 1;
  top: 0.5rem;
  right: 6rem;
  left: 2.55rem;
  height: 1.75rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}

.file-change-group-open-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.file-change-group-headline strong { color: var(--color-text); font-size: 0.78rem; }
.file-change-group-headline > span { color: var(--color-text-muted); font-size: 0.72rem; }
.file-change-group-headline small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 0.66rem;
  text-overflow: ellipsis;
}

.file-change-group-status {
  padding: 0.18rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--color-success) 45%, var(--color-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-success) 10%, var(--color-panel));
  color: var(--color-success);
  font-family: var(--font-mono);
  font-size: 0.65rem;
  line-height: 1rem;
}

.file-change-group-card[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-danger) 72%, transparent);
}

.file-change-group-card[data-tone='danger'] .file-change-group-status {
  border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-danger) 10%, var(--color-panel));
  color: var(--color-danger);
}

.file-change-group-card[data-tone='working'] .file-change-group-status {
  border-color: color-mix(in srgb, var(--color-info) 45%, var(--color-border));
  background: color-mix(in srgb, var(--color-info) 10%, var(--color-panel));
  color: var(--color-info);
}

.file-change-group-body {
  border-top: 1px solid color-mix(in srgb, var(--color-border) 76%, transparent);
  padding: 0.25rem 0.75rem 0.75rem 2.6rem;
}

.file-change-group-updates {
  display: grid;
  gap: 0.625rem;
  margin: 0;
  padding: 0.5rem 0 0;
  list-style: none;
}

.file-change-group-update {
  min-width: 0;
  padding-left: 0.75rem;
  border-left: 2px solid color-mix(in srgb, var(--color-success) 40%, var(--color-border));
}

.file-change-group-update header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}

.file-change-group-update header strong { color: var(--color-text); font-weight: 650; }

.file-change-group-update ul {
  display: grid;
  gap: 0.2rem;
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
}

.file-change-group-update > ul > li {
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  line-height: 1.2rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-change-group-output { margin-top: 0.5rem; }
.file-change-group-output > div { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.file-change-group-output span { color: var(--color-text-muted); font-size: 0.68rem; }
.file-change-group-output button {
  min-height: 2rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.66rem;
  transition: background-color var(--motion-fast) ease, color var(--motion-fast) ease;
}
.file-change-group-output button:hover { background: var(--color-elevated); color: var(--color-text); }
.file-change-group-output button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.file-change-group-output pre {
  max-height: 18rem;
  overflow: auto;
  margin: 0.35rem 0 0;
  padding: 0.55rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-background);
  color: var(--color-text);
  font: 0.68rem/1.45 var(--font-mono);
}
.file-change-group-output code { white-space: pre; }

@media (max-width: 700px) {
  .file-change-group-summary { min-height: 3rem; padding-inline: 0.625rem; }
  .file-change-group-headline { gap: 0.4rem; }
  .file-change-group-headline small { display: none; }
  .file-change-group-status { padding-inline: 0.4rem; }
  .file-change-group-body { padding-left: 1rem; }
  .file-change-group-output button { min-height: 2.75rem; }
}

@media (prefers-reduced-motion: reduce) {
  .file-change-group-summary,
  .file-change-group-chevron,
  .file-change-group-output button { transition: none; }
}
</style>
