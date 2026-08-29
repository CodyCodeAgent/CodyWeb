import { asRecord } from '../api/protocolValueReaders'
import type {
  ThreadScrollState,
  UiLiveOverlay,
  UiMessage,
  UiServerRequest,
  UiServerRequestReply,
  UiToolTimelineEntry,
} from '../types/codex'
import { formatToolStatus } from '@codycodeagent/cody-web-core/presentation'
import {
  buildServerRequestCards,
  isServerApprovalRequestKind,
  serverRequestActionKeyPrefix,
  serverRequestKind,
  type UiServerRequestCard,
  type UiServerRequestKind,
} from './serverRequestRules'

export {
  buildApprovalDecisionReply,
  buildApprovalScopeReply,
  buildEmptyServerRequestReply,
  buildRejectedServerRequestReply,
} from './serverRequestRules'

export type ParsedToolQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  options: string[]
}

export type ConversationScrollMetrics = {
  maxScrollTop: number
  scrollRatio: number
  isAtBottom: boolean
}

export type ConversationRequestKind = UiServerRequestKind

export type ConversationRequestCard = UiServerRequestCard

export const DEFAULT_VISIBLE_MESSAGE_COUNT = 80
export const MESSAGE_HISTORY_PAGE_SIZE = 80

export function normalizedVisibleMessageCount(messageCount: number, requestedCount: number): number {
  const normalizedMessageCount = Math.max(Math.trunc(messageCount), 0)
  const normalizedRequestedCount = Math.max(Math.trunc(requestedCount), DEFAULT_VISIBLE_MESSAGE_COUNT)
  return Math.min(normalizedRequestedCount, normalizedMessageCount)
}

export function visibleMessageStartIndex(messageCount: number, visibleCount: number): number {
  return Math.max(Math.trunc(messageCount) - Math.max(Math.trunc(visibleCount), 0), 0)
}

export function hiddenMessageCount(messageCount: number, visibleCount: number): number {
  return visibleMessageStartIndex(messageCount, visibleCount)
}

export function nextVisibleMessageCount(messageCount: number, visibleCount: number, pageSize = MESSAGE_HISTORY_PAGE_SIZE): number {
  const nextCount = Math.max(Math.trunc(visibleCount), 0) + Math.max(Math.trunc(pageSize), 1)
  return normalizedVisibleMessageCount(messageCount, nextCount)
}

export function visibleMessageWindowSummary(messageCount: number, visibleCount: number): string {
  const normalizedMessageCount = Math.max(Math.trunc(messageCount), 0)
  if (normalizedMessageCount <= 0) return 'No messages'

  const normalizedVisibleCount = normalizedVisibleMessageCount(normalizedMessageCount, visibleCount)
  const start = visibleMessageStartIndex(normalizedMessageCount, normalizedVisibleCount) + 1
  return `Showing messages ${start}-${normalizedMessageCount} of ${normalizedMessageCount}`
}

export function historyPageButtonLabel(hiddenCount: number, pageSize = MESSAGE_HISTORY_PAGE_SIZE): string {
  const normalizedHiddenCount = Math.max(Math.trunc(hiddenCount), 0)
  if (normalizedHiddenCount <= 0) return 'No earlier messages'
  const count = Math.min(Math.max(Math.trunc(pageSize), 1), normalizedHiddenCount)
  return `Show ${count} earlier message${count === 1 ? '' : 's'}`
}

export function shouldShowBlockingConversationLoading(input: {
  isLoading: boolean
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
}): boolean {
  if (!input.isLoading) return false
  return input.messageCount <= 0 && input.pendingRequestCount <= 0 && !input.hasLiveOverlay
}

export function shouldShowConversationRefreshStatus(input: {
  isLoading: boolean
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
}): boolean {
  if (!input.isLoading) return false
  return !shouldShowBlockingConversationLoading(input)
}

export function hasConversationContent(input: {
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
}): boolean {
  return input.messageCount > 0 || input.pendingRequestCount > 0 || input.hasLiveOverlay
}

export function shouldShowBlockingConversationLoadError(input: {
  isLoading: boolean
  loadError: string
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
}): boolean {
  if (input.isLoading || input.loadError.trim().length <= 0) return false
  return !hasConversationContent(input)
}

export function shouldShowInlineConversationLoadError(input: {
  isLoading: boolean
  loadError: string
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
}): boolean {
  if (input.isLoading || input.loadError.trim().length <= 0) return false
  return hasConversationContent(input)
}

