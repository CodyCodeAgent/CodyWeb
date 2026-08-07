<template>
  <section class="code-workbench" :data-navigator-collapsed="isNavigatorCollapsed" :data-chat-collapsed="isChatCollapsed">
    <aside v-if="!isNavigatorCollapsed" class="code-navigator" aria-label="代码导航">
      <header class="code-navigator-header">
        <div class="code-navigator-tabs" role="tablist" aria-label="代码导航视图">
          <button v-for="option in navigatorOptions" :key="option.id" type="button" role="tab"
            :aria-selected="navigatorMode === option.id" :data-active="navigatorMode === option.id"
            @click="navigatorMode = option.id">
            {{ option.label }}
            <span v-if="option.id === 'changes' && diffReview.files.length > 0">{{ diffReview.files.length }}</span>
          </button>
        </div>
        <button class="code-icon-button" type="button" aria-label="收起代码导航" title="收起代码导航" @click="isNavigatorCollapsed = true">
          <IconTablerChevronLeft />
        </button>
      </header>

      <div v-if="navigatorMode === 'changes'" class="code-navigator-body">
        <p v-if="isLoadingFallbackDiff" class="code-empty">正在读取工作区变更…</p>
        <p v-else-if="diffReview.files.length === 0" class="code-empty">当前任务还没有文件变更。</p>
        <ol v-else class="code-change-list">
          <li v-for="file in diffReview.files" :key="file.filePath">
            <button type="button" :data-selected="activePath === file.filePath" @click="openChangedFile(file)">
              <span class="code-change-status" :data-status="file.status">{{ fileStatusLabel(file.status) }}</span>
              <span class="code-change-path"><strong>{{ basename(file.filePath) }}</strong><small>{{ dirname(file.filePath) }}</small></span>
              <span class="code-change-lines"><b>+{{ file.addedLines }}</b><i>-{{ file.removedLines }}</i></span>
            </button>
            <small v-if="file.oldPath" class="code-change-old-path">原路径 {{ file.oldPath }}</small>
          </li>
        </ol>
      </div>

      <div v-else-if="navigatorMode === 'files'" class="code-navigator-body">
        <div class="code-tree-toolbar">
          <nav class="code-breadcrumbs" aria-label="文件目录">
            <button type="button" @click="setTreeBasePath('')">根目录</button>
            <template v-for="crumb in treeBreadcrumbs" :key="crumb.path">
              <span>/</span><button type="button" @click="setTreeBasePath(crumb.path)">{{ crumb.label }}</button>
            </template>
          </nav>
          <button class="code-icon-button" type="button" aria-label="刷新文件树" title="刷新文件树" @click="refreshTree">
            <IconTablerRefresh />
          </button>
        </div>
        <p v-if="isLoadingTree" class="code-empty">正在读取目录…</p>
        <p v-else-if="treeError" class="code-empty code-error">{{ treeError }}</p>
        <ol v-else class="code-tree-list">
          <WorkspaceFileTreeBranch v-for="entry in treeEntries" :key="entry.path" :entry="entry" :cwd="cwd"
            :depth="0" :selected-path="activePath" :refresh-key="treeRefreshKey" @open-file="openLocation($event)" />
        </ol>
        <p v-if="treeTruncated" class="code-empty">目录内容较多，仅显示前 200 项。</p>
      </div>

      <div v-else class="code-navigator-body code-search-panel">
        <label class="code-search-field">
          <IconTablerSearch />
          <input ref="searchInputRef" v-model="searchQuery" type="search" autocomplete="off" spellcheck="false"
            :placeholder="searchScope === 'files' ? '搜索文件名…' : '搜索代码内容…'" @keydown.down.prevent="moveSearchSelection(1)"
            @keydown.up.prevent="moveSearchSelection(-1)" @keydown.enter.prevent="openSelectedSearchResult" />
        </label>
        <div class="code-search-scope" role="group" aria-label="搜索范围">
          <button type="button" :data-active="searchScope === 'files'" @click="searchScope = 'files'">文件</button>
          <button type="button" :data-active="searchScope === 'content'" @click="searchScope = 'content'">内容</button>
        </div>
        <p v-if="isSearching" class="code-empty">正在搜索…</p>
        <p v-else-if="searchError" class="code-empty code-error">{{ searchError }}</p>
        <p v-else-if="searchQuery.trim() && searchResults.length === 0" class="code-empty">没有匹配结果。</p>
        <ol v-else class="code-search-results">
          <li v-for="(item, index) in searchResults" :key="`${item.path}:${String(item.line)}:${String(item.column)}`">
            <button type="button" :data-active="selectedSearchIndex === index" @mousemove="selectedSearchIndex = index" @click="openSearchResult(item)">
              <strong>{{ item.path }}<span v-if="item.line">:{{ item.line }}</span></strong>
              <small>{{ item.preview }}</small>
            </button>
          </li>
        </ol>
        <p v-if="searchTruncated" class="code-empty">结果已截断，请缩小搜索范围。</p>
      </div>
    </aside>

    <button v-else class="code-rail-button" type="button" aria-label="展开代码导航" title="展开代码导航" @click="isNavigatorCollapsed = false">
      <IconTablerFolderOpen />
    </button>

    <main class="code-editor-shell">
      <header class="code-editor-header">
        <div class="code-tabs" role="tablist" aria-label="已打开文件">
          <button v-for="tab in tabs" :key="tab.id" class="code-tab" type="button" role="tab"
            :aria-selected="tab.path === activePath" :data-active="tab.path === activePath" @click="activateTab(tab)">
            <span>{{ tab.name }}</span>
            <IconTablerX class="code-tab-close" aria-label="关闭标签" @click.stop="closeTab(tab.path)" />
          </button>
          <p v-if="tabs.length === 0">尚未打开文件</p>
        </div>
        <div class="code-editor-actions">
          <button class="code-icon-button" type="button" :aria-pressed="isWordWrap" :title="isWordWrap ? '关闭自动换行' : '开启自动换行'" @click="isWordWrap = !isWordWrap">↩</button>
          <button class="code-icon-button" type="button" :aria-label="isChatCollapsed ? '展开对话' : '收起对话'" :title="isChatCollapsed ? '展开对话' : '收起对话'" @click="isChatCollapsed = !isChatCollapsed">
            <IconTablerLayoutSidebar />
          </button>
        </div>
      </header>

      <div v-if="activePath" class="code-location-bar">
        <nav aria-label="当前文件路径">
          <button type="button" @click="setTreeBasePath('')">{{ projectName }}</button>
          <template v-for="crumb in activeBreadcrumbs" :key="crumb.directoryPath">
            <span>/</span><button type="button" @click="setTreeBasePath(crumb.directoryPath)">{{ crumb.label }}</button>
          </template>
        </nav>
        <div v-if="activeDiffFile" class="code-view-toggle" role="group" aria-label="文件视图">
          <button type="button" :disabled="activeDiffFile.status === 'deleted'" :data-active="activeMode === 'file'" @click="setActiveMode('file')">文件</button>
          <button type="button" :data-active="activeMode === 'diff'" @click="setActiveMode('diff')">Diff</button>
        </div>
      </div>

      <section class="code-editor-stage" aria-live="polite">
        <div v-if="!activePath" class="code-welcome">
          <IconTablerFolderOpen />
          <h2>浏览这个工作区</h2>
          <p>从左侧选择变更或文件，也可以使用 <kbd>⌘ P</kbd> 快速查找。</p>
        </div>
        <div v-else-if="isLoadingFile && activeMode === 'file'" class="code-loading-skeleton" aria-label="正在读取文件">
          <span v-for="index in 12" :key="index" :style="{ width: `${String(42 + (index * 17) % 50)}%` }" />
        </div>
        <div v-else-if="fileError && activeMode === 'file'" class="code-welcome code-error-state">
          <h2>无法打开文件</h2><p>{{ fileError }}</p>
          <button type="button" @click="loadActiveFile">重试</button>
        </div>
        <div v-else-if="activeMode === 'diff'" class="code-diff-viewer">
          <p v-if="!activeDiffFile?.patch" class="code-empty">该文件没有可展示的 Diff 快照。</p>
          <template v-else>
            <section v-for="(hunk, hunkIndex) in activeDiffFile.hunks" :key="`${hunk.header}:${String(hunkIndex)}`" class="code-diff-hunk">
              <header>{{ hunk.header }}</header>
              <div v-for="(line, lineIndex) in hunk.lines" :key="`${String(hunkIndex)}:${String(lineIndex)}`" class="code-diff-line" :data-kind="line.kind">
                <span>{{ line.oldLineNumber ?? '' }}</span><span>{{ line.newLineNumber ?? '' }}</span><i>{{ diffPrefix(line.kind) }}</i><code>{{ line.content }}</code>
              </div>
            </section>
            <pre v-if="activeDiffFile.hunks.length === 0"><code>{{ activeDiffFile.patch }}</code></pre>
          </template>
        </div>
        <div v-else-if="activeFile?.isBinary" class="code-welcome"><h2>无法预览二进制文件</h2><p>{{ activeFile.path }}</p></div>
        <template v-else-if="activeFile">
          <WorkspaceMonacoEditor :model-value="activeFile.content" :path="activeFile.path" :read-only="true"
            :target-line="activeLine" :word-wrap="isWordWrap" @selection-change="activeSelection = $event"
            @open-relative-path="openRelativePath" />
          <p v-if="activeFile.truncated" class="code-file-warning">文件超过 512 KiB，当前显示的是安全预览。</p>
          <div v-if="activeSelection" class="code-selection-actions">
            <span>L{{ activeSelection.startLine }}–L{{ activeSelection.endLine }}</span>
            <button type="button" @click="searchSelection">查找引用</button>
            <button class="code-selection-primary" type="button" @click="askAboutSelection">问 Cody</button>
          </div>
        </template>
      </section>
    </main>

    <aside v-if="!isChatCollapsed" class="code-chat-panel" aria-label="当前任务对话">
      <header><strong>当前对话</strong><button class="code-icon-button" type="button" aria-label="收起对话" @click="isChatCollapsed = true"><IconTablerX /></button></header>
      <div class="code-chat-content"><slot name="conversation" /></div>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchWorkspaceDiff, fetchWorkspaceFile, fetchWorkspaceFiles, searchWorkspace } from '../../api/codexWorkspaceResourcesClient'
