import type { UiLiveOverlay, UiMessage, UiToolingRollbackFileResult } from '../types/codex'
import {
  areConversationMessageArraysStable,
  areConversationMessageFieldsEqual,
  compactConversationMessages,
  formatTurnDuration as coreFormatTurnDuration,
  mergeMessages as coreMergeMessages,
  normalizeMessageText as coreNormalizeMessageText,
  removeDuplicateAdjacentUserMessages as coreRemoveDuplicateAdjacentUserMessages,
  removeRedundantLiveAssistantMessages as coreRemoveRedundantLiveAssistantMessages,
  upsertLiveDelta as coreUpsertLiveDelta,
} from '@codycodeagent/cody-web-core/conversation'

const WORKED_MESSAGE_TYPE = 'worked'

export type TurnSummaryState = {
  turnId: string
  durationMs: number
}

export type TurnErrorState = {
  message: string
}

export type TurnActivityState = {
  label: string
  details: string[]
}

export type LiveAssistantMessageType = 'agentMessage.live' | 'plan.live'

export function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  return areConversationMessageArraysStable(first, second)
}

export function removeDuplicateAdjacentUserMessages(messages: UiMessage[]): UiMessage[] {
  return coreRemoveDuplicateAdjacentUserMessages(messages)
}

export function removeMessageById(messages: UiMessage[], messageId: string): UiMessage[] {
  if (!messageId) return messages
  const next = messages.filter((message) => message.id !== messageId)
  return next.length === messages.length ? messages : next
}

export function replaceMessageById(messages: UiMessage[], messageId: string, replacement: UiMessage): UiMessage[] {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return messages
  const next = messages.filter((message) => message.id !== replacement.id)
  const replacementIndex = next.findIndex((message) => message.id === messageId)
  if (replacementIndex < 0) return messages
  next.splice(replacementIndex, 1, replacement)
  return next
}

export function removeLivePlanMessagesForTurn(
  messages: UiMessage[],
  turnId: string,
  planMessageId?: string,
): UiMessage[] {
  if (!turnId) return messages
  const fallbackPlanMessageId = `plan:${turnId}:live`
  const removableIds = new Set([fallbackPlanMessageId])
  const normalizedPlanMessageId = planMessageId?.trim()
  if (normalizedPlanMessageId) {
    removableIds.add(normalizedPlanMessageId)
  }

  const next = messages.filter((message) => {
    return message.messageType !== 'plan.live' || !removableIds.has(message.id)
  })
  return next.length === messages.length ? messages : next
}

export function finalizeLiveMessagesForTurn(
  persistedMessages: UiMessage[],
  liveMessages: UiMessage[],
  turnId: string,
): { persistedMessages: UiMessage[]; liveMessages: UiMessage[] } {
  if (!turnId) {
    return { persistedMessages, liveMessages }
  }

  // The live layer is only an overlay for the currently running turn. A
  // history refresh may contain the final answer already, so reconcile against
  // the complete loaded window before promoting anything. This avoids relying
  // on the newest (small) server page to clean up realtime copies.
  const unreconciledLiveMessages = removeRedundantLiveAgentMessages(liveMessages, persistedMessages)
  const completedAgentMessages = unreconciledLiveMessages
    .filter((message) => {
      return message.messageType === 'agentMessage.live'
        && (!message.turnId || message.turnId === turnId)
    })
    .map((message): UiMessage => ({
      ...message,
      messageType: 'agentMessage',
    }))

  return {
    persistedMessages: completedAgentMessages.length > 0
      ? mergeMessages(persistedMessages, completedAgentMessages, { preserveMissing: true })
      : persistedMessages,
    // A thread can only have one active turn. Once it completes, any remaining
    // live rows belong either to that turn or to an older stale overlay and
    // must not be appended to the end of the conversation forever.
    liveMessages: [],
  }
}

function omitRecordKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

export function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: { preserveMissing?: boolean } = {},
): UiMessage[] {
  return coreMergeMessages(previous, incoming, options)
}

export function normalizeMessageText(value: string): string {
  return coreNormalizeMessageText(value)
}

export function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  return coreRemoveRedundantLiveAssistantMessages(previous, incoming)
}

export function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areConversationMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

export function upsertMessages(previous: UiMessage[], nextMessages: UiMessage[]): UiMessage[] {
  let next = previous
  for (const message of nextMessages) {
    next = upsertMessage(next, message)
  }
  return next
}

