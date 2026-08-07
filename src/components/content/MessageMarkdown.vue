<template>
  <div
    ref="rootRef"
    class="message-markdown"
    v-html="renderedHtml"
    @click="onMarkdownClick"
  />
  <dialog ref="imageDialogRef" class="markdown-image-dialog" @click="closeImagePreview">
    <button type="button" :aria-label="t('markdown.closeImagePreview')" @click="closeImagePreview">×</button>
    <img :src="previewImageUrl" :alt="t('markdown.imagePreview')">
  </dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, type MarkdownUiLabels } from '../../composables/renderMarkdown'
import { sanitizeDiagramSvg } from '../../composables/diagramSvgSanitizer'
import { mermaidRenderConfig } from '../../composables/mermaidRenderConfig'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  text: string
  cwd?: string
}>()
const emit = defineEmits<{
  openFile: [{ path: string; line: number }]
}>()
const { locale, t } = useLocale()

function uiLabels(): MarkdownUiLabels {
  return {
    zoomOut: t('markdown.zoomOut'), fit: t('markdown.fit'), zoomIn: t('markdown.zoomIn'), source: t('markdown.source'), fullscreen: t('markdown.fullscreen'),
    rendering: (engine) => t('markdown.rendering', { engine }), diagramAria: (engine) => t('markdown.diagramAria', { engine }),
    wrap: t('markdown.wrap'), copy: t('markdown.copy'), save: t('markdown.save'), dataTable: t('markdown.dataTable'), copyCsv: t('markdown.copyCsv'),
    openFile: (path) => t('markdown.openFile', { path }),
    lineCount: (count) => t('markdown.lineCount', { count: String(count) }), expandCode: (count) => t('markdown.expandCode', { count: String(count) }), collapseCode: t('markdown.collapseCode'),
  }
}

const rootRef = ref<HTMLElement | null>(null)
const imageDialogRef = ref<HTMLDialogElement | null>(null)
const renderedHtml = ref(renderMarkdown(props.text, uiLabels()))
const previewImageUrl = ref('')
let renderTimer = 0
let diagramSequence = 0
const expandedCodeBlockIndexes = new Set<number>()

function stabilizeStreamingMarkdown(value: string): string {
  const fences = value.match(/^\s*```/gmu)?.length ?? 0
  return fences % 2 === 1 ? `${value}\n\n\`\`\`` : value
}

async function renderNext(value: string): Promise<void> {
  window.clearTimeout(renderTimer)
  renderTimer = window.setTimeout(async () => {
    renderedHtml.value = renderMarkdown(stabilizeStreamingMarkdown(value), uiLabels())
    await nextTick()
    void highlightCodeBlocks()
  }, 75)
}

const languageLoaders: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  sql: () => import('highlight.js/lib/languages/sql'),
}

