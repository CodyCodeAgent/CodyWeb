<template>
  <CodyMarkdown
    :text="text"
    :cwd="cwd"
    :labels="labels"
    :dark="isDark"
    :resolve-asset-url="workspaceAssetUrl"
    :render-diagram="renderDiagram"
    @open-file="emit('openFile', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CodyMarkdown, type CodyMarkdownLabels } from '@codycodeagent/cody-web-core/vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{ text: string; cwd?: string }>()
const emit = defineEmits<{ openFile: [{ path: string; line: number }] }>()
const { locale, t } = useLocale()

const labels = computed<CodyMarkdownLabels>(() => {
  void locale.value
  return {
    zoomOut: t('markdown.zoomOut'), fit: t('markdown.fit'), zoomIn: t('markdown.zoomIn'), source: t('markdown.source'), fullscreen: t('markdown.fullscreen'),
    rendering: (engine) => t('markdown.rendering', { engine }), diagramAria: (engine) => t('markdown.diagramAria', { engine }),
    wrap: t('markdown.wrap'), scroll: t('markdown.scroll'), copy: t('markdown.copy'), save: t('markdown.save'), dataTable: t('markdown.dataTable'), copyCsv: t('markdown.copyCsv'),
    openFile: (path) => t('markdown.openFile', { path }),
    lineCount: (count) => t('markdown.lineCount', { count: String(count) }), expandCode: (count) => t('markdown.expandCode', { count: String(count) }), collapseCode: t('markdown.collapseCode'),
  }
})

const isDark = computed(() => typeof document !== 'undefined' && document.documentElement.classList.contains('app-dark'))

function workspaceAssetUrl(rawHref: string): string | undefined {
  const assetPattern = /\.(?:svg|png|jpe?g|gif|webp)(?:[?#].*)?$/iu
  if (!assetPattern.test(rawHref) || /^(?:data|blob):/iu.test(rawHref)) return undefined
  let filePath = rawHref
  try {
    const parsed = new URL(rawHref, window.location.href)
    if (/^https?:/u.test(parsed.protocol) && parsed.origin !== window.location.origin) return undefined
    filePath = decodeURIComponent(parsed.pathname)
  } catch {
    // Keep relative workspace paths intact.
  }
  const assetUrl = new URL('/codex-api/tooling/workspace-asset', window.location.origin)
  assetUrl.searchParams.set('cwd', props.cwd ?? '')
  assetUrl.searchParams.set('path', filePath)
  return assetUrl.toString()
}

async function renderDiagram(input: { engine: 'mermaid' | 'plantuml'; source: string }): Promise<string | undefined> {
  if (input.engine !== 'plantuml') return undefined
  const response = await fetch('/codex-api/diagrams/plantuml', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: input.source }),
  })
  const payload = await response.json() as { result?: { svg?: string }; error?: string }
  if (!response.ok || !payload.result?.svg) throw new Error(payload.error || 'PlantUML rendering failed')
  return payload.result.svg
}
</script>