export function updateMessagesForThread(
  state: Record<string, UiMessage[]>,
  threadId: string,
  nextMessages: UiMessage[],
): Record<string, UiMessage[]> {
  if (!threadId) return state
  const previous = state[threadId] ?? []
  if (areMessageArraysEqual(previous, nextMessages)) return state
  return {
    ...state,
    [threadId]: nextMessages,
  }
}

export function upsertLiveAssistantDelta(
  previous: UiMessage[],
  delta: {
    messageId: string
    textDelta: string
    messageType: LiveAssistantMessageType
    turnId?: string
  },
): UiMessage[] {
  return coreUpsertLiveDelta(previous, delta)
}

export function upsertLiveAssistantDeltaForThread(
  state: Record<string, UiMessage[]>,
  threadId: string,
  delta: {
    messageId: string
    textDelta: string
    messageType: LiveAssistantMessageType
    turnId?: string
  },
): Record<string, UiMessage[]> {
  if (!threadId) return state
  return updateMessagesForThread(
    state,
    threadId,
    upsertLiveAssistantDelta(state[threadId] ?? [], delta),
  )
}

export function normalizeLiveReasoningTextForStorage(text: string): string {
  return text.trim().length === 0 ? '' : text
}

export function appendLiveReasoningDelta(previous: string, delta: string): string {
  return normalizeLiveReasoningTextForStorage(`${previous}${delta}`)
}

export function appendLiveReasoningSectionBreak(current: string): string {
  if (current.trim().length === 0 || current.endsWith('\n\n')) return current
  return `${current}\n\n`
}

export function updateLiveReasoningTextForThread(
  state: Record<string, string>,
  threadId: string,
  text: string,
): Record<string, string> {
  if (!threadId) return state
  const normalized = normalizeLiveReasoningTextForStorage(text)
  const previous = state[threadId] ?? ''
  if (normalized.length === 0) return previous ? omitRecordKey(state, threadId) : state
  if (previous === normalized) return state
  return {
    ...state,
    [threadId]: normalized,
  }
}

export function appendLiveReasoningDeltaForThread(
  state: Record<string, string>,
  threadId: string,
  delta: string,
): Record<string, string> {
  if (!threadId) return state
  return updateLiveReasoningTextForThread(
    state,
    threadId,
    appendLiveReasoningDelta(state[threadId] ?? '', delta),
  )
}

export function appendLiveReasoningSectionBreakForThread(
  state: Record<string, string>,
  threadId: string,
): Record<string, string> {
  if (!threadId) return state
  return updateLiveReasoningTextForThread(
    state,
    threadId,
    appendLiveReasoningSectionBreak(state[threadId] ?? ''),
  )
}

export function clearLiveReasoningTextForThread(
  state: Record<string, string>,
  threadId: string,
): Record<string, string> {
  if (!threadId || !(threadId in state)) return state
  return omitRecordKey(state, threadId)
}

export function buildDisplayedMessages(
  persistedMessages: UiMessage[],
  liveAgentMessages: UiMessage[],
  turnSummary: TurnSummaryState | null | undefined,
): UiMessage[] {
  const combined = persistedMessages === liveAgentMessages
    ? persistedMessages
    : [...persistedMessages, ...liveAgentMessages]
  const compacted = compactConversationMessages(combined)

  return turnSummary ? insertTurnSummaryMessage(compacted, turnSummary) : compacted
}

export function formatTurnDuration(durationMs: number): string {
  return coreFormatTurnDuration(durationMs)
}

export function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId && first.durationMs === second.durationMs
}

export function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function sanitizeDisplayText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function mergeTurnActivity(
  previous: TurnActivityState | undefined,
  activity: TurnActivityState,
): TurnActivityState {
  const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
  const incomingDetails = activity.details
    .map((line) => sanitizeDisplayText(line))
    .filter((line) => line.length > 0 && line !== normalizedLabel)
  const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)

  return {
    label: normalizedLabel,
    details: mergedDetails,
  }
}

export function updateTurnSummaryState(
  state: Record<string, TurnSummaryState>,
  threadId: string,
  summary: TurnSummaryState | null,
): Record<string, TurnSummaryState> {
  if (!threadId) return state

  const previous = state[threadId]
  if (!summary) return previous ? omitRecordKey(state, threadId) : state
  if (areTurnSummariesEqual(previous, summary)) return state

  return {
    ...state,
    [threadId]: summary,
  }
}

