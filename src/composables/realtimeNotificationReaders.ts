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

export type TurnActivityState = {
  label: string
  details: string[]
}

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

export type StructuredPlanStepStatus = 'pending' | 'inProgress' | 'completed'
export type StructuredPlanStep = { step: string; status: StructuredPlanStepStatus }
export type StructuredPlanUpdate = {
  threadId: string
  turnId: string
  explanation: string
  steps: StructuredPlanStep[]
  updatedAtIso: string
}

function conversationEvents(notification: RpcNotification) {
  // Reader helpers may be exercised before routing has attached a thread id.
  // The placeholder is never exposed; live state still routes by the raw/native id.
  return normalizeCodexNotification(notification, { fallbackThreadId: '__unrouted__' })
}

function readProtocolId(record: Record<string, unknown> | null | undefined, camelKey: string, snakeKey: string): string {
  return readString(record?.[camelKey]) || readString(record?.[snakeKey])
}

function readTokenCount(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) ? numeric : null
  }
  const numeric = readNumber(value)
  return numeric !== null && numeric >= 0 ? numeric : null
}

export function readThreadContextUsageUpdate(notification: RpcNotification): UiThreadContextUsage | null {
  if (notification.method !== 'thread/tokenUsage/updated') return null
  const params = asRecord(notification.params)
  const tokenUsage = asRecord(params?.tokenUsage) ?? asRecord(params?.token_usage)
  const last = asRecord(tokenUsage?.last)
  const threadId = extractThreadIdFromNotification(notification)
  const usedTokens = readTokenCount(last?.totalTokens) ?? readTokenCount(last?.total_tokens)
  if (!threadId || usedTokens === null) return null

  return {
    threadId,
    turnId: readProtocolId(params, 'turnId', 'turn_id'),
    usedTokens,
    inputTokens: readTokenCount(last?.inputTokens) ?? readTokenCount(last?.input_tokens) ?? 0,
    contextWindow:
      readTokenCount(tokenUsage?.modelContextWindow) ??
      readTokenCount(tokenUsage?.model_context_window),
    autoCompactTokenLimit: null,
    updatedAtIso: readIsoTimestampString(notification.atIso) || new Date().toISOString(),
    compactionState: 'idle',
  }
}

export function extractTurnIdFromNotification(notification: RpcNotification): string {
  return readCoreTurnId(notification.params)
}

export function extractThreadIdFromNotification(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  return readCoreThreadId(notification.params)
    || readProtocolId(params, 'conversationId', 'conversation_id')
}

export function readTurnErrorMessage(notification: RpcNotification): string {
  const failed = conversationEvents(notification).find((event) => event.type === 'turn.failed')
  return typeof failed?.data.error === 'string' ? failed.data.error : ''
}

export function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
  const threadId = extractThreadIdFromNotification(notification)
  if (!threadId) return null

  if (notification.method === 'turn/started') {
    return { threadId, activity: { label: 'Thinking', details: [] } }
  }

  if (notification.method === 'item/started') {
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    const itemType = readString(item?.type).toLowerCase()
    if (itemType === 'reasoning') {
      return { threadId, activity: { label: 'Thinking', details: [] } }
    }
    if (itemType === 'agentmessage') {
      return { threadId, activity: { label: 'Writing response', details: [] } }
    }
    if (itemType === 'plan') {
      return { threadId, activity: { label: 'Writing plan', details: [] } }
    }
  }

  if (
    notification.method === 'item/reasoning/summaryTextDelta' ||
    notification.method === 'item/reasoning/textDelta' ||
    notification.method === 'item/reasoning/summaryPartAdded'
  ) {
    return { threadId, activity: { label: 'Thinking', details: [] } }
  }

  if (notification.method === 'item/agentMessage/delta') {
    return { threadId, activity: { label: 'Writing response', details: [] } }
  }

  if (notification.method === 'item/plan/delta' || notification.method === 'turn/plan/updated') {
    return { threadId, activity: { label: 'Writing plan', details: [] } }
  }

  return null
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

export function liveReasoningMessageId(reasoningItemId: string): string {
  return `${reasoningItemId}:live-reasoning`
}

