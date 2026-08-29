import type { UiMessage, UiServerRequest, UiToolTimelineEntry } from '../types/codex'
import type { UiDiffLineKind, UiDiffReview, UiDiffReviewFile } from './useDiffReview'
import {
  buildServerRequestCards,
  isServerApprovalRequest,
  isToolFailureStatus,
  type ApprovalRiskTranslator,
  type ServerRequestCard,
} from '@codycodeagent/cody-web-core/presentation'
export { isToolFailureStatus } from '@codycodeagent/cody-web-core/presentation'

export type UiThreadActivityEntry = UiToolTimelineEntry & {
  messageId: string
}

export type UiThreadActivitySummary = {
  toolCount: number
  commandCount: number
  fileChangeCount: number
  mcpCount: number
  failedCount: number
  pendingRequestCount: number
}

export type UiThreadCommandEntry = UiToolTimelineEntry & {
  messageId: string
  cwd: string
  exitCode: number | null
  duration: string
}

export type WorkLogMetric = {
  label: string
  value: string
}

export type WorkLogActionState = {
  badgeCount: number
  badgeText: string
  floatSummary: string
  triggerLabel: string
}

export type WorkLogDisplayPath = {
  label: string
  directory: string
  title: string
}

export type PendingApprovalCard = ServerRequestCard<UiServerRequest>

export function buildThreadActivityEntries(messages: UiMessage[]): UiThreadActivityEntry[] {
  return messages
    .filter((message): message is UiMessage & { tool: UiToolTimelineEntry } => Boolean(message.tool))
    .map((message) => ({
      ...message.tool,
      messageId: message.id,
    }))
}

function parseDetailValue(details: string[], key: string): string {
  const prefix = `${key}:`
  const row = details.find((detail) => detail.trim().toLowerCase().startsWith(prefix))
  if (!row) return ''
  return row.slice(prefix.length).trim()
}