export function buildToolCopyText(tool: UiToolTimelineEntry): string {
  const parts = [`${tool.title}: ${tool.summary}`]
  if (tool.status.trim().length > 0) {
    parts.push(`Status: ${formatToolStatus(tool.status)}`)
  }
  if (tool.details.length > 0) {
    parts.push(tool.details.join('\n'))
  }
  if (tool.output?.trim()) {
    parts.push(`${tool.outputLabel || 'Output'}:\n${tool.output.trim()}`)
  }
  return parts.join('\n')
}

export function buildCopyText(message: UiMessage): string {
  const parts: string[] = []
  if (message.tool) {
    parts.push(buildToolCopyText(message.tool))
  }

  const text = message.text.trim()
  if (text.length > 0) {
    parts.push(text)
  }

  const skills = message.skills?.filter((skill) => skill.name.trim().length > 0) ?? []
  if (skills.length > 0) {
    parts.push(skills.map((skill) => `$${skill.name}`).join('\n'))
  }

  const images = message.images?.filter((imageUrl) => imageUrl.trim().length > 0) ?? []
  if (images.length > 0) {
    parts.push(images.join('\n'))
  }

  return parts.join('\n\n')
}

export function isCopyableMessage(message: UiMessage): boolean {
  if (message.messageType === 'worked') return false
  return buildCopyText(message).length > 0
}

export function isAssistantResponseMessage(message: UiMessage): boolean {
  return message.role !== 'user' && isCopyableMessage(message)
}

export function findNextCopyableMessageIndex(messages: UiMessage[], startIndex: number): number {
  for (let index = startIndex; index < messages.length; index += 1) {
    if (isCopyableMessage(messages[index])) {
      return index
    }
  }
  return -1
}

export function shouldShowCopyButton(messages: UiMessage[], message: UiMessage, messageIndex: number): boolean {
  if (!isCopyableMessage(message)) return false
  if (message.role === 'user') return true

  const nextCopyableIndex = findNextCopyableMessageIndex(messages, messageIndex + 1)
  if (nextCopyableIndex === -1) return true
  return !isAssistantResponseMessage(messages[nextCopyableIndex])
}

export function messageCopyAriaLabel(isCopied: boolean): string {
  return isCopied ? 'Copied message' : 'Copy message'
}

export function messageCopyTitle(isCopied: boolean): string {
  return isCopied ? 'Copied' : 'Copy message'
}

export function buildCopyTextAt(messages: UiMessage[], message: UiMessage, messageIndex: number): string {
  if (message.role === 'user') return buildCopyText(message)

  const parts: string[] = []
  let startIndex = messageIndex
  while (startIndex > 0 && isAssistantResponseMessage(messages[startIndex - 1])) {
    startIndex -= 1
  }

  for (let index = startIndex; index <= messageIndex; index += 1) {
    const currentMessage = messages[index]
    if (!isAssistantResponseMessage(currentMessage)) continue

    const text = buildCopyText(currentMessage)
    if (text.length > 0) {
      parts.push(text)
    }
  }

  return parts.join('\n\n')
}

export function hasLiveOverlayDetails(liveOverlay: UiLiveOverlay | null): boolean {
  if (!liveOverlay) return false
  return liveOverlay.activityDetails.length > 0 || liveOverlay.reasoningText.trim().length > 0
}

export function liveOverlayDetailsToggleLabel(isExpanded: boolean): string {
  return isExpanded ? 'Hide details' : 'Show details'
}

export function shouldShowScrollToBottomButton(params: {
  activeThreadId: string
  isLoading: boolean
  messageCount: number
  pendingRequestCount: number
  hasLiveOverlay: boolean
  scrollState: ThreadScrollState | null
}): boolean {
  if (!params.activeThreadId || params.isLoading) return false
  if (params.messageCount === 0 && params.pendingRequestCount === 0 && !params.hasLiveOverlay) return false
  return params.scrollState?.isAtBottom === false
}

export function conversationRequestKind(method: string): ConversationRequestKind {
  return serverRequestKind(method)
}

export function isConversationApprovalRequestKind(kind: ConversationRequestKind): boolean {
  return isServerApprovalRequestKind(kind)
}

export function conversationRequestActionKeyPrefix(kind: ConversationRequestKind): string {
  return serverRequestActionKeyPrefix(kind)
}

export function buildConversationRequestCards(requests: UiServerRequest[]): ConversationRequestCard[] {
  return buildServerRequestCards(requests)
}

export function buildConversationScrollMetrics(params: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  bottomThresholdPx: number
}): ConversationScrollMetrics {
  const maxScrollTop = Math.max(params.scrollHeight - params.clientHeight, 0)
  const scrollRatio = maxScrollTop > 0
    ? Math.min(Math.max(params.scrollTop / maxScrollTop, 0), 1)
    : 1
  const distanceFromBottom = params.scrollHeight - (params.scrollTop + params.clientHeight)
  return {
    maxScrollTop,
    scrollRatio,
    isAtBottom: distanceFromBottom <= params.bottomThresholdPx,
  }
}