async function highlightCodeBlocks(): Promise<void> {
  for (const cell of Array.from(rootRef.value?.querySelectorAll<HTMLTableCellElement>('td') ?? [])) {
    if (/^-?[\d,.]+%?$/u.test(cell.textContent?.trim() ?? '')) cell.dataset.numeric = 'true'
  }
  for (const image of Array.from(rootRef.value?.querySelectorAll<HTMLImageElement>('img') ?? [])) {
    image.addEventListener('error', () => { image.alt = image.alt || t('markdown.imageLoadFailed'); image.classList.add('is-load-error') }, { once: true })
  }
  rewriteWorkspaceAssetLinks()
  for (const [index, shell] of Array.from(rootRef.value?.querySelectorAll<HTMLElement>('.markdown-code-shell') ?? []).entries()) {
    shell.dataset.codeIndex = String(index)
    if (shell.classList.contains('is-collapsible') && expandedCodeBlockIndexes.has(index)) shell.classList.remove('is-collapsed')
    for (const toggle of Array.from(shell.querySelectorAll<HTMLButtonElement>('[data-markdown-action="toggle-code"]'))) {
      toggle.setAttribute('aria-expanded', String(!shell.classList.contains('is-collapsed')))
    }
    const pre = shell.querySelector('pre')
    const wrapButton = shell.querySelector<HTMLButtonElement>('[data-markdown-action="wrap-code"]')
    if (pre && wrapButton) {
      const hasHorizontalOverflow = pre.scrollWidth > pre.clientWidth + 2
      wrapButton.hidden = !hasHorizontalOverflow
      wrapButton.setAttribute('aria-pressed', String(shell.classList.contains('is-wrapped')))
    }
  }
  await renderDiagrams()
  const blocks = Array.from(rootRef.value?.querySelectorAll<HTMLElement>('pre code[class*="language-"]') ?? [])
  if (blocks.length === 0) return
  const { default: hljs } = await import('highlight.js/lib/core')
  for (const block of blocks) {
    const language = Array.from(block.classList).find((name) => name.startsWith('language-'))?.slice(9) ?? ''
    const loader = languageLoaders[language]
    if (!loader || block.dataset.highlighted === 'yes') continue
    const module = await loader()
    if (!hljs.getLanguage(language)) hljs.registerLanguage(language, module.default as never)
    block.innerHTML = hljs.highlight(block.textContent ?? '', { language }).value
    block.dataset.highlighted = 'yes'
  }
}

function rewriteWorkspaceAssetLinks(): void {
  const assetPattern = /\.(?:svg|png|jpe?g|gif|webp)(?:[?#].*)?$/iu
  for (const anchor of Array.from(rootRef.value?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])) {
    const rawHref = anchor.getAttribute('href') ?? ''
    if (!assetPattern.test(rawHref) || /^(?:data|blob):/iu.test(rawHref)) continue
    let filePath = rawHref
    try {
      const parsed = new URL(rawHref, window.location.href)
      if (/^https?:/u.test(parsed.protocol) && parsed.origin !== window.location.origin) continue
      filePath = decodeURIComponent(parsed.pathname)
    } catch {
      // Keep the original relative workspace path.
    }
    const assetUrl = new URL('/codex-api/tooling/workspace-asset', window.location.origin)
    assetUrl.searchParams.set('cwd', props.cwd ?? '')
    assetUrl.searchParams.set('path', filePath)
    anchor.href = assetUrl.toString()
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.title = t('markdown.openWorkspaceImage')
  }
}

async function renderDiagrams(): Promise<void> {
  const shells = Array.from(rootRef.value?.querySelectorAll<HTMLElement>('.markdown-diagram-shell:not([data-rendered])') ?? [])
  for (const shell of shells) {
    shell.dataset.rendered = 'loading'
    const engine = shell.dataset.diagramEngine ?? ''
    const source = shell.querySelector('code')?.textContent ?? ''
    const stage = shell.querySelector<HTMLElement>('.markdown-diagram-stage')
    if (!stage) continue
    try {
      let svg = ''
      if (engine === 'mermaid') {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize(mermaidRenderConfig(Boolean(document.querySelector('.app-dark'))))
        const result = await mermaid.render(`cody-diagram-${String(++diagramSequence)}`, source)
        svg = result.svg
      } else {
        const response = await fetch('/codex-api/diagrams/plantuml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) })
        const payload = await response.json() as { result?: { svg?: string }; error?: string }
        if (!response.ok || !payload.result?.svg) throw new Error(payload.error || 'PlantUML rendering failed')
        svg = payload.result.svg
      }
      stage.innerHTML = sanitizeDiagramSvg(svg)
      enableDiagramPan(stage)
      shell.dataset.rendered = 'yes'
      shell.style.setProperty('--diagram-scale', '1')
    } catch (error) {
      stage.innerHTML = `<p class="markdown-diagram-error">${escapeText(error instanceof Error ? error.message : t('markdown.diagramFailed'))}</p>`
      shell.querySelector<HTMLElement>('.markdown-diagram-source')?.removeAttribute('hidden')
      shell.dataset.rendered = 'error'
    }
  }
}

function enableDiagramPan(stage: HTMLElement): void {
  if (stage.dataset.panReady === 'true') return
  stage.dataset.panReady = 'true'
  let startX = 0; let startY = 0; let startLeft = 0; let startTop = 0
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    startX = event.clientX; startY = event.clientY; startLeft = stage.scrollLeft; startTop = stage.scrollTop
    stage.setPointerCapture(event.pointerId); stage.classList.add('is-panning')
  })
  stage.addEventListener('pointermove', (event) => {
    if (!stage.hasPointerCapture(event.pointerId)) return
    stage.scrollLeft = startLeft - (event.clientX - startX); stage.scrollTop = startTop - (event.clientY - startY)
  })
  const stop = (event: PointerEvent) => { if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); stage.classList.remove('is-panning') }
  stage.addEventListener('pointerup', stop); stage.addEventListener('pointercancel', stop)
}