import { buildDiffReview, type UiDiffLineKind, type UiDiffReviewFile } from '../../composables/useDiffReview'
import type { UiComposerContextAttachment, UiMessage, UiWorkspaceCodeTab, UiWorkspaceFileContent, UiWorkspaceFileEntry, UiWorkspaceLocation, UiWorkspaceSearchItem, UiWorkspaceSearchScope } from '../../types/codex'
import IconTablerChevronLeft from '../icons/IconTablerChevronLeft.vue'
import IconTablerFolderOpen from '../icons/IconTablerFolderOpen.vue'
import IconTablerLayoutSidebar from '../icons/IconTablerLayoutSidebar.vue'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import WorkspaceFileTreeBranch from './WorkspaceFileTreeBranch.vue'

const WorkspaceMonacoEditor = defineAsyncComponent(() => import('./WorkspaceMonacoEditor.vue'))

const props = defineProps<{ cwd: string; threadId: string; messages: UiMessage[] }>()
const emit = defineEmits<{ askCode: [attachment: UiComposerContextAttachment] }>()
const route = useRoute()
const router = useRouter()

type NavigatorMode = 'changes' | 'files' | 'search'
type CodeSelection = { text: string; startLine: number; endLine: number }
const navigatorOptions: Array<{ id: NavigatorMode; label: string }> = [
  { id: 'changes', label: '变更' }, { id: 'files', label: '文件' }, { id: 'search', label: '搜索' },
]