export function readReasoningStartedItemId(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  if (!params || notification.method !== 'item/started') return ''
  const item = asRecord(params.item)
  if (!item || item.type !== 'reasoning') return ''
  return readString(item.id)
}

export function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'reasoning.delta')
  const delta = typeof event?.data.text === 'string' ? event.data.text : ''
  return event?.itemId && delta ? { messageId: liveReasoningMessageId(event.itemId), delta } : null
}

export function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'reasoning.break')
  return event?.itemId ? liveReasoningMessageId(event.itemId) : ''
}

export function readReasoningCompletedId(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  if (!params || notification.method !== 'item/completed') return ''
  const item = asRecord(params.item)
  if (!item || item.type !== 'reasoning') return ''
  return liveReasoningMessageId(readString(item.id))
}

export function readAgentMessageStartedId(notification: RpcNotification): string {
  const params = asRecord(notification.params)
  if (!params || notification.method !== 'item/started') return ''
  const item = asRecord(params.item)
  if (!item || item.type !== 'agentMessage') return ''
  return readString(item.id)
}

export function readAgentMessageDelta(notification: RpcNotification): { messageId: string; turnId?: string; delta: string } | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'assistant.delta')
  const delta = typeof event?.data.text === 'string' ? event.data.text : ''
  if (!event?.itemId || !delta) return null
  return { messageId: event.itemId, ...(event.turnId ? { turnId: event.turnId } : {}), delta }
}

export function readAgentMessageCompleted(notification: RpcNotification): UiMessage | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'assistant.completed')
  const text = typeof event?.data.text === 'string' ? event.data.text : ''
  if (!event?.itemId || !text) return null
  return { id: event.itemId, turnId: event.turnId, role: 'assistant', text, messageType: 'agentMessage.live' }
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

export function readPlanMessageDelta(notification: RpcNotification): { messageId: string; turnId: string; delta: string } | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'plan.delta')
  const delta = typeof event?.data.text === 'string' ? event.data.text : ''
  return event?.itemId && event.turnId && delta
    ? { messageId: event.itemId, turnId: event.turnId, delta }
    : null
}

export function readPlanMessageCompleted(notification: RpcNotification): UiMessage | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'plan.replaced')
  if (notification.method !== 'item/completed') return null
  const text = typeof event?.data.text === 'string' ? event.data.text : ''
  if (!event?.itemId || !text) return null
  return { id: event.itemId, turnId: event.turnId, role: 'assistant', text, messageType: 'plan.live' }
}

export function readPlanUpdatedMessage(
  notification: RpcNotification,
  planMessageIdForTurn: (turnId: string) => string | undefined,
): UiMessage | null {
  const event = conversationEvents(notification).find((candidate) => candidate.type === 'plan.replaced')
  if (!event?.turnId || notification.method !== 'turn/plan/updated') return null
  const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
  if (!text) return null

  return {
    id: planMessageIdForTurn(event.turnId) ?? `plan:${event.turnId}:live`,
    turnId: event.turnId,
    role: 'assistant',
    text,
    messageType: 'plan.live',
  }
}

export function readStructuredPlanUpdate(notification: RpcNotification): StructuredPlanUpdate | null {
  const params = asRecord(notification.params)
  if (!params || notification.method !== 'turn/plan/updated') return null
  const threadId = extractThreadIdFromNotification(notification)
  const turnId = readProtocolId(params, 'turnId', 'turn_id')
  if (!threadId || !turnId || !Array.isArray(params.plan)) return null
  const steps: StructuredPlanStep[] = []
  for (const value of params.plan) {
    const row = asRecord(value)
    const step = readString(row?.step).trim()
    const status = readString(row?.status)
    if (!step || (status !== 'pending' && status !== 'inProgress' && status !== 'completed')) continue
    steps.push({ step, status })
  }
  if (steps.length === 0) return null
  return {
    threadId, turnId, steps,
    explanation: readString(params.explanation).trim(),
    updatedAtIso: readIsoTimestampString(notification.atIso) ?? new Date().toISOString(),
  }
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
