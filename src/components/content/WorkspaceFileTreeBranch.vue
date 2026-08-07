<template>
  <li class="code-tree-node">
    <button
      class="code-tree-row"
      type="button"
      :data-kind="entry.kind"
      :data-selected="entry.path === selectedPath"
      :style="{ '--tree-depth': String(depth) }"
      :aria-expanded="entry.kind === 'directory' ? isExpanded : undefined"
      :title="entry.path"
      @click="activate"
    >
      <IconTablerChevronRight v-if="entry.kind === 'directory'" class="code-tree-chevron" :data-expanded="isExpanded" />
      <span v-else class="code-tree-spacer" />
      <IconTablerFolderOpen v-if="entry.kind === 'directory' && isExpanded" class="code-tree-icon" />
      <IconTablerFolder v-else-if="entry.kind === 'directory'" class="code-tree-icon" />
      <IconTablerFilePencil v-else class="code-tree-icon" />
      <span class="code-tree-name">{{ entry.name }}</span>
    </button>

    <p v-if="isExpanded && isLoading" class="code-tree-status" :style="{ '--tree-depth': String(depth + 1) }">正在读取…</p>
    <p v-else-if="isExpanded && errorMessage" class="code-tree-status code-tree-error" :style="{ '--tree-depth': String(depth + 1) }">{{ errorMessage }}</p>
    <ol v-else-if="isExpanded && children.length > 0" class="code-tree-list">
      <WorkspaceFileTreeBranch
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :cwd="cwd"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :refresh-key="refreshKey"
        @open-file="emit('openFile', $event)"
      />
    </ol>
    <p v-else-if="isExpanded && hasLoaded" class="code-tree-status" :style="{ '--tree-depth': String(depth + 1) }">空目录</p>
  </li>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { fetchWorkspaceFiles } from '../../api/codexWorkspaceResourcesClient'
import type { UiWorkspaceFileEntry } from '../../types/codex'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerFolderOpen from '../icons/IconTablerFolderOpen.vue'

const props = defineProps<{
  entry: UiWorkspaceFileEntry
  cwd: string
  depth: number
  selectedPath: string
  refreshKey: number
}>()

const emit = defineEmits<{
  openFile: [{ path: string; line?: number }]
}>()

const isExpanded = ref(false)
const isLoading = ref(false)
const hasLoaded = ref(false)
const errorMessage = ref('')
const children = ref<UiWorkspaceFileEntry[]>([])

async function loadChildren(): Promise<void> {
  if (props.entry.kind !== 'directory' || isLoading.value) return
  isLoading.value = true
  errorMessage.value = ''
  try {
    const listing = await fetchWorkspaceFiles(props.cwd, props.entry.path)
    children.value = listing.entries
    hasLoaded.value = true
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '目录读取失败'
  } finally {
    isLoading.value = false
  }
}

function activate(): void {
  if (props.entry.kind === 'file') {
    emit('openFile', { path: props.entry.path })
    return
  }
  isExpanded.value = !isExpanded.value
  if (isExpanded.value && !hasLoaded.value) void loadChildren()
}

watch(() => props.refreshKey, () => {
  if (!hasLoaded.value) return
  void loadChildren()
})
</script>

<style scoped>
.code-tree-list { margin: 0; padding: 0; list-style: none; }
.code-tree-row {
  width: 100%; min-height: 2rem; display: flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.5rem 0.3rem calc(0.5rem + var(--tree-depth) * 0.85rem);
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted);
  text-align: left; cursor: pointer; transition: background-color var(--motion-fast) ease, color var(--motion-fast) ease;
}
.code-tree-row:hover { background: var(--color-control); color: var(--color-text); }
.code-tree-row:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.code-tree-row[data-selected='true'] { background: color-mix(in srgb, var(--color-accent) 13%, var(--color-panel)); color: var(--color-text); }
.code-tree-chevron, .code-tree-icon, .code-tree-spacer { width: 0.9rem; height: 0.9rem; flex: 0 0 auto; }
.code-tree-chevron { transition: transform var(--motion-fast) ease; }
.code-tree-chevron[data-expanded='true'] { transform: rotate(90deg); }
.code-tree-name { overflow: hidden; font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
.code-tree-status { margin: 0; padding: 0.35rem 0.5rem 0.35rem calc(2.1rem + var(--tree-depth) * 0.85rem); color: var(--color-text-muted); font-size: 0.68rem; }
.code-tree-error { color: var(--color-danger); }
</style>
