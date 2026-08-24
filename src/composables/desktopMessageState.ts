import type { TurnActivityState } from './realtimeNotificationReaders'
import type { UiLiveOverlay, UiMessage, UiToolingRollbackFileResult } from '../types/codex'
import { mergeMessages as coreMergeMessages } from '@codycodeagent/cody-web-core/conversation'

const WORKED_MESSAGE_TYPE = 'worked'

export type TurnSummaryState = {
  turnId: string
  durationMs: number
}

export type TurnErrorState = {
  message: string
}

export type LiveAssistantMessageType = 'agentMessage.live' | 'plan.live'

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function areMessageSkillsEqual(first?: UiMessage['skills'], second?: UiMessage['skills']): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.name !== right[index]?.name ||
      left[index]?.path !== right[index]?.path
    ) {
      return false
    }
  }
  return true
}

function normalizeImageIdentity(value: string): string {
  const normalized = value.trim()
  const prefix = '/codex-api/local-image?path='
  if (!normalized.startsWith(prefix)) return normalized
  try { return decodeURIComponent(normalized.slice(prefix.length)) } catch { return normalized }
}

function areMessageImagesEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first.map(normalizeImageIdentity) : []
  const right = Array.isArray(second) ? second.map(normalizeImageIdentity) : []
  return areStringArraysEqual(left, right)
}

function areMessageToolsEqual(first: UiMessage['tool'], second: UiMessage['tool']): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (
    first.kind !== second.kind ||
    first.title !== second.title ||
    first.status !== second.status ||
    first.summary !== second.summary ||
    first.output !== second.output ||
    first.outputLabel !== second.outputLabel
  ) {
    return false
  }
  return areStringArraysEqual(first.details, second.details)
}

function areMessageOutboxStatesEqual(first: UiMessage['outbox'], second: UiMessage['outbox']): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.lastError === second.lastError
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  return (
    first.id === second.id &&
    first.turnId === second.turnId &&
    first.role === second.role &&
    first.text === second.text &&
    areStringArraysEqual(first.images, second.images) &&
    areMessageSkillsEqual(first.skills, second.skills) &&
    areMessageOutboxStatesEqual(first.outbox, second.outbox) &&
    areMessageToolsEqual(first.tool, second.tool) &&
    first.messageType === second.messageType &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled
  )
}

export function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function isDuplicateAdjacentUserMessage(previous: UiMessage | undefined, next: UiMessage): boolean {
  if (!previous) return false
  return isMatchingUserMessage(previous, next)
}

function isLocalPendingUserMessage(message: UiMessage): boolean {
  return message.role === 'user' && (
    message.messageType === 'userMessage.optimistic' ||
    message.messageType?.startsWith('userMessage.outbox.') === true
  )
}

function isPersistedUserMessage(message: UiMessage): boolean {
  return message.role === 'user' && !isLocalPendingUserMessage(message)
}

function isMatchingUserMessage(first: UiMessage, second: UiMessage): boolean {
  if (first.role !== 'user' || second.role !== 'user') return false
  if (normalizeMessageText(first.text) !== normalizeMessageText(second.text)) return false
  if (!areMessageImagesEqual(first.images, second.images)) return false
  if (!areMessageSkillsEqual(first.skills, second.skills)) return false
  return true
}

function isMatchingTurnUserMessage(first: UiMessage, second: UiMessage): boolean {
  return Boolean(
    first.turnId &&
    second.turnId &&
    first.turnId === second.turnId &&
    isPersistedUserMessage(first) &&
    isPersistedUserMessage(second) &&
    isMatchingUserMessage(first, second),
  )
}

function turnUserIdentity(message: UiMessage): string {
  if (!message.turnId || !isPersistedUserMessage(message)) return ''
  const images = (message.images ?? []).map(normalizeImageIdentity).join('\u0001')
  const skills = (message.skills ?? []).map((skill) => `${skill.name}\u0002${skill.path}`).join('\u0001')
  return `${message.turnId}\u0000${normalizeMessageText(message.text)}\u0000${images}\u0000${skills}`
}