export function updateTurnActivityState(
  state: Record<string, TurnActivityState>,
  threadId: string,
  activity: TurnActivityState | null,
): Record<string, TurnActivityState> {
  if (!threadId) return state

  const previous = state[threadId]
  if (!activity) return previous ? omitRecordKey(state, threadId) : state

  const nextActivity = mergeTurnActivity(previous, activity)
  if (areTurnActivitiesEqual(previous, nextActivity)) return state

  return {
    ...state,
    [threadId]: nextActivity,
  }
}

export function updateTurnErrorState(
  state: Record<string, TurnErrorState>,
  threadId: string,
  message: string | null,
): Record<string, TurnErrorState> {
  if (!threadId) return state

  const previous = state[threadId]
  const normalizedMessage = message ? normalizeMessageText(message) : ''
  if (!normalizedMessage) return previous ? omitRecordKey(state, threadId) : state
  if (previous?.message === normalizedMessage) return state

  return {
    ...state,
    [threadId]: { message: normalizedMessage },
  }
}

export function buildLiveOverlay(
  threadId: string,
  activityByThreadId: Record<string, TurnActivityState>,
  reasoningTextByThreadId: Record<string, string>,
  errorByThreadId: Record<string, TurnErrorState>,
): UiLiveOverlay | null {
  if (!threadId) return null

  const activity = activityByThreadId[threadId]
  const reasoningText = (reasoningTextByThreadId[threadId] ?? '').trim()
  const errorText = (errorByThreadId[threadId]?.message ?? '').trim()

  if (!activity && !reasoningText && !errorText) return null
  return {
    activityLabel: activity?.label || 'Thinking',
    activityDetails: activity?.details ?? [],
    reasoningText,
    errorText,
  }
}

export function resolveTurnDurationMs(values: {
  explicitDurationMs?: number | null
  turnDurationMs?: number | null
  completedStartedAtMs?: number | null
  completedAtMs: number
  pendingStartedAtMs?: number | null
}): number {
  const rawDurationMs =
    values.explicitDurationMs ??
    values.turnDurationMs ??
    (typeof values.completedStartedAtMs === 'number'
      ? values.completedAtMs - values.completedStartedAtMs
      : null) ??
    (typeof values.pendingStartedAtMs === 'number'
      ? values.completedAtMs - values.pendingStartedAtMs
      : null)

  return typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : 0
}

export function buildTurnSummaryMessage(summary: TurnSummaryState): UiMessage {
  return {
    id: `turn-summary:${summary.turnId}`,
    turnId: summary.turnId,
    role: 'system',
    text: `Worked for ${formatTurnDuration(summary.durationMs)}`,
    messageType: WORKED_MESSAGE_TYPE,
  }
}

export function buildRollbackAuditMessage(result: UiToolingRollbackFileResult): UiMessage {
  const remainingStatus = result.remainingStatus.trim()
  const checkpoint = result.checkpoint
  return {
    id: `tooling.rollback:${checkpoint.id}:${result.relativePath}`,
    role: 'system',
    text: '',
    messageType: 'tool.rollback',
    tool: {
      kind: 'rollback',
      title: 'File rollback',
      status: result.rollbackApplied ? 'completed' : 'no changes',
      summary: result.rollbackApplied
        ? `Rolled back ${result.relativePath}`
        : `No local changes found for ${result.relativePath}`,
      details: [
        `file: ${result.relativePath}`,
        `checkpoint: ${checkpoint.id}`,
        `patch bytes: ${String(checkpoint.patchBytes)}`,
        `remaining status: ${remainingStatus || 'clean'}`,
      ],
      output: checkpoint.patchPath,
      outputLabel: 'Checkpoint patch',
    },
  }
}

function findLastAssistantMessageIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return index
    }
  }
  return -1
}

export function insertTurnSummaryMessage(messages: UiMessage[], summary: TurnSummaryState): UiMessage[] {
  const summaryMessage = buildTurnSummaryMessage(summary)
  const sanitizedMessages = messages.filter((message) => message.id !== summaryMessage.id)
  return [...sanitizedMessages, summaryMessage]
}