const navigatorMode = ref<NavigatorMode>('changes')
const isNavigatorCollapsed = ref(false)
const isChatCollapsed = ref(false)
const isWordWrap = ref(true)
const tabs = ref<UiWorkspaceCodeTab[]>([])
const activePath = ref('')
const activeLine = ref(1)
const activeMode = ref<'file' | 'diff'>('file')
const activeFile = ref<UiWorkspaceFileContent | null>(null)
const activeSelection = ref<CodeSelection | null>(null)
const isLoadingFile = ref(false)
const fileError = ref('')
const fileCache = new Map<string, UiWorkspaceFileContent>()
const latestFileRevision = new Map<string, string>()
let fileController: AbortController | null = null
let fileRequestSequence = 0

const treeBasePath = ref('')
const treeEntries = ref<UiWorkspaceFileEntry[]>([])
const treeTruncated = ref(false)
const treeError = ref('')
const isLoadingTree = ref(false)
const treeRefreshKey = ref(0)

const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const searchScope = ref<UiWorkspaceSearchScope>('files')
const searchResults = ref<UiWorkspaceSearchItem[]>([])
const searchTruncated = ref(false)
const searchError = ref('')
const isSearching = ref(false)
const selectedSearchIndex = ref(0)
let searchTimer = 0
let searchController: AbortController | null = null
let chatMediaQuery: MediaQueryList | null = null
let navigatorMediaQuery: MediaQueryList | null = null

const fallbackMessages = ref<UiMessage[]>([])
const isLoadingFallbackDiff = ref(false)
const diffReview = computed(() => {
  const review = buildDiffReview([...props.messages, ...fallbackMessages.value])
  return {
    ...review,
    files: review.files.map((file) => ({
      ...file,
      filePath: toWorkspaceRelativePath(file.filePath),
      oldPath: file.oldPath ? toWorkspaceRelativePath(file.oldPath) : null,
    })),
  }
})
const activeDiffFile = computed(() => diffReview.value.files.find((file) => file.filePath === activePath.value) ?? null)
const projectName = computed(() => props.cwd.split('/').filter(Boolean).at(-1) ?? 'workspace')
const sessionKey = computed(() => `cody-code-tabs:${props.threadId}`)

const treeBreadcrumbs = computed(() => pathCrumbs(treeBasePath.value).map((crumb) => ({ label: crumb.label, path: crumb.path })))
const activeBreadcrumbs = computed(() => pathCrumbs(activePath.value).map((crumb, index, all) => ({
  label: crumb.label,
  directoryPath: index === all.length - 1 ? dirname(activePath.value) : crumb.path,
})))

