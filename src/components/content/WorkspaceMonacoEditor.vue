<template>
  <div
    ref="editorHost"
    class="workspace-monaco-editor"
    :data-read-only="readOnly"
    :aria-label="readOnly ? 'Workspace file viewer' : 'Workspace file editor'"
  />
</template>

<script setup lang="ts">
import './monacoEnvironment'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'

const props = withDefaults(defineProps<{
  modelValue: string
  path: string
  readOnly?: boolean
  targetLine?: number
  wordWrap?: boolean
}>(), {
  readOnly: true,
  targetLine: 1,
  wordWrap: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'selection-change': [selection: { text: string; startLine: number; endLine: number } | null]
  'open-relative-path': [path: string]
}>()

const editorHost = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
let contentChangeDisposable: monaco.IDisposable | null = null
let themeObserver: MutationObserver | null = null
let selectionDisposable: monaco.IDisposable | null = null
let mouseDisposable: monaco.IDisposable | null = null
let ignoreModelEcho = false
let targetLineDecorations: string[] = []

function languageForPath(path: string): string {
  const normalized = path.toLowerCase()
  const extension = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1) : normalized
  const byExactName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'package.json': 'json',
    'package-lock.json': 'json',
    'tsconfig.json': 'json',
    '.env': 'ini',
    '.gitignore': 'ignore',
    '.aiignore': 'ignore',
  }
  const basename = normalized.split('/').pop() ?? normalized
  if (byExactName[basename]) return byExactName[basename]
  const byExtension: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    go: 'go',
    htm: 'html',
    html: 'html',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    lock: 'text',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'text',
    vue: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return byExtension[extension] ?? 'text'
}

function activeMonacoTheme(): 'vs' | 'vs-dark' {
  if (typeof document === 'undefined') return 'vs'
  return document.documentElement.style.colorScheme === 'dark' ? 'vs-dark' : 'vs'
}

function createModel(): monaco.editor.ITextModel {
  const uriPath = props.path.replace(/\\/gu, '/').replace(/^\/+/, '')
  const uri = monaco.Uri.parse(`codex-workspace:///${encodeURI(uriPath || 'untitled.txt')}`)
  const existing = monaco.editor.getModel(uri)
  existing?.dispose()
  return monaco.editor.createModel(props.modelValue, languageForPath(props.path), uri)
}

function syncExternalValue(value: string): void {
  if (!model || model.getValue() === value) return
  const selection = editor?.getSelection() ?? null
  ignoreModelEcho = true
  model.setValue(value)
  ignoreModelEcho = false
  if (selection) editor?.setSelection(selection)
}

function attachModel(nextModel: monaco.editor.ITextModel): void {
  contentChangeDisposable?.dispose()
  model?.dispose()
  model = nextModel
  editor?.setModel(model)
  contentChangeDisposable = model.onDidChangeContent(() => {
    if (ignoreModelEcho || !model || props.readOnly) return
    emit('update:modelValue', model.getValue())
  })
}

function refreshTheme(): void {
  monaco.editor.setTheme(activeMonacoTheme())
}

function revealTargetLine(): void {
  if (!editor || !model) return
  const line = Math.max(1, Math.min(Math.trunc(props.targetLine || 1), model.getLineCount()))
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  targetLineDecorations = editor.deltaDecorations(targetLineDecorations, [{
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: 'workspace-monaco-target-line' },
  }])
}

function quotedPathAtPosition(position: monaco.Position): string {
  if (!model) return ''
  const line = model.getLineContent(position.lineNumber)
  for (const match of line.matchAll(/(['"])(\.{1,2}\/[^'"\s]+)\1/gu)) {
    const value = match[2] ?? ''
    const start = (match.index ?? 0) + 2
    const end = start + value.length
    if (position.column >= start && position.column <= end + 1) return value
  }
  return ''
}

function fontFamily(): string {
  if (typeof document === 'undefined') return 'Menlo, Monaco, Consolas, monospace'
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Menlo, Monaco, Consolas, monospace'
}

onMounted(async () => {
  await nextTick()
  if (!editorHost.value) return
  model = createModel()
  refreshTheme()
  editor = monaco.editor.create(editorHost.value, {
    model,
    automaticLayout: true,
    contextmenu: true,
    fontFamily: fontFamily(),
    fontSize: 12,
    lineHeight: 19,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    readOnly: props.readOnly,
    renderLineHighlight: 'line',
    renderValidationDecorations: 'off',
    scrollBeyondLastLine: false,
    tabSize: 2,
    wordWrap: props.wordWrap ? 'on' : 'off',
  })
  contentChangeDisposable = model.onDidChangeContent(() => {
    if (ignoreModelEcho || !model || props.readOnly) return
    emit('update:modelValue', model.getValue())
  })
  selectionDisposable = editor.onDidChangeCursorSelection(() => {
    if (!editor || !model) return
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) {
      emit('selection-change', null)
      return
    }
    emit('selection-change', {
      text: model.getValueInRange(selection),
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
    })
  })
  mouseDisposable = editor.onMouseDown((event) => {
    if (!editor || !model || !event.target.position) return
    if (event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const location = `${props.path}:${String(event.target.position.lineNumber)}`
      void navigator.clipboard?.writeText(location).catch(() => undefined)
      return
    }
    const browserEvent = event.event.browserEvent as MouseEvent
    if (!browserEvent.metaKey && !browserEvent.ctrlKey) return
    const targetPath = quotedPathAtPosition(event.target.position)
    if (targetPath) emit('open-relative-path', targetPath)
  })
  revealTargetLine()
  themeObserver = new MutationObserver(refreshTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme-skin'] })
})

watch(
  () => props.readOnly,
  (readOnly) => {
    editor?.updateOptions({ readOnly })
  },
)

watch(
  () => props.modelValue,
  (value) => {
    syncExternalValue(value)
  },
)

watch(
  () => props.path,
  () => {
    if (!editor) return
    attachModel(createModel())
    emit('selection-change', null)
    revealTargetLine()
  },
)

watch(() => props.targetLine, revealTargetLine)
watch(() => props.wordWrap, (enabled) => editor?.updateOptions({ wordWrap: enabled ? 'on' : 'off' }))

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  selectionDisposable?.dispose()
  mouseDisposable?.dispose()
  contentChangeDisposable?.dispose()
  editor?.dispose()
  model?.dispose()
})
</script>

<style scoped>
@reference "../../style.css";

.workspace-monaco-editor {
  @apply min-h-0 flex-1 overflow-hidden theme-bg-panel;
}

.workspace-monaco-editor[data-read-only='true'] {
  @apply cursor-default;
}

.workspace-monaco-editor :deep(.workspace-monaco-target-line) {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: inset 2px 0 0 var(--color-accent);
}
</style>
