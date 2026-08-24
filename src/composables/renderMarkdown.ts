/**
 * Product compatibility export. The parser and safe HTML boundary live in
 * CodyWebCore so CodyWeb and CodyWork render the same conversation content.
 */
import { renderCodyMarkdown, type CodyMarkdownLabels } from '@codycodeagent/cody-web-core/vue'

export type MarkdownUiLabels = CodyMarkdownLabels

// Kept for callers of this compatibility function. The Vue component itself
// supplies the current CodyWeb locale to the shared Core renderer.
export const DEFAULT_MARKDOWN_LABELS: CodyMarkdownLabels = {
  zoomOut: 'Zoom out', fit: 'Fit', zoomIn: 'Zoom in', source: 'Source', fullscreen: 'Fullscreen',
  rendering: (engine) => `Rendering ${engine}…`, diagramAria: (engine) => `${engine} technical diagram`,
  wrap: 'Wrap', scroll: 'Scroll', copy: 'Copy', save: 'Save', dataTable: 'Data table', copyCsv: 'Copy CSV',
  openFile: (path) => `Open ${path}`,
  lineCount: (count) => `${String(count)} lines`, expandCode: (count) => `Show all · ${String(count)} lines`, collapseCode: 'Collapse code',
}

export function renderMarkdown(source: string, labels = DEFAULT_MARKDOWN_LABELS): string {
  return renderCodyMarkdown(source, labels)
}