function basename(path: string): string { return path.split('/').at(-1) ?? path }
function dirname(path: string): string { const parts = path.split('/'); parts.pop(); return parts.join('/') }
function toWorkspaceRelativePath(path: string): string {
  const normalizedPath = path.trim().replace(/\\/gu, '/').replace(/^\.\//u, '')
  const normalizedCwd = props.cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (normalizedPath === normalizedCwd) return ''
  if (normalizedPath.startsWith(`${normalizedCwd}/`)) return normalizedPath.slice(normalizedCwd.length + 1)
  return normalizedPath
}
function pathCrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean); let current = ''
  return parts.map((label) => { current = current ? `${current}/${label}` : label; return { label, path: current } })
}
function fileStatusLabel(status: string): string {
  if (status === 'added') return 'A'; if (status === 'deleted') return 'D'; if (status === 'renamed') return 'R'; return 'M'
}
function diffPrefix(kind: UiDiffLineKind): string { return kind === 'add' ? '+' : kind === 'remove' ? '−' : kind === 'context' ? ' ' : '·' }
function fileRevisionKey(path: string): string { return `${props.cwd}:${path}` }
function fileCacheKey(path: string, modifiedAtIso: string): string { return `${fileRevisionKey(path)}:${modifiedAtIso}` }
function getCachedFile(path: string): UiWorkspaceFileContent | undefined {
  const revision = latestFileRevision.get(fileRevisionKey(path))
  return revision ? fileCache.get(fileCacheKey(path, revision)) : undefined
}
function cacheFile(file: UiWorkspaceFileContent): void {
  latestFileRevision.set(fileRevisionKey(file.path), file.modifiedAtIso)
  fileCache.set(fileCacheKey(file.path, file.modifiedAtIso), file)
}
function clearFileCache(): void { fileCache.clear(); latestFileRevision.clear() }

function saveTabs(): void {
  try { window.sessionStorage.setItem(sessionKey.value, JSON.stringify(tabs.value)) } catch { /* Browser storage is optional. */ }
}
function restoreTabs(): void {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(sessionKey.value) || '[]') as unknown
    if (Array.isArray(parsed)) tabs.value = parsed
      .filter((tab): tab is UiWorkspaceCodeTab => Boolean(tab && typeof tab === 'object' && typeof (tab as UiWorkspaceCodeTab).path === 'string'))
      .map((tab) => ({ ...tab, id: toWorkspaceRelativePath(tab.path), path: toWorkspaceRelativePath(tab.path) }))
      .filter((tab) => Boolean(tab.path))
      .slice(0, 12)
  } catch { tabs.value = [] }
}

async function replaceLocationQuery(): Promise<void> {
  const query = { ...route.query, view: 'code' } as Record<string, string | string[]>
  if (activePath.value) query.path = activePath.value; else delete query.path
  if (activeLine.value > 1) query.line = String(activeLine.value); else delete query.line
  if (activeMode.value === 'diff') query.mode = 'diff'; else delete query.mode
  await router.replace({ name: 'thread', params: { threadId: props.threadId }, query })
}

function openLocation(location: UiWorkspaceLocation, updateRoute = true): void {
  const path = toWorkspaceRelativePath(location.path)
  if (!path) return
  const mode = location.mode === 'diff' ? 'diff' : 'file'
  const existing = tabs.value.find((tab) => tab.path === path)
  if (!existing) {
    const nextTab: UiWorkspaceCodeTab = { id: path, path, name: basename(path), line: location.line, column: location.column, mode }
    tabs.value = [...tabs.value, nextTab].slice(-12)
  }
  activePath.value = path
  activeLine.value = Math.max(1, Math.trunc(location.line ?? 1))
  activeMode.value = mode
  activeSelection.value = null
  saveTabs()
  if (updateRoute) void replaceLocationQuery()
  if (mode === 'file') void loadActiveFile()
}

function openChangedFile(file: UiDiffReviewFile, requestedMode?: 'file' | 'diff'): void {
  openLocation({
    path: file.filePath,
    line: file.hunks[0]?.newStart ?? 1,
    mode: file.status === 'deleted' ? 'diff' : (requestedMode ?? 'file'),
  })
}
function activateTab(tab: UiWorkspaceCodeTab): void { openLocation({ path: tab.path, line: tab.line, mode: tab.mode }) }
function closeTab(path: string): void {
  const index = tabs.value.findIndex((tab) => tab.path === path)
  tabs.value = tabs.value.filter((tab) => tab.path !== path)
  saveTabs()
  if (activePath.value !== path) return
  const next = tabs.value[Math.min(index, tabs.value.length - 1)]
  if (next) activateTab(next)
  else { activePath.value = ''; activeFile.value = null; void replaceLocationQuery() }
}
function setActiveMode(mode: 'file' | 'diff'): void {
  if (mode === 'file' && activeDiffFile.value?.status === 'deleted') return
  activeMode.value = mode
  const tab = tabs.value.find((item) => item.path === activePath.value); if (tab) tab.mode = mode
  saveTabs(); void replaceLocationQuery(); if (mode === 'file') void loadActiveFile()
}