function insertIncomingRowsAtProtocolPosition(base: UiMessage[], rows: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  if (rows.length === 0) return base
  const result = [...base]
  const incomingIndex = new Map(incoming.map((message, index) => [message.id, index]))
  for (const row of rows) {
    const position = incomingIndex.get(row.id) ?? incoming.length
    let insertionIndex = -1
    for (let index = position - 1; index >= 0; index -= 1) {
      const anchor = result.findIndex((message) => message.id === incoming[index]?.id)
      if (anchor >= 0) { insertionIndex = anchor + 1; break }
    }
    if (insertionIndex < 0) {
      for (let index = position + 1; index < incoming.length; index += 1) {
        const anchor = result.findIndex((message) => message.id === incoming[index]?.id)
        if (anchor >= 0) { insertionIndex = anchor; break }
      }
    }
    if (insertionIndex < 0 && row.turnId) {
      const receipt = result.findIndex((message) => message.turnId === row.turnId && message.messageType === WORKED_MESSAGE_TYPE)
      if (receipt >= 0) insertionIndex = receipt
    }
    result.splice(insertionIndex < 0 ? result.length : insertionIndex, 0, row)
  }
  return result
}

export function removeDuplicateAdjacentUserMessages(messages: UiMessage[]): UiMessage[] {
  const next: UiMessage[] = []
  let changed = false

  for (const message of messages) {
    const previous = next.at(-1)
    if (isDuplicateAdjacentUserMessage(previous, message)) {
      changed = true
      if (previous && isLocalPendingUserMessage(previous) && !isLocalPendingUserMessage(message)) {
        next.splice(next.length - 1, 1, message)
      }
      continue
    }
    next.push(message)
  }

  return changed ? next : messages
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

function replaceOptimisticUserMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
): {
  messages: UiMessage[]
  consumedIncomingIds: Set<string>
} {
  const consumedIncomingIds = new Set<string>()
  let changed = false
  const messages = previous.map((previousMessage) => {
    if (!isLocalPendingUserMessage(previousMessage)) return previousMessage

    const replacement = incoming.find((incomingMessage) => {
      if (consumedIncomingIds.has(incomingMessage.id)) return false
      return isPersistedUserMessage(incomingMessage) && isMatchingUserMessage(previousMessage, incomingMessage)
    })
    if (!replacement) return previousMessage

    changed = true
    consumedIncomingIds.add(replacement.id)
    return replacement
  })

  return {
    messages: changed ? messages : previous,
    consumedIncomingIds,
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
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const dedupedIncoming = removeDuplicateMessageIds(incoming)
  const incomingById = new Map(dedupedIncoming.map((message) => [message.id, message]))

  const mergedIncoming = dedupedIncoming.map((incomingMessage) => {
    const previousMessage = previousById.get(incomingMessage.id)
    if (previousMessage && areMessageFieldsEqual(previousMessage, incomingMessage)) {
      return previousMessage
    }
    return incomingMessage
  })

  if (options.preserveMissing !== true) {
    const compacted = removeDuplicateAdjacentUserMessages(coreMergeMessages([], mergedIncoming))
    return areMessageArraysEqual(previous, compacted) ? previous : compacted
  }

  const optimisticReplacements = replaceOptimisticUserMessages(previous, mergedIncoming)

  // Codex history and realtime notifications both expose a parent turnId. An
  // item can occasionally be replayed with a different/transient item id; in
  // that case replace the row in its original turn instead of appending the
  // historical message at the bottom of the conversation.
  const consumedTurnLinkedIncomingIds = new Set<string>()
  const turnLinkedIncoming = new Map<string, UiMessage[]>()
  for (const incomingMessage of mergedIncoming) {
    const key = turnUserIdentity(incomingMessage)
    if (!key) continue
    const matches = turnLinkedIncoming.get(key)
    if (matches) matches.push(incomingMessage)
    else turnLinkedIncoming.set(key, [incomingMessage])
  }

  const mergedFromPrevious = optimisticReplacements.messages.map((previousMessage) => {
    const nextMessage = incomingById.get(previousMessage.id)
    if (nextMessage) {
      if (areMessageFieldsEqual(previousMessage, nextMessage)) {
        return previousMessage
      }
      return nextMessage
    }

    const key = turnUserIdentity(previousMessage)
    const turnLinkedReplacement = (key ? turnLinkedIncoming.get(key) : undefined)
      ?.find((incomingMessage) => !consumedTurnLinkedIncomingIds.has(incomingMessage.id) && isMatchingTurnUserMessage(previousMessage, incomingMessage))
    if (turnLinkedReplacement) {
      consumedTurnLinkedIncomingIds.add(turnLinkedReplacement.id)
      return turnLinkedReplacement
    }
    return previousMessage
  })

  const previousIdSet = new Set(optimisticReplacements.messages.map((message) => message.id))
  let lastTurnBoundaryIndex = -1
  for (let index = optimisticReplacements.messages.length - 1; index >= 0; index -= 1) {
    if (optimisticReplacements.messages[index]?.messageType === WORKED_MESSAGE_TYPE) {
      lastTurnBoundaryIndex = index
      break
    }
  }
  const currentTurnUsers = optimisticReplacements.messages
    .slice(lastTurnBoundaryIndex + 1)
    .filter(isPersistedUserMessage)
  const appended = mergedIncoming.filter((message) => {
    if (
      previousIdSet.has(message.id) ||
      optimisticReplacements.consumedIncomingIds.has(message.id) ||
      consumedTurnLinkedIncomingIds.has(message.id)
    ) return false
    // Silent history refreshes and item/completed notifications can deliver
    // the same user item with different transient ids. Do not append it below
    // an already-streaming assistant response. A Worked receipt is the turn
    // boundary, so intentionally repeating the same prompt on a later turn is
    // still preserved.
    if (isPersistedUserMessage(message) && currentTurnUsers.some((existing) => isMatchingUserMessage(existing, message))) {
      return false
    }
    return true
  })
  const ordered = insertIncomingRowsAtProtocolPosition(mergedFromPrevious, appended, mergedIncoming)
  const merged = removeDuplicateAdjacentUserMessages(removeDuplicateMessageIds(ordered))

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

export function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingAssistantIds = new Set(
    incoming
      .filter((message) => message.role === 'assistant' && message.id.trim().length > 0)
      .map((message) => message.id),
  )
  const incomingAssistantTexts = new Set(
    incoming
      .filter((message) => message.role === 'assistant')
      .map((message) => normalizeMessageText(message.text))
      .filter((text) => text.length > 0),
  )

  if (incomingAssistantIds.size === 0 && incomingAssistantTexts.size === 0) {
    return previous
  }

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live' && message.messageType !== 'plan.live') return true
    if (incomingAssistantIds.has(message.id)) return false
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return !incomingAssistantTexts.has(normalized)
  })

  return next.length === previous.length ? previous : next
}