function escapeText(value: string): string {
  const node = document.createElement('span')
  node.textContent = value
  return node.innerHTML
}

function diagramScale(shell: HTMLElement, delta = 0): number {
  const current = Number(shell.style.getPropertyValue('--diagram-scale') || '1')
  const next = delta === 0 ? 1 : Math.min(2.5, Math.max(0.4, current + delta))
  shell.style.setProperty('--diagram-scale', String(next))
  return next
}

function downloadBlob(blob: Blob, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

async function exportDiagramPng(shell: HTMLElement): Promise<void> {
  const svg = shell.querySelector<SVGSVGElement>('.markdown-diagram-stage svg')
  if (!svg) return
  const serialized = new XMLSerializer().serializeToString(svg)
  const image = new Image()
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }))
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(t('markdown.pngExportFailed'))); image.src = url })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.naturalWidth * 2); canvas.height = Math.max(1, image.naturalHeight * 2)
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
  URL.revokeObjectURL(url)
  canvas.toBlob((blob) => { if (blob) downloadBlob(blob, 'diagram.png') }, 'image/png')
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent
  try {
    let copied = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        // Fall through to the legacy copy path used by local HTTP/WebView environments.
      }
    }
    if (!copied) {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand('copy')
      textarea.remove()
      if (!copied) throw new Error('Copy command was rejected')
    }
    button.textContent = t('markdown.copied')
  } catch {
    button.textContent = t('markdown.copyFailed')
  }
  window.setTimeout(() => { button.textContent = original }, 1_200)
}

function tableCsv(table: HTMLTableElement): string {
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => `"${cell.textContent?.trim().replace(/"/gu, '""') ?? ''}"`).join(',')).join('\n')
}

function onMarkdownClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  const image = target.closest<HTMLImageElement>('img')
  if (image) {
    previewImageUrl.value = image.currentSrc || image.src
    imageDialogRef.value?.showModal()
    return
  }
  const button = target.closest<HTMLButtonElement>('[data-markdown-action]')
  if (!button) return
  const shell = button.closest<HTMLElement>('.markdown-code-shell, .markdown-table-shell')
  const action = button.dataset.markdownAction
  if (action === 'copy-code') void copyText(shell?.querySelector('code')?.textContent ?? '', button)
  if (action === 'wrap-code') {
    const isWrapped = shell?.classList.toggle('is-wrapped') ?? false
    button.textContent = isWrapped ? t('markdown.scroll') : t('markdown.wrap')
    button.setAttribute('aria-pressed', String(isWrapped))
  }
  if (action === 'save-code') {
    const blob = new Blob([shell?.querySelector('code')?.textContent ?? ''], { type: 'text/plain' })
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `snippet.${shell?.dataset.language || 'txt'}`; anchor.click(); URL.revokeObjectURL(anchor.href)
  }
  if (action === 'toggle-code' && shell?.classList.contains('is-collapsible')) {
    const index = Number(shell.dataset.codeIndex ?? -1)
    const isExpanded = shell.classList.toggle('is-collapsed') === false
    if (Number.isInteger(index) && index >= 0) {
      if (isExpanded) expandedCodeBlockIndexes.add(index)
      else expandedCodeBlockIndexes.delete(index)
    }
    for (const toggle of Array.from(shell.querySelectorAll<HTMLButtonElement>('[data-markdown-action="toggle-code"]'))) {
      toggle.setAttribute('aria-expanded', String(isExpanded))
    }
    if (!isExpanded) shell.scrollIntoView({ block: 'nearest' })
  }
  if (action === 'copy-table') void copyText(tableCsv(shell?.querySelector('table') as HTMLTableElement), button)
  if (action === 'open-file') {
    const rawPath = button.dataset.filePath ?? ''
    const cwd = props.cwd?.replace(/\/$/u, '') ?? ''
    const path = rawPath.startsWith('/') && cwd && rawPath.startsWith(`${cwd}/`)
      ? rawPath.slice(cwd.length + 1)
      : rawPath.replace(/^\.\//u, '')
    const line = Number(button.dataset.fileLine || 0) || 1
    emit('openFile', { path, line })
  }
  const diagram = button.closest<HTMLElement>('.markdown-diagram-shell')
  if (diagram && action === 'diagram-zoom-in') diagramScale(diagram, 0.2)
  if (diagram && action === 'diagram-zoom-out') diagramScale(diagram, -0.2)
  if (diagram && action === 'diagram-fit') diagramScale(diagram)
  if (diagram && action === 'diagram-source') {
    const source = diagram.querySelector<HTMLElement>('.markdown-diagram-source')
    if (source) source.hidden = !source.hidden
  }
  if (diagram && action === 'diagram-fullscreen') void diagram.requestFullscreen?.()
  if (diagram && action === 'diagram-export-svg') {
    const svg = diagram.querySelector('svg')
    if (svg) downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), 'diagram.svg')
  }
  if (diagram && action === 'diagram-export-png') void exportDiagramPng(diagram)
}

function closeImagePreview(): void { imageDialogRef.value?.close() }

watch(() => props.text, (value) => { void renderNext(value) })
watch(locale, () => { void renderNext(props.text) })
onMounted(() => { void highlightCodeBlocks() })
onBeforeUnmount(() => window.clearTimeout(renderTimer))
</script>

<style scoped>
@reference "../../style.css";

.message-markdown {
  @apply text-sm leading-relaxed theme-text;
  overflow-wrap: anywhere;
}

.message-markdown :deep(> :first-child) { margin-top: 0; }
.message-markdown :deep(> :last-child) { margin-bottom: 0; }

.message-markdown :deep(p) { @apply my-3 whitespace-pre-wrap; }
.message-markdown :deep(h1),
.message-markdown :deep(h2),
.message-markdown :deep(h3),
.message-markdown :deep(h4),
.message-markdown :deep(h5),
.message-markdown :deep(h6) { @apply mb-2 mt-5 font-semibold leading-snug theme-text; }
.message-markdown :deep(h1) { @apply text-xl; }
.message-markdown :deep(h2) { @apply text-lg; }
.message-markdown :deep(h3) { @apply text-base; }

.message-markdown :deep(ul),
.message-markdown :deep(ol) { @apply my-3 pl-6; }
.message-markdown :deep(ul) { @apply list-disc; }
.message-markdown :deep(ol) { @apply list-decimal; }
.message-markdown :deep(li) { @apply my-1 pl-1; }
.message-markdown :deep(li > ul),
.message-markdown :deep(li > ol) { @apply my-1; }

.message-markdown :deep(blockquote) { @apply my-3 border-l-4 theme-border pl-3 theme-muted; }
.message-markdown :deep(blockquote > :first-child) { margin-top: 0; }
.message-markdown :deep(blockquote > :last-child) { margin-bottom: 0; }