async function loadActiveFile(): Promise<void> {
  const path = activePath.value
  if (!path || activeMode.value !== 'file') return
  const cached = getCachedFile(path)
  if (cached) { activeFile.value = cached; fileError.value = ''; return }
  fileController?.abort(); fileController = new AbortController(); const sequence = ++fileRequestSequence
  isLoadingFile.value = true; fileError.value = ''
  try {
    const file = await fetchWorkspaceFile(props.cwd, path, fileController.signal)
    if (sequence !== fileRequestSequence || activePath.value !== path) return
    cacheFile(file); activeFile.value = file
  } catch (error) {
    if (sequence !== fileRequestSequence || (error instanceof Error && error.name === 'AbortError')) return
    activeFile.value = null; fileError.value = error instanceof Error ? error.message : '文件读取失败'
  } finally { if (sequence === fileRequestSequence) isLoadingFile.value = false }
}

async function loadTree(): Promise<void> {
  isLoadingTree.value = true; treeError.value = ''
  try {
    const listing = await fetchWorkspaceFiles(props.cwd, treeBasePath.value)
    treeEntries.value = listing.entries; treeTruncated.value = listing.truncated
  } catch (error) { treeError.value = error instanceof Error ? error.message : '目录读取失败' }
  finally { isLoadingTree.value = false }
}
function setTreeBasePath(path: string): void { treeBasePath.value = path; navigatorMode.value = 'files'; void loadTree() }
function refreshTree(): void { treeRefreshKey.value += 1; clearFileCache(); void loadTree(); if (activePath.value) void loadActiveFile() }

async function runSearch(): Promise<void> {
  const query = searchQuery.value.trim()
  if (!query) { searchResults.value = []; searchError.value = ''; searchTruncated.value = false; return }
  searchController?.abort(); searchController = new AbortController(); isSearching.value = true; searchError.value = ''
  const controller = searchController
  try {
    const result = await searchWorkspace(props.cwd, query, searchScope.value, '', 100, controller.signal)
    if (controller !== searchController) return
    searchResults.value = result.items; searchTruncated.value = result.truncated; selectedSearchIndex.value = 0
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    searchResults.value = []; searchError.value = error instanceof Error ? error.message : '搜索失败'
  } finally { if (controller === searchController) isSearching.value = false }
}
function scheduleSearch(): void { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void runSearch(), 250) }
function moveSearchSelection(delta: number): void {
  if (searchResults.value.length === 0) return
  selectedSearchIndex.value = (selectedSearchIndex.value + delta + searchResults.value.length) % searchResults.value.length
}
function openSelectedSearchResult(): void { const item = searchResults.value[selectedSearchIndex.value]; if (item) openSearchResult(item) }
function openSearchResult(item: UiWorkspaceSearchItem): void { openLocation({ path: item.path, line: item.line ?? 1 }) }
function searchSelection(): void {
  if (!activeSelection.value) return
  const query = activeSelection.value.text.trim().match(/^[\w$.-]+$/u)?.[0] ?? activeSelection.value.text.trim().slice(0, 120)
  if (!query) return
  navigatorMode.value = 'search'; searchScope.value = 'content'; searchQuery.value = query
  void nextTick(() => searchInputRef.value?.focus())
}

function askAboutSelection(): void {
  const selection = activeSelection.value
  if (!selection || !activePath.value) return
  const createdAtIso = new Date().toISOString()
  emit('askCode', {
    id: `file-selection:${activePath.value}:${String(selection.startLine)}:${String(selection.endLine)}:${createdAtIso}`,
    kind: 'file',
    label: `@file:${activePath.value}#L${String(selection.startLine)}-L${String(selection.endLine)}`,
    description: `${activePath.value} 第 ${String(selection.startLine)}–${String(selection.endLine)} 行`,
    content: [`Workspace root: ${props.cwd}`, `Path: ${activePath.value}`, `Lines: ${String(selection.startLine)}-${String(selection.endLine)}`, '', 'Selected code:', '````text', selection.text, '````'].join('\n'),
    createdAtIso,
    metadata: { path: activePath.value, startLine: selection.startLine, endLine: selection.endLine, truncated: false },
  })
}

async function openRelativePath(rawPath: string): Promise<void> {
  const base = dirname(activePath.value); const normalized = `${base}/${rawPath}`.split('/').reduce<string[]>((parts, part) => {
    if (!part || part === '.') return parts; if (part === '..') parts.pop(); else parts.push(part); return parts
  }, []).join('/')
  const candidates = [normalized, ...['ts', 'tsx', 'js', 'jsx', 'vue', 'go', 'py', 'rs'].map((extension) => `${normalized}.${extension}`), ...['ts', 'tsx', 'js', 'jsx', 'vue'].map((extension) => `${normalized}/index.${extension}`)]
  for (const candidate of candidates) {
    try { const file = await fetchWorkspaceFile(props.cwd, candidate); cacheFile(file); openLocation({ path: candidate }); return } catch { /* Try the next common source-file candidate. */ }
  }
  fileError.value = `找不到导入路径 ${rawPath}`
}

