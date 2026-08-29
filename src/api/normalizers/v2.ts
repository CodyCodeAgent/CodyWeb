import type {
  Thread,
  ThreadItem,
  ThreadReadResponse,
  ThreadListResponse,
  Turn,
} from '../appServerDtos'
import type { UiMessage, UiProjectGroup, UiThread } from '../../types/codex'
import {
  conversationToolFromItem as buildToolTimelineEntry,
  readCodexStatus as readStatus,
} from '@codycodeagent/cody-web-core/session'
import {
  buildUserMessageContentMessages,
  toRawPayload,
} from './userMessageContent'

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function toProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) || cwd || 'unknown-project'
}

function buildToolMessage(item: ThreadItem, turnId: string): UiMessage | null {
  const tool = buildToolTimelineEntry(item)
  if (!tool) return null

  return {
    id: item.id,
    turnId,
    role: 'system',
    text: '',
    messageType: `tool.${item.type}`,
    rawPayload: toRawPayload(item),
    tool,
  }
}

function toUiMessages(item: ThreadItem, turnId: string): UiMessage[] {
  if (item.type === 'agentMessage') {
    return [
      {
        id: item.id,
        turnId,
        role: 'assistant',
        text: item.text,
        messageType: item.type,
      },
    ]
  }

  if (item.type === 'plan') {
    return [
      {
        id: item.id,
        turnId,
        role: 'assistant',
        text: item.text,
        messageType: item.type,
      },
    ]
  }

  if (item.type === 'userMessage') {
    return buildUserMessageContentMessages(item.id, item.content, item.type, turnId)
  }

  if (item.type === 'reasoning') {
    return []
  }

  const toolMessage = buildToolMessage(item, turnId)
  return toolMessage ? [toolMessage] : []
}

function buildTurnReceipt(turn: Turn): UiMessage | null {
  const status = readStatus(turn.status)
  if (status === 'inProgress') return null
  const commandCount = turn.items.filter((item) => item.type === 'commandExecution').length
  const toolCount = turn.items.filter((item) => (
    item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'webSearch' || item.type === 'collabAgentToolCall'
  )).length
  const fileCount = turn.items
    .filter((item): item is Extract<ThreadItem, { type: 'fileChange' }> => item.type === 'fileChange')
    .reduce((total, item) => total + item.changes.length, 0)
  const validationCount = turn.items.filter((item) => (
    item.type === 'commandExecution' && /(?:^|\s)(?:test|build|typecheck|lint)(?:\s|$)/iu.test(item.command) && item.exitCode === 0
  )).length
  const planCompleted = turn.items.some((item) => item.type === 'plan' && /\[done\]/iu.test(item.text) && !/\[(?:doing|todo)\]/iu.test(item.text))
  const label = status === 'failed'
    ? 'Failed'
    : status === 'interrupted'
      ? 'Stopped'
      : planCompleted && validationCount > 0
        ? 'Completed'
        : fileCount > 0
          ? 'Changed'
          : toolCount > 0
            ? 'Worked'
            : 'Answered'
  const evidence = [
    fileCount > 0 ? `${String(fileCount)} file${fileCount === 1 ? '' : 's'}` : '',
    commandCount > 0 ? `${String(commandCount)} command${commandCount === 1 ? '' : 's'}` : '',
    validationCount > 0 ? `${String(validationCount)} validation${validationCount === 1 ? '' : 's'} passed` : '',
  ].filter(Boolean)
  return {
    id: `turn-summary:${turn.id}`,
    turnId: turn.id,
    role: 'system',
    text: [label, ...evidence].join(' · '),
    messageType: 'worked',
    rawPayload: JSON.stringify({ label, status, fileCount, commandCount, validationCount }),
  }
}

function pickThreadName(summary: Thread): string {
  const rawSummary = summary as Thread & { name?: unknown; title?: unknown }
  const direct = [rawSummary.name, rawSummary.title, summary.preview]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return ''
}

function toThreadTitle(summary: Thread): string {
  const named = pickThreadName(summary)
  return named.length > 0 ? named : 'Untitled thread'
}

function toUiThread(summary: Thread): UiThread {
  return {
    id: summary.id,
    title: toThreadTitle(summary),
    projectName: summary.cwd || toProjectName(summary.cwd),
    cwd: summary.cwd,
    createdAtIso: toIso(summary.createdAt),
    updatedAtIso: toIso(summary.updatedAt),
    preview: summary.preview,
    unread: false,
    inProgress: false,
  }
}

function groupThreadsByProject(threads: UiThread[]): UiProjectGroup[] {
  const grouped = new Map<string, UiThread[]>()
  for (const thread of threads) {
    const rows = grouped.get(thread.projectName)
    if (rows) rows.push(thread)
    else grouped.set(thread.projectName, [thread])
  }

  return Array.from(grouped.entries())
    .map(([projectName, projectThreads]) => ({
      projectName,
      cwd: projectName,
      threads: projectThreads.sort(
        (a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLast = new Date(a.threads[0]?.updatedAtIso ?? 0).getTime()
      const bLast = new Date(b.threads[0]?.updatedAtIso ?? 0).getTime()
      return bLast - aLast
    })
}

export function normalizeThreadGroupsV2(payload: ThreadListResponse): UiProjectGroup[] {
  const uiThreads = payload.data.map(toUiThread)
  return groupThreadsByProject(uiThreads)
}

export function normalizeThreadMessagesV2(payload: ThreadReadResponse): UiMessage[] {
  const turns = Array.isArray(payload.thread.turns) ? payload.thread.turns : []
  const messages: UiMessage[] = []
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const item of items) {
      messages.push(...toUiMessages(item, turn.id))
    }
    const receipt = buildTurnReceipt(turn)
    if (receipt) messages.push(receipt)
  }
  return messages
}