function removeDuplicateMessageIds(messages: UiMessage[]): UiMessage[] {
  const seenIds = new Set<string>()
  const next: UiMessage[] = []
  let changed = false

  for (const message of messages) {
    if (message.id.trim().length > 0 && seenIds.has(message.id)) {
      changed = true
      continue
    }
    if (message.id.trim().length > 0) {
      seenIds.add(message.id)
    }
    next.push(message)
  }

  return changed ? next : messages
}

function removeSupersededOptimisticUserMessages(messages: UiMessage[]): UiMessage[] {
  const persistedUsers = messages.filter(isPersistedUserMessage)
  if (persistedUsers.length === 0) return messages

  const consumedPersistedIds = new Set<string>()
  const next: UiMessage[] = []
  let changed = false

  for (const message of messages) {
    if (consumedPersistedIds.has(message.id)) {
      changed = true
      continue
    }

    if (!isLocalPendingUserMessage(message)) {
      next.push(message)
      continue
    }

    const replacement = persistedUsers.find((persisted) => {
      if (consumedPersistedIds.has(persisted.id)) return false
      return isMatchingUserMessage(message, persisted)
    })
    if (!replacement) {
      next.push(message)
      continue
    }

    changed = true
    const alreadyDisplayed = next.some((displayed) => isPersistedUserMessage(displayed) && isMatchingUserMessage(displayed, replacement))
    if (!alreadyDisplayed) {
      next.push(replacement)
    }
    consumedPersistedIds.add(replacement.id)
  }

  return changed ? next : messages
}

export function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
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
  if (!delta.messageId || !delta.textDelta) return previous
  const existing = previous.find((message) => message.id === delta.messageId)
  return upsertMessage(previous, {
    id: delta.messageId,
    turnId: delta.turnId || existing?.turnId,
    role: 'assistant',
    text: `${existing?.text ?? ''}${delta.textDelta}`,
    messageType: delta.messageType,
  })
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
  const compacted = removeSupersededOptimisticUserMessages(
    removeDuplicateAdjacentUserMessages(removeDuplicateMessageIds(combined)),
  )

  return turnSummary ? insertTurnSummaryMessage(compacted, turnSummary) : compacted
}

export function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '<1s'
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  const displaySeconds = seconds > 0 || parts.length === 0 ? seconds : 0
  parts.push(`${displaySeconds}s`)
  return parts.join(' ')
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