async function loadFallbackDiff(): Promise<void> {
  if (buildDiffReview(props.messages).files.length > 0) return
  isLoadingFallbackDiff.value = true
  try {
    const snapshot = await fetchWorkspaceDiff(props.cwd)
    if (!snapshot.patch.trim()) return
    fallbackMessages.value = [{ id: 'workspace-diff-fallback', role: 'system', text: '', tool: { kind: 'fileChange', title: 'Workspace diff', status: 'completed', summary: 'Workspace changes', details: [], output: snapshot.patch } }]
  } catch { fallbackMessages.value = [] }
  finally { isLoadingFallbackDiff.value = false }
}

function syncFromRoute(): void {
  const rawPath = typeof route.query.path === 'string' ? route.query.path : ''
  const path = toWorkspaceRelativePath(rawPath)
  const line = typeof route.query.line === 'string' ? Number(route.query.line) : 1
  const mode = route.query.mode === 'diff' ? 'diff' : 'file'
  if (path && (path !== activePath.value || line !== activeLine.value || mode !== activeMode.value)) openLocation({ path, line, mode }, false)
  if (rawPath && rawPath !== path) void replaceLocationQuery()
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (!event.metaKey && !event.ctrlKey) return
  const key = event.key.toLowerCase()
  if (key === 'p' && !event.shiftKey) { event.preventDefault(); navigatorMode.value = 'search'; searchScope.value = 'files'; void nextTick(() => searchInputRef.value?.focus()) }
  if (key === 'f' && event.shiftKey) { event.preventDefault(); navigatorMode.value = 'search'; searchScope.value = 'content'; void nextTick(() => searchInputRef.value?.focus()) }
  if (key === 'w' && activePath.value) { event.preventDefault(); closeTab(activePath.value) }
}

function collapseChatForNarrowViewport(event: MediaQueryListEvent | MediaQueryList): void {
  if (event.matches) isChatCollapsed.value = true
}

function collapseNavigatorForMobileViewport(event: MediaQueryListEvent | MediaQueryList): void {
  if (event.matches) isNavigatorCollapsed.value = true
}

watch([searchQuery, searchScope], scheduleSearch)
watch(() => route.query, syncFromRoute)
watch(() => props.messages, () => { if (diffReview.value.files.length === 0) void loadFallbackDiff() }, { deep: true })
watch(() => props.threadId, () => { clearFileCache(); restoreTabs(); activePath.value = ''; activeFile.value = null; syncFromRoute() })