.message-markdown :deep(pre) { @apply my-3 overflow-x-auto rounded-lg border theme-border bg-slate-950 px-3 py-2 text-sm leading-relaxed text-slate-100; }
.message-markdown :deep(pre.is-compact),
.message-markdown :deep(pre:has(> code.is-compact-code)) { @apply w-fit max-w-full px-2.5 py-1.5; }
.message-markdown :deep(pre code) { @apply rounded-none border-0 bg-transparent p-0 text-inherit; white-space: pre; }
.message-markdown :deep(.markdown-code-shell) { @apply relative my-3 overflow-hidden rounded-lg border theme-border bg-slate-950; }
.message-markdown :deep(.markdown-code-shell.is-compact) { @apply w-fit max-w-full; }
.message-markdown :deep(.markdown-code-shell pre) { @apply m-0 rounded-none border-0; }
.message-markdown :deep(.markdown-code-toolbar),
.message-markdown :deep(.markdown-table-toolbar) { @apply flex min-h-8 items-center justify-between border-b border-slate-700 px-2.5 font-mono text-[0.65rem] uppercase tracking-wide theme-muted; }
.message-markdown :deep(.markdown-code-shell.is-compact .markdown-code-toolbar) { @apply hidden; }
.message-markdown :deep(.markdown-code-actions) { @apply flex gap-1; }
.message-markdown :deep(.markdown-tool-button) { @apply rounded px-1.5 py-1 text-[0.65rem] normal-case tracking-normal text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1; }
.message-markdown :deep(.markdown-code-shell.is-wrapped pre code) { white-space: pre-wrap; word-break: break-word; }
.message-markdown :deep(.markdown-code-shell.is-collapsible.is-collapsed pre) { max-height: 16rem; overflow: hidden; }
.message-markdown :deep(.markdown-code-expand) { @apply absolute inset-x-0 bottom-0 flex justify-center pb-3 pt-12; background:linear-gradient(to bottom,transparent,var(--color-code-background) 68%); }
.message-markdown :deep(.markdown-code-expand button) { @apply rounded-full border border-slate-600 bg-slate-900/95 px-3 py-1.5 font-mono text-[0.68rem] text-slate-200 shadow-lg hover:border-slate-400 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2; }
.message-markdown :deep(.markdown-code-shell:not(.is-collapsed) .markdown-code-expand) { @apply hidden; }
.message-markdown :deep(.markdown-code-collapse) { @apply hidden; }
.message-markdown :deep(.markdown-code-shell.is-collapsible:not(.is-collapsed) .markdown-code-collapse) { display:inline-flex; }
@media (max-width: 640px) { .message-markdown :deep(.markdown-code-shell.is-collapsible.is-collapsed pre) { max-height: 14rem; } }
.message-markdown :deep(.markdown-diagram-shell) { @apply relative my-4 overflow-hidden rounded-xl border theme-border theme-bg-panel; }
.message-markdown :deep(.markdown-diagram-toolbar) { @apply flex min-h-10 flex-wrap items-center justify-between gap-2 border-b theme-border theme-bg-subtle px-3 font-mono text-[0.68rem] uppercase tracking-wide theme-muted; }
.message-markdown :deep(.markdown-diagram-actions) { @apply flex flex-wrap justify-end gap-1; }
.message-markdown :deep(.markdown-diagram-toolbar .markdown-tool-button) { @apply theme-muted hover:theme-bg-control hover:theme-text; }
.message-markdown :deep(.markdown-diagram-stage) { @apply min-h-40 cursor-grab overflow-auto p-5; }
.message-markdown :deep(.markdown-diagram-stage.is-panning) { @apply cursor-grabbing select-none; }
.message-markdown :deep(.markdown-diagram-stage svg) { @apply mx-auto h-auto max-w-none; transform: scale(var(--diagram-scale, 1)); transform-origin: top left; transition: transform 140ms ease; }
.message-markdown :deep(.markdown-diagram-status),
.message-markdown :deep(.markdown-diagram-error) { @apply m-0 flex min-h-28 items-center justify-center text-sm theme-muted; }
.message-markdown :deep(.markdown-diagram-error) { @apply theme-text-danger; }
.message-markdown :deep(.markdown-diagram-source) { @apply m-0 rounded-none border-x-0 border-b-0; }
.message-markdown :deep(.markdown-diagram-shell:fullscreen) { @apply h-screen w-screen rounded-none; }
.message-markdown :deep(.markdown-diagram-shell:fullscreen .markdown-diagram-stage) { height: calc(100vh - 2.5rem); }
.message-markdown :deep(code) { @apply rounded-md border theme-border bg-slate-100/60 px-1.5 py-0.5 font-mono text-[0.875em] leading-[1.4] theme-text; }

