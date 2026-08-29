import type { RpcNotification } from '../api/codexRealtimeClient'
import type { UiMessage, UiThread } from '../types/codex'
import { normalizeCodexNotification } from '@codycodeagent/cody-web-core/session'
import {
  readThreadId as readCoreThreadId,
  readTurnId as readCoreTurnId,
} from '@codycodeagent/cody-web-core/protocol'
import { buildUserMessageContentMessages } from '../api/normalizers/userMessageContent'
import {
  asRecord,
  readIsoTimestampString,
  readString,
} from '../api/protocolValueReaders'

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

export function extractTurnIdFromNotification(notification: RpcNotification): string {
  return readCoreTurnId(notification.params)
}

export function extractThreadIdFromNotification(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  return readCoreThreadId(notification.params)
    || readProtocolId(params, 'conversationId', 'conversation_id')
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
  return conversationEvents(notification).some((event) => (
    event.type === 'assistant.delta' ||
    event.type === 'assistant.completed' ||
    event.type === 'plan.delta' ||
    event.type === 'plan.replaced'
  ))
}