export function restoredConversationScrollTop(
  savedState: ThreadScrollState,
  maxScrollTop: number,
): number {
  const targetScrollTop =
    typeof savedState.scrollRatio === 'number'
      ? savedState.scrollRatio * maxScrollTop
      : savedState.scrollTop
  return Math.min(Math.max(targetScrollTop, 0), maxScrollTop)
}

export function preservedConversationScrollTop(
  savedState: ThreadScrollState,
  maxScrollTop: number,
): number {
  return Math.min(Math.max(savedState.scrollTop, 0), maxScrollTop)
}

export function buildConversationScrollState(params: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  bottomThresholdPx: number
}): ThreadScrollState {
  const metrics = buildConversationScrollMetrics(params)
  return {
    scrollTop: params.scrollTop,
    isAtBottom: metrics.isAtBottom,
    scrollRatio: metrics.scrollRatio,
  }
}

export function shouldRestoreConversationToBottom(scrollState: ThreadScrollState | null): boolean {
  return !scrollState || scrollState.isAtBottom === true
}

export function shouldPreserveConversationViewport(scrollState: ThreadScrollState | null): scrollState is ThreadScrollState {
  return scrollState?.isAtBottom === false
}

export function normalizedConversationBottomLockFrames(frames: number): number {
  return Math.max(Math.trunc(frames), 1)
}

export function shouldLockConversationToBottom(scrollState: ThreadScrollState | null): boolean {
  return shouldRestoreConversationToBottom(scrollState)
}

export function toolQuestionKey(requestId: number, questionId: string): string {
  return `${String(requestId)}:${questionId}`
}

export function readToolQuestions(request: UiServerRequest): ParsedToolQuestion[] {
  const params = asRecord(request.params)
  const questions = Array.isArray(params?.questions) ? params.questions : []
  const parsed: ParsedToolQuestion[] = []

  for (const row of questions) {
    const question = asRecord(row)
    if (!question) continue
    const id = typeof question.id === 'string' ? question.id : ''
    if (!id) continue

    const options = Array.isArray(question.options)
      ? question.options
        .map((option) => asRecord(option))
        .map((option) => option?.label)
        .filter((option): option is string => typeof option === 'string' && option.length > 0)
      : []

    parsed.push({
      id,
      header: typeof question.header === 'string' ? question.header : '',
      question: typeof question.question === 'string' ? question.question : '',
      isOther: question.isOther === true,
      options,
    })
  }

  return parsed
}

export function toolQuestionTitle(question: Pick<ParsedToolQuestion, 'header' | 'question'>): string {
  return question.header || question.question
}

export function shouldShowToolQuestionText(question: Pick<ParsedToolQuestion, 'header' | 'question'>): boolean {
  return question.header.length > 0 && question.question.length > 0
}

export function readToolQuestionAnswer(
  answersByKey: Record<string, string>,
  requestId: number,
  questionId: string,
  fallback: string,
): string {
  const saved = answersByKey[toolQuestionKey(requestId, questionId)]
  return typeof saved === 'string' && saved.length > 0 ? saved : fallback
}

export function readToolQuestionOtherAnswer(
  answersByKey: Record<string, string>,
  requestId: number,
  questionId: string,
): string {
  return answersByKey[toolQuestionKey(requestId, questionId)] ?? ''
}

export function buildToolUserInputReply(params: {
  request: UiServerRequest
  answersByKey: Record<string, string>
  otherAnswersByKey: Record<string, string>
}): UiServerRequestReply {
  const answers: Record<string, { answers: string[] }> = {}

  for (const question of readToolQuestions(params.request)) {
    const selected = readToolQuestionAnswer(
      params.answersByKey,
      params.request.id,
      question.id,
      question.options[0] || '',
    )
    const other = readToolQuestionOtherAnswer(params.otherAnswersByKey, params.request.id, question.id).trim()
    const values = [selected, other].map((value) => value.trim()).filter((value) => value.length > 0)
    answers[question.id] = { answers: values }
  }

  return {
    id: params.request.id,
    result: { answers },
  }
}

export function buildToolCallFailureReply(requestId: number): UiServerRequestReply {
  return {
    id: requestId,
    result: {
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: 'Tool call rejected from CodyWeb UI.',
        },
      ],
    },
  }
}

export function buildToolCallSuccessReply(requestId: number): UiServerRequestReply {
  return {
    id: requestId,
    result: {
      success: true,
      contentItems: [],
    },
  }
}