.message-markdown :deep(a) { @apply text-[#0969da] underline decoration-[#0969da]/35 underline-offset-2 hover:decoration-current; }
.message-markdown :deep(strong) { @apply font-semibold theme-text; }
.message-markdown :deep(del) { @apply theme-muted; }
.message-markdown :deep(hr) { @apply my-5 border-0 border-t theme-border; }
.message-markdown :deep(img) { @apply my-3 max-h-[32rem] max-w-full cursor-zoom-in rounded-lg border theme-border object-contain; }
.message-markdown :deep(img[alt='']) { @apply opacity-80; }
.message-markdown :deep(img.is-load-error) { @apply min-h-16 border-dashed object-none p-4 text-xs; }

.message-markdown :deep(.markdown-table-shell) { @apply relative my-4 max-w-full overflow-hidden rounded-lg border theme-border focus-visible:outline-2 focus-visible:outline-offset-2; }
.message-markdown :deep(.markdown-table-toolbar) { @apply justify-end theme-border theme-bg-subtle theme-muted; }
.message-markdown :deep(.markdown-table-toolbar .markdown-tool-button) { @apply theme-muted hover:bg-slate-200 hover:theme-text; }
.message-markdown :deep(.markdown-table-scroll) { @apply max-w-full overflow-x-auto; }
.message-markdown :deep(table) { @apply w-full border-separate border-spacing-0 text-left text-[0.8125rem]; }
.message-markdown :deep(th) { @apply border-b border-t theme-border theme-bg-control px-3 py-2 font-semibold theme-text; }
.message-markdown :deep(td) { @apply border-b theme-border px-3 py-2 align-top theme-muted; }
.message-markdown :deep(th:first-child),
.message-markdown :deep(td:first-child) { @apply border-l theme-border; }
.message-markdown :deep(th:last-child),
.message-markdown :deep(td:last-child) { @apply border-r theme-border; }
.message-markdown :deep(th:first-child) { @apply rounded-tl-lg; }
.message-markdown :deep(th:last-child) { @apply rounded-tr-lg; }
.message-markdown :deep(tr:last-child td:first-child) { @apply rounded-bl-lg; }
.message-markdown :deep(tr:last-child td:last-child) { @apply rounded-br-lg; }
.message-markdown :deep(th) { @apply sticky top-0 z-10; }
.message-markdown :deep(td:first-child), .message-markdown :deep(th:first-child) { @apply sticky left-0 z-10; }
.message-markdown :deep(td:first-child) { @apply theme-bg-panel; }
.message-markdown :deep(td[data-numeric='true']) { @apply text-right font-mono tabular-nums; }

.message-markdown :deep(.markdown-file-link) { @apply inline cursor-pointer border-0 bg-transparent p-0 align-baseline text-inherit; }
.message-markdown :deep(.markdown-file-link code) { @apply text-[#0969da] underline decoration-dotted underline-offset-2; }
.message-markdown :deep(.footnotes) { @apply mt-6 border-t theme-border pt-3 text-xs theme-muted; }
.message-markdown :deep(details) { @apply my-3 rounded-lg border theme-border px-3 py-2; }
.message-markdown :deep(summary) { @apply cursor-pointer font-semibold; }
.message-markdown :deep(a:focus-visible),
.message-markdown :deep(button:focus-visible),
.message-markdown :deep(summary:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 3px; }

.message-markdown :deep(.hljs-keyword), .message-markdown :deep(.hljs-selector-tag), .message-markdown :deep(.hljs-literal) { color: #c792ea; }
.message-markdown :deep(.hljs-string), .message-markdown :deep(.hljs-attr) { color: #c3e88d; }
.message-markdown :deep(.hljs-number), .message-markdown :deep(.hljs-symbol) { color: #f78c6c; }
.message-markdown :deep(.hljs-title), .message-markdown :deep(.hljs-function) { color: #82aaff; }
.message-markdown :deep(.hljs-comment) { color: #7f8c98; font-style: italic; }
.message-markdown :deep(.hljs-built_in), .message-markdown :deep(.hljs-type) { color: #ffcb6b; }

.message-markdown :deep(.contains-task-list) { @apply list-none pl-1; }
.message-markdown :deep(.task-list-item) { @apply relative pl-7; }
.message-markdown :deep(.task-list-item > input) { @apply absolute left-0 top-1 h-4 w-4; accent-color: var(--color-accent); }

:global(.app-dark) .message-markdown :deep(h1),
:global(.app-dark) .message-markdown :deep(h2),
:global(.app-dark) .message-markdown :deep(h3),
:global(.app-dark) .message-markdown :deep(h4),
:global(.app-dark) .message-markdown :deep(h5),
:global(.app-dark) .message-markdown :deep(h6),
:global(.app-dark) .message-markdown :deep(strong) { color: var(--color-text); }
:global(.app-dark) .message-markdown :deep(blockquote) { border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border)); color: var(--color-text-muted); }
:global(.app-dark) .message-markdown :deep(code) { background: var(--color-elevated); border-color: var(--color-border); color: var(--color-text); }
:global(.app-dark) .message-markdown :deep(pre) { background: var(--color-code-background); border-color: var(--color-border); }
:global(.app-dark) .message-markdown :deep(pre code) { background: transparent; border: 0; color: inherit; }
:global(.app-dark) .message-markdown :deep(th) { background: var(--color-elevated); border-color: var(--color-border); color: var(--color-text); }
:global(.app-dark) .message-markdown :deep(td) { border-color: var(--color-border); color: var(--color-text-muted); }
:global(.app-dark) .message-markdown :deep(td:first-child) { background: var(--color-panel); }
:global(.app-dark) .message-markdown :deep(.markdown-table-shell) { border-color: var(--color-border); }
:global(.app-dark) .message-markdown :deep(.markdown-table-toolbar) { background: var(--color-elevated); border-color: var(--color-border); }
:global(.app-dark) .message-markdown :deep(.markdown-diagram-shell) { background: var(--color-panel); border-color: var(--color-border); }
:global(.app-dark) .message-markdown :deep(.markdown-diagram-toolbar) { background: var(--color-elevated); border-color: var(--color-border); color: var(--color-text-muted); }

@media (prefers-reduced-motion: reduce) {
  .message-markdown :deep(.markdown-diagram-stage svg) { transition: none; }
}

.markdown-image-dialog { @apply m-auto max-h-[92vh] max-w-[92vw] border-0 bg-transparent p-8 backdrop:bg-black/80; }
.markdown-image-dialog img { @apply max-h-[82vh] max-w-[86vw] rounded-xl object-contain shadow-2xl; }
.markdown-image-dialog button { @apply absolute right-1 top-1 h-9 w-9 rounded-full bg-black/70 text-xl text-white; }
</style>
