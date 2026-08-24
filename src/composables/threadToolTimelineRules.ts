import type { UiMessage, UiToolTimelineEntry } from '../types/codex'
import { previewToolOutput, toolStatusTone as coreToolStatusTone } from '@codycodeagent/cody-web-core/conversation'

export type ToolStatusTone = 'success' | 'danger' | 'working' | 'neutral'

export const TOOL_OUTPUT_PREVIEW_LINE_COUNT = 80
export const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 12000

export type FileChangeMessageGroup = {
  headId: string
  messages: UiMessage[]
  messageIds: string[]
  fileCount: number
  updateCount: number
  status: string
}

function fileChangeCountFromSummary(summary: string): number | null {
  const match = summary.match(/\b(\d+)\s+files?\s+changed\b/iu)
  if (!match?.[1]) return null
  const count = Number(match[1])
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null
}

export function isGroupableFileChangeMessage(message: UiMessage): boolean {
  return message.tool?.kind === 'fileChange'
    && message.text.trim().length === 0
    && (message.images?.length ?? 0) === 0
    && (message.skills?.length ?? 0) === 0
}

export function fileChangeMessageCount(message: UiMessage): number {
  if (message.tool?.kind !== 'fileChange') return 0
  const summaryCount = fileChangeCountFromSummary(message.tool.summary)
  if (summaryCount !== null) return summaryCount
  return message.tool.details.filter((detail) => !/^status\s*:/iu.test(detail.trim())).length
}

export function fileChangeMessageDetails(message: UiMessage): string[] {
  if (message.tool?.kind !== 'fileChange') return []
  return message.tool.details.filter((detail) => !/^status\s*:/iu.test(detail.trim()))
}

function fileChangeGroupStatus(messages: UiMessage[]): string {
  const statuses = messages
    .map((message) => message.tool?.status.trim() ?? '')
    .filter((status) => status.length > 0)
  const failed = statuses.find((status) => isToolFailureStatus(status))
  if (failed) return failed
  const working = statuses.find((status) => toolStatusTone(status) === 'working')
  if (working) return working
  return statuses.at(-1) ?? 'unknown'
}

function toFileChangeMessageGroup(messages: UiMessage[]): FileChangeMessageGroup {
  return {
    headId: messages[0]?.id ?? '',
    messages,
    messageIds: messages.map((message) => message.id),
    fileCount: messages.reduce((total, message) => total + fileChangeMessageCount(message), 0),
    updateCount: messages.length,
    status: fileChangeGroupStatus(messages),
  }
}

export function buildFileChangeMessageGroups(messages: UiMessage[]): FileChangeMessageGroup[] {
  const groups: FileChangeMessageGroup[] = []
  let pending: UiMessage[] = []

  const flush = () => {
    if (pending.length === 0) return
    groups.push(toFileChangeMessageGroup(pending))
    pending = []
  }

  for (const message of messages) {
    if (isGroupableFileChangeMessage(message)) {
      pending.push(message)
      continue
    }
    flush()
  }
  flush()
  return groups
}

export function fileChangeCountLabel(count: number): string {
  const normalized = Math.max(0, Math.trunc(count))
  return `${String(normalized)} file${normalized === 1 ? '' : 's'}`
}

export function fileChangeUpdateLabel(count: number): string {
  const normalized = Math.max(0, Math.trunc(count))
  return `${String(normalized)} update${normalized === 1 ? '' : 's'}`
}

export function isToolFailureStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase()
  return (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('decline') ||
    normalized.includes('cancel')
  )
}

export function formatToolStatus(status: string): string {
  const normalized = status.trim()
  if (!normalized) return 'unknown'
  return normalized
    .replace(/[-_]+/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

export function toolStatusTone(status: string): ToolStatusTone {
  const coreTone = coreToolStatusTone(status)
  if (coreTone === 'running') return 'working'
  if (coreTone === 'success' || coreTone === 'danger') return coreTone
  const normalized = status.trim().toLowerCase()
  if (!normalized) return 'neutral'
  if (isToolFailureStatus(normalized)) return 'danger'
  if (
    normalized.includes('running') ||
    normalized.includes('progress') ||
    normalized.includes('pending') ||
    normalized.includes('started')
  ) {
    return 'working'
  }
  if (
    normalized.includes('success') ||
    normalized.includes('complete') ||
    normalized.includes('done') ||
    normalized.includes('applied')
  ) {
    return 'success'
  }
  return 'neutral'
}

export function isToolTimelineExpandedByDefault(tool: UiToolTimelineEntry): boolean {
  return tool.kind !== 'fileChange'
}

export function isToolOutputTruncated(
  output: string,
  lineLimit = TOOL_OUTPUT_PREVIEW_LINE_COUNT,
  charLimit = TOOL_OUTPUT_PREVIEW_MAX_CHARS,
): boolean {
  if (output.length > Math.max(Math.trunc(charLimit), 1)) return true
  const normalizedLineLimit = Math.max(Math.trunc(lineLimit), 1)
  return output.split(/\r\n|\r|\n/u).length > normalizedLineLimit
}

export function buildToolOutputPreview(
  output: string,
  lineLimit = TOOL_OUTPUT_PREVIEW_LINE_COUNT,
  charLimit = TOOL_OUTPUT_PREVIEW_MAX_CHARS,
): string {
  return previewToolOutput(output, lineLimit, charLimit).text
}

export function toolOutputToggleLabel(isExpanded: boolean): string {
  return isExpanded ? 'Show preview' : 'Show full output'
}