onMounted(() => {
  restoreTabs(); void loadTree(); void loadFallbackDiff(); syncFromRoute()
  if (!activePath.value && diffReview.value.files[0]) {
    openChangedFile(diffReview.value.files[0], route.query.mode === 'diff' ? 'diff' : 'file')
  }
  chatMediaQuery = window.matchMedia('(max-width: 1180px)')
  navigatorMediaQuery = window.matchMedia('(max-width: 760px)')
  collapseChatForNarrowViewport(chatMediaQuery)
  collapseNavigatorForMobileViewport(navigatorMediaQuery)
  chatMediaQuery.addEventListener('change', collapseChatForNarrowViewport)
  navigatorMediaQuery.addEventListener('change', collapseNavigatorForMobileViewport)
  window.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => {
  window.clearTimeout(searchTimer); fileController?.abort(); searchController?.abort()
  chatMediaQuery?.removeEventListener('change', collapseChatForNarrowViewport)
  navigatorMediaQuery?.removeEventListener('change', collapseNavigatorForMobileViewport)
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<style scoped>
.code-workbench { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(13rem, 16rem) minmax(24rem, 1fr) minmax(18rem, 23rem); overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-panel); }
.code-workbench[data-chat-collapsed='true'] { grid-template-columns: minmax(13rem, 16rem) minmax(24rem, 1fr); }
.code-workbench[data-navigator-collapsed='true'] { grid-template-columns: 2.75rem minmax(24rem, 1fr) minmax(18rem, 23rem); }
.code-workbench[data-navigator-collapsed='true'][data-chat-collapsed='true'] { grid-template-columns: 2.75rem minmax(24rem, 1fr); }
.code-navigator, .code-chat-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: color-mix(in srgb, var(--color-panel) 92%, var(--color-background)); }
.code-navigator { border-right: 1px solid var(--color-border); }
.code-chat-panel { border-left: 1px solid var(--color-border); }
.code-navigator-header, .code-editor-header, .code-chat-panel > header { min-height: 2.75rem; display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--color-border); }
.code-navigator-tabs { min-width: 0; display: flex; flex: 1; gap: 0.2rem; }
.code-navigator-tabs button, .code-search-scope button, .code-view-toggle button { min-height: 2rem; padding: 0.25rem 0.55rem; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); font-size: 0.72rem; cursor: pointer; }
.code-navigator-tabs button[data-active='true'], .code-search-scope button[data-active='true'], .code-view-toggle button[data-active='true'] { background: var(--color-control); color: var(--color-text); }
.code-navigator-tabs span { margin-left: 0.25rem; color: var(--color-success); font-family: var(--font-mono); font-size: 0.62rem; }
.code-icon-button, .code-rail-button { width: 2rem; height: 2rem; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.code-icon-button:hover, .code-rail-button:hover { border-color: var(--color-border); background: var(--color-control); color: var(--color-text); }
.code-icon-button:focus-visible, .code-rail-button:focus-visible, .code-workbench button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.code-icon-button svg, .code-rail-button svg { width: 1rem; height: 1rem; }
.code-rail-button { align-self: start; margin: 0.4rem; }
.code-navigator-body, .code-chat-content { min-height: 0; flex: 1; overflow: auto; }
.code-empty { margin: 0; padding: 1rem; color: var(--color-text-muted); font-size: 0.72rem; line-height: 1.4; }
.code-error { color: var(--color-danger); }
.code-change-list, .code-search-results, .code-tree-list { margin: 0; padding: 0.4rem; list-style: none; }
.code-change-list li + li { margin-top: 0.2rem; }
.code-change-list button { width: 100%; min-height: 2.75rem; display: grid; grid-template-columns: 1.4rem minmax(0, 1fr) auto; align-items: center; gap: 0.45rem; padding: 0.35rem 0.45rem; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text); text-align: left; cursor: pointer; }
.code-change-list button:hover, .code-change-list button[data-selected='true'] { background: var(--color-control); }
.code-change-status { display: inline-flex; justify-content: center; color: var(--color-warning); font-family: var(--font-mono); font-size: 0.68rem; font-weight: 700; }
.code-change-status[data-status='added'] { color: var(--color-success); }.code-change-status[data-status='deleted'] { color: var(--color-danger); }.code-change-status[data-status='renamed'] { color: var(--color-info); }
.code-change-path { min-width: 0; display: grid; }.code-change-path strong, .code-change-path small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.code-change-path strong { font-size: 0.75rem; }.code-change-path small, .code-change-old-path { color: var(--color-text-muted); font-size: 0.62rem; }.code-change-old-path { display: block; padding: 0 0.45rem 0.4rem 2.3rem; overflow-wrap: anywhere; }
.code-change-lines { display: flex; gap: 0.25rem; font-family: var(--font-mono); font-size: 0.62rem; }.code-change-lines b { color: var(--color-success); }.code-change-lines i { color: var(--color-danger); font-style: normal; }
.code-tree-toolbar { display: flex; align-items: center; gap: 0.25rem; padding: 0.35rem 0.45rem; border-bottom: 1px solid var(--color-border); }
.code-breadcrumbs { min-width: 0; display: flex; flex: 1; align-items: center; overflow: hidden; color: var(--color-text-muted); }
.code-breadcrumbs button { min-width: 0; overflow: hidden; border: 0; background: transparent; color: inherit; font-size: 0.65rem; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.code-search-panel { padding: 0.5rem; }.code-search-field { min-height: 2.25rem; display: flex; align-items: center; gap: 0.4rem; padding: 0 0.55rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-background); }.code-search-field:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 14%, transparent); }.code-search-field svg { width: 0.9rem; color: var(--color-text-muted); }.code-search-field input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 0.75rem; }.code-search-scope { display: flex; gap: 0.25rem; padding: 0.4rem 0; }
.code-search-results { padding: 0; }.code-search-results button { width: 100%; display: grid; gap: 0.2rem; padding: 0.45rem; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text); text-align: left; cursor: pointer; }.code-search-results button:hover, .code-search-results button[data-active='true'] { background: var(--color-control); }.code-search-results strong, .code-search-results small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.code-search-results strong { font-family: var(--font-mono); font-size: 0.67rem; }.code-search-results small { color: var(--color-text-muted); font-size: 0.66rem; }
.code-editor-shell { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--color-background); }.code-editor-header { justify-content: space-between; padding-left: 0; }.code-tabs { min-width: 0; display: flex; flex: 1; align-self: stretch; overflow-x: auto; }.code-tabs > p { margin: auto 0.75rem; color: var(--color-text-muted); font-size: 0.7rem; }.code-tab { min-width: 7rem; max-width: 12rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0.6rem; border: 0; border-right: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-panel) 70%, var(--color-background)); color: var(--color-text-muted); cursor: pointer; }.code-tab[data-active='true'] { border-top: 2px solid var(--color-accent); background: var(--color-background); color: var(--color-text); }.code-tab span { overflow: hidden; font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }.code-tab-close { width: 0.85rem; height: 0.85rem; flex: 0 0 auto; border-radius: 0.2rem; }.code-tab-close:hover { background: var(--color-control); }.code-editor-actions { display: flex; gap: 0.2rem; padding-right: 0.4rem; }
.code-location-bar { min-height: 2.25rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.25rem 0.65rem; border-bottom: 1px solid var(--color-border); background: var(--color-panel); }.code-location-bar nav { min-width: 0; display: flex; overflow: hidden; color: var(--color-text-muted); }.code-location-bar nav button { min-width: 0; overflow: hidden; border: 0; background: transparent; color: inherit; font-family: var(--font-mono); font-size: 0.65rem; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }.code-location-bar nav button:last-child { color: var(--color-text); }.code-view-toggle { display: flex; flex: 0 0 auto; }
.code-editor-stage { position: relative; min-height: 0; flex: 1; display: flex; overflow: hidden; }.code-welcome { margin: auto; max-width: 28rem; padding: 2rem; color: var(--color-text-muted); text-align: center; }.code-welcome > svg { width: 2.5rem; height: 2.5rem; }.code-welcome h2 { margin: 0.75rem 0 0.35rem; color: var(--color-text); font-size: 1rem; }.code-welcome p { margin: 0; font-size: 0.75rem; line-height: 1.5; }.code-welcome kbd { border: 1px solid var(--color-border); border-radius: 0.25rem; padding: 0.1rem 0.25rem; background: var(--color-control); font-family: var(--font-mono); }.code-error-state button { margin-top: 0.75rem; min-height: 2.25rem; padding: 0 0.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-control); color: var(--color-text); cursor: pointer; }
.code-loading-skeleton { width: 100%; display: grid; align-content: start; gap: 0.75rem; padding: 1.25rem; }.code-loading-skeleton span { height: 0.75rem; border-radius: 999px; background: color-mix(in srgb, var(--color-text-muted) 14%, transparent); animation: code-pulse 1.2s ease-in-out infinite; }.code-file-warning { position: absolute; inset: auto 0 0; margin: 0; padding: 0.4rem 0.75rem; background: color-mix(in srgb, var(--color-warning) 14%, var(--color-panel)); color: var(--color-warning); font-size: 0.68rem; }
.code-selection-actions { position: absolute; right: 1rem; bottom: 1rem; z-index: 4; display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-panel); box-shadow: var(--shadow-lg); }.code-selection-actions span { padding: 0 0.35rem; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.65rem; }.code-selection-actions button { min-height: 2rem; padding: 0.25rem 0.6rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-control); color: var(--color-text); font-size: 0.7rem; cursor: pointer; }.code-selection-actions .code-selection-primary { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-accent-contrast, white); }
.code-diff-viewer { min-width: 0; flex: 1; overflow: auto; padding: 0.75rem; font-family: var(--font-mono); font-size: 0.7rem; }.code-diff-hunk { min-width: max-content; margin-bottom: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }.code-diff-hunk > header { position: sticky; left: 0; padding: 0.35rem 0.5rem; background: color-mix(in srgb, var(--color-info) 10%, var(--color-panel)); color: var(--color-info); }.code-diff-line { display: grid; grid-template-columns: 3.25rem 3.25rem 1.2rem minmax(30rem, 1fr); min-height: 1.25rem; }.code-diff-line[data-kind='add'] { background: color-mix(in srgb, var(--color-success) 12%, transparent); }.code-diff-line[data-kind='remove'] { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }.code-diff-line > span { padding: 0 0.35rem; color: var(--color-text-muted); text-align: right; user-select: none; }.code-diff-line > i { color: var(--color-text-muted); font-style: normal; text-align: center; }.code-diff-line > code { padding-right: 1rem; white-space: pre; }.code-diff-viewer > pre { margin: 0; white-space: pre; }
.code-chat-panel > header { justify-content: space-between; }.code-chat-panel > header strong { font-size: 0.75rem; }.code-chat-content { display: flex; }.code-chat-content :deep(.conversation-root) { min-width: 0; flex: 1; }.code-chat-content :deep(.conversation-list) { padding-inline: 0.75rem; }.code-chat-content :deep(.conversation-message) { max-width: 100%; }
@keyframes code-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .code-loading-skeleton span { animation: none; } }
@media (max-width: 1180px) { .code-workbench { grid-template-columns: minmax(12rem, 14rem) minmax(22rem, 1fr); }.code-chat-panel { position: absolute; z-index: 20; top: 0; right: 0; bottom: 0; width: min(24rem, 84vw); box-shadow: var(--shadow-lg); }.code-workbench { position: relative; }.code-workbench[data-navigator-collapsed='true'] { grid-template-columns: 2.75rem minmax(22rem, 1fr); } }
@media (max-width: 760px) { .code-workbench, .code-workbench[data-navigator-collapsed='true'] { grid-template-columns: 1fr; }.code-navigator { position: absolute; z-index: 18; inset: 0 auto 0 0; width: min(17rem, 86vw); box-shadow: var(--shadow-lg); }.code-workbench[data-navigator-collapsed='true'] .code-editor-shell { grid-column: 1; }.code-rail-button { position: absolute; z-index: 5; left: 0.4rem; top: 3rem; background: var(--color-panel); }.code-tab { min-width: 6.5rem; }.code-location-bar { padding-left: 0.5rem; }.code-selection-actions { left: 0.5rem; right: 0.5rem; bottom: 0.5rem; justify-content: flex-end; } }
</style>
