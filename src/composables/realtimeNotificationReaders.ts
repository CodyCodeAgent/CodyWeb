import type { RpcNotification } from '../api/codexRealtimeClient'
import type { UiMessage, UiThread, UiThreadContextUsage } from '../types/codex'
import { normalizeCodexNotification } from '@codycodeagent/cody-web-core/session'
import {
  readThreadId as readCoreThreadId,
  readTurnId as readCoreTurnId,
} from '@codycodeagent/cody-web-core/protocol'
import { buildUserMessageContentMessages } from '../api/normalizers/userMessageContent'
import {
  asRecord,
  readIsoTimestampMs,
  readIsoTimestampString,
  readNumber,
  readString,
} from '../api/protocolValueReaders'

export type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

export type TurnCompletedInfo = {
  threadId: string
  turnId: string
  completedAtMs: number
  startedAtMs?: number
}

const normalizedEventsByNotification = new WeakMap<RpcNotification, ReturnType<typeof normalizeCodexNotification>>()

/**
 * Normalizes one transport notification exactly once. All product readers for
 * that notification consume the same immutable event snapshot.
 */
export function normalizeRealtimeNotification(notification: RpcNotification) {
  const cached = normalizedEventsByNotification.get(notification)
  if (cached) return cached
  // Reader helpers may be exercised before routing has attached a thread id.
  // The placeholder is never exposed; live state still routes by the raw/native id.
  const events = normalizeCodexNotification(notification, { fallbackThreadId: '__unrouted__' })
  normalizedEventsByNotification.set(notification, events)
  return events
}

const conversationEvents = normalizeRealtimeNotification

function readProtocolId(record: Record<string, unknown> | null | undefined, camelKey: string, snakeKey: string): string {
  return readString(record?.[camelKey]) || readString(record?.[snakeKey])
}

export function readThreadContextUsageUpdate(notification: RpcNotification): UiThreadContextUsage | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'thread.context.updated')
  if (!event || typeof event.data.usedTokens !== 'number') return null

  return {
    threadId: event.threadId,
    turnId: typeof event.data.turnId === 'string' ? event.data.turnId : event.turnId ?? '',
    usedTokens: event.data.usedTokens,
    inputTokens: typeof event.data.inputTokens === 'number' ? event.data.inputTokens : 0,
    contextWindow: typeof event.data.contextWindow === 'number' ? event.data.contextWindow : null,
    autoCompactTokenLimit: typeof event.data.autoCompactTokenLimit === 'number' ? event.data.autoCompactTokenLimit : null,
    updatedAtIso: event.atIso,
    compactionState: 'idle',
  }
}

export function readThreadCompaction(notification: RpcNotification): { threadId: string; updatedAtIso: string } | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'thread.compacted')
  return event ? { threadId: event.threadId, updatedAtIso: event.atIso } : null
}

export function extractTurnIdFromNotification(notification: RpcNotification): string {
  return readCoreTurnId(notification.params)
}

export function extractThreadIdFromNotification(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  return readCoreThreadId(notification.params)
    || readProtocolId(params, 'conversationId', 'conversation_id')
}

export function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'turn.started')
  if (!event?.turnId) return null
  const params = asRecord(notification.params)
  if (!params) return null
  const turnPayload = asRecord(params.turn)
  const startedAtMs =
    readIsoTimestampMs(turnPayload?.startedAt) ??
    readIsoTimestampMs(params.startedAt) ??
    readIsoTimestampMs(notification.atIso) ??
    Date.now()

  return { threadId: event.threadId, turnId: event.turnId, startedAtMs }
}

export function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
  const event = conversationEvents(notification).find((candidate) => (
    candidate.type === 'turn.completed' || candidate.type === 'turn.failed' || candidate.type === 'turn.interrupted'
  ))
  if (!event?.turnId) return null
  const params = asRecord(notification.params)
  if (!params) return null
  const turnPayload = asRecord(params.turn)
  const completedAtMs =
    readIsoTimestampMs(turnPayload?.completedAt) ??
    readIsoTimestampMs(params.completedAt) ??
    readIsoTimestampMs(notification.atIso) ??
    Date.now()

  const startedAtMs =
    readIsoTimestampMs(turnPayload?.startedAt) ??
    readIsoTimestampMs(params.startedAt) ??
    undefined

  return { threadId: event.threadId, turnId: event.turnId, completedAtMs, startedAtMs }
}

export function readTurnDurationHints(notification: RpcNotification): {
  explicitDurationMs: number | null
  turnDurationMs: number | null
} {
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  return {
    explicitDurationMs: readNumber(params?.durationMs),
    turnDurationMs: readNumber(turn?.durationMs),
  }
}

export function readRateLimitSnapshotPayload(notification: RpcNotification): unknown | null {
  if (notification.method !== 'account/rateLimits/updated') return null
  const params = asRecord(notification.params)
  return params?.rateLimits ?? null
}

export function readStartedThread(notification: RpcNotification): UiThread | null {
  if (notification.method !== 'thread/started') return null
  const params = asRecord(notification.params)
  if (!params) return null

  const threadPayload = asRecord(params.thread) ?? params
  const id = readString(threadPayload.id) || readString(params.threadId)
  if (!id) return null

  const cwd = readString(threadPayload.cwd) || readString(params.cwd)
  const projectName =
    readString(threadPayload.projectName) ||
    readString(threadPayload.project_name) ||
    readString(params.projectName) ||
    cwd ||
    'unknown-project'
  const title =
    readString(threadPayload.title) ||
    readString(threadPayload.name) ||
    readString(params.title) ||
    'Untitled thread'
  const preview = readString(threadPayload.preview) || readString(params.preview) || title
  const timestamp =
    readIsoTimestampString(threadPayload.updatedAt) ||
    readIsoTimestampString(threadPayload.updated_at) ||
    readIsoTimestampString(threadPayload.createdAt) ||
    readIsoTimestampString(threadPayload.created_at) ||
    notification.atIso
  const createdAtIso =
    readIsoTimestampString(threadPayload.createdAt) ||
    readIsoTimestampString(threadPayload.created_at) ||
    timestamp
  const updatedAtIso =
    readIsoTimestampString(threadPayload.updatedAt) ||
    readIsoTimestampString(threadPayload.updated_at) ||
    timestamp

  return {
    id,
    title,
    projectName,
    cwd,
    createdAtIso,
    updatedAtIso,
    preview,
    unread: false,
    inProgress: false,
  }
}

export function readUserMessageCompleted(notification: RpcNotification): UiMessage[] {
  const params = asRecord(notification.params)
  if (!params || notification.method !== 'item/completed') return []
  const item = asRecord(params.item)
  if (!item || item.type !== 'userMessage') return []

  const itemId = readString(item.id)
  const turnId = readProtocolId(params, 'turnId', 'turn_id')
  if (!itemId || !Array.isArray(item.content)) return []
  return buildUserMessageContentMessages(itemId, item.content, 'userMessage', turnId)
}

export function isAgentContentEvent(notification: RpcNotification): boolean {
  if (notification.method === 'item/agentMessage/delta' || notification.method === 'item/plan/delta') {
    return true
  }

  const params = asRecord(notification.params)
  if (!params) return false

  if (notification.method === 'item/completed') {
    const item = asRecord(params.item)
    return item?.type === 'agentMessage' || item?.type === 'plan'
  }

  return notification.method === 'turn/plan/updated'
}