function parseExitCode(details: string[]): number | null {
  const raw = parseDetailValue(details, 'exit')
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function buildThreadCommandEntries(messages: UiMessage[]): UiThreadCommandEntry[] {
  return buildThreadActivityEntries(messages)
    .filter((entry) => entry.kind === 'command')
    .map((entry) => ({
      ...entry,
      cwd: parseDetailValue(entry.details, 'cwd'),
      exitCode: parseExitCode(entry.details),
      duration: parseDetailValue(entry.details, 'duration'),
    }))
}

export function buildThreadActivitySummary(
  messages: UiMessage[],
  pendingRequests: UiServerRequest[],
): UiThreadActivitySummary {
  const entries = buildThreadActivityEntries(messages)

  return {
    toolCount: entries.length,
    commandCount: entries.filter((entry) => entry.kind === 'command').length,
    fileChangeCount: entries.filter((entry) => entry.kind === 'fileChange').length,
    mcpCount: entries.filter((entry) => entry.kind === 'mcp').length,
    failedCount: entries.filter((entry) => isToolFailureStatus(entry.status)).length,
    pendingRequestCount: pendingRequests.length,
  }
}

export function buildWorkLogStatusText(input: {
  pendingRequestCount: number
  fileCount: number
  commandCount: number
}): string {
  if (input.pendingRequestCount > 0) return `${String(input.pendingRequestCount)} waiting`
  if (input.fileCount > 0 || input.commandCount > 0) {
    return `${String(input.fileCount)} changed file${input.fileCount === 1 ? '' : 's'} · ${String(input.commandCount)} command${input.commandCount === 1 ? '' : 's'}`
  }
  return 'No changes or commands recorded yet'
}

export function buildWorkLogFloatSummary(input: {
  fileCount: number
  commandCount: number
}): string {
  return `${String(input.fileCount)} file${input.fileCount === 1 ? '' : 's'} · ${String(input.commandCount)} command${input.commandCount === 1 ? '' : 's'}`
}

export function buildWorkLogTriggerLabel(input: {
  isOpen: boolean
  fileCount: number
  commandCount: number
}): string {
  const action = input.isOpen ? 'Close' : 'Open'
  return `${action} work log: ${buildWorkLogFloatSummary(input)}`
}

export function buildWorkLogBadgeText(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}

export function buildWorkLogActionState(input: {
  isOpen: boolean
  fileCount: number
  commandCount: number
}): WorkLogActionState {
  const badgeCount = Math.max(Math.trunc(input.fileCount), 0)
  return {
    badgeCount,
    badgeText: buildWorkLogBadgeText(badgeCount),
    floatSummary: buildWorkLogFloatSummary(input),
    triggerLabel: buildWorkLogTriggerLabel(input),
  }
}

export function buildWorkLogMetrics(input: {
  fileCount: number
  commandCount: number
  addedLines: number
  removedLines: number
}): WorkLogMetric[] {
  return [
    { label: 'files', value: String(input.fileCount) },
    { label: 'commands', value: String(input.commandCount) },
    { label: 'added', value: `+${String(input.addedLines)}` },
    { label: 'removed', value: `-${String(input.removedLines)}` },
  ]
}

export function buildPendingApprovalSubtitle(count: number): string {
  return `${String(count)} approval${count === 1 ? '' : 's'} waiting`
}

export function isPendingApprovalRequest(request: UiServerRequest): boolean {
  return isServerApprovalRequest(request)
}

export function buildPendingApprovalCards(
  requests: UiServerRequest[],
  approvalRiskTranslator?: ApprovalRiskTranslator,
): PendingApprovalCard[] {
  return buildServerRequestCards(requests, approvalRiskTranslator)
}

export function buildWorkLogFileStatLabel(input: {
  addedLines: number
  removedLines: number
}): string {
  return `+${String(input.addedLines)} / -${String(input.removedLines)}`
}

export function buildWorkLogDisplayPath(filePath: string, cwd = ''): string {
  const normalizedPath = filePath.trim()
  if (!normalizedPath) return ''

  const normalizedCwd = cwd.trim().replace(/\/+$/u, '')
  if (normalizedCwd && normalizedPath === normalizedCwd) {
    return normalizedPath.split('/').filter(Boolean).at(-1) ?? normalizedPath
  }
  if (normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1)
  }

  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length <= 3) return normalizedPath
  return `.../${parts.slice(-3).join('/')}`
}

export function buildWorkLogDisplayPathParts(filePath: string, cwd = ''): WorkLogDisplayPath {
  const displayPath = buildWorkLogDisplayPath(filePath, cwd)
  const normalizedPath = filePath.trim()
  if (!displayPath) {
    return { label: '', directory: '', title: normalizedPath }
  }

  const parts = displayPath.split('/').filter(Boolean)
  const label = parts.at(-1) ?? displayPath
  const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
  return {
    label,
    directory,
    title: normalizedPath || displayPath,
  }
}

export function filterWorkLogFiles(
  files: UiDiffReviewFile[],
  query: string,
  cwd = '',
): UiDiffReviewFile[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return files

  return files.filter((file) => {
    const displayPath = buildWorkLogDisplayPathParts(file.filePath, cwd)
    return [
      file.filePath,
      file.oldPath ?? '',
      displayPath.label,
      displayPath.directory,
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}

export function workLogBadgeCount(review: UiDiffReview): number {
  return review.summary.fileCount
}

export function workLogFullscreenFile(review: UiDiffReview, filePath: string): UiDiffReviewFile | null {
  if (!filePath) return null
  return review.files.find((file) => file.filePath === filePath) ?? null
}

export function shouldCloseWorkLogFullscreenFile(review: UiDiffReview, filePath: string): boolean {
  return Boolean(filePath) && !review.files.some((file) => file.filePath === filePath)
}

export function formatWorkLogLineNumber(value: number | null): string {
  return typeof value === 'number' ? String(value) : ''
}

export function workLogDiffLinePrefix(kind: UiDiffLineKind): string {
  if (kind === 'add') return '+'
  if (kind === 'remove') return '-'
  return ''
}
