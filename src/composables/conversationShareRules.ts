import type { UiConversationShareMessage, UiMessage } from '../types/codex'

export type ConversationShareTurn = {
  id: string
  turnId: string
  messages: UiMessage[]
  userPreview: string
  assistantPreview: string
  imageCount: number
  hasToolDetails: boolean
}

const MAX_PREVIEW_LENGTH = 180

function compactPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= MAX_PREVIEW_LENGTH) return normalized
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`
}

function isTurnReceipt(message: UiMessage): boolean {
  return message.messageType === 'worked' || message.tool?.kind === 'context'
}

export function isConversationShareCandidate(message: UiMessage): boolean {
  if (isTurnReceipt(message)) return false
  if (message.role === 'system' && !message.tool) return false
  return message.text.trim().length > 0
    || (message.images?.length ?? 0) > 0
    || Boolean(message.tool)
}

export function buildConversationShareTurns(messages: UiMessage[]): ConversationShareTurn[] {
  const groups: ConversationShareTurn[] = []
  const byId = new Map<string, ConversationShareTurn>()
  let fallbackTurnId = ''

  for (const message of messages) {
    if (!isConversationShareCandidate(message)) continue
    if (!message.turnId && message.role === 'user') fallbackTurnId = `message:${message.id}`
    const turnId = message.turnId?.trim() || fallbackTurnId || `message:${message.id}`
    let group = byId.get(turnId)
    if (!group) {
      group = {
        id: turnId,
        turnId,
        messages: [],
        userPreview: '',
        assistantPreview: '',
        imageCount: 0,
        hasToolDetails: false,
      }
      byId.set(turnId, group)
      groups.push(group)
    }
    group.messages.push(message)
    group.imageCount += message.images?.length ?? 0
    group.hasToolDetails ||= Boolean(message.tool)
    if (!group.userPreview && message.role === 'user' && message.text.trim()) {
      group.userPreview = compactPreview(message.text)
    }
    if (!group.assistantPreview && message.role === 'assistant' && message.text.trim()) {
      group.assistantPreview = compactPreview(message.text)
    }
  }

  return groups.filter((group) => group.userPreview || group.assistantPreview || group.imageCount > 0)
}

export function buildConversationShareMessages(
  turns: ConversationShareTurn[],
  selectedTurnIds: Set<string>,
  includeToolDetails: boolean,
): UiConversationShareMessage[] {
  return turns.flatMap((turn) => {
    if (!selectedTurnIds.has(turn.id)) return []
    return turn.messages.flatMap((message) => {
      if (message.tool && !includeToolDetails && message.text.trim().length === 0) return []
      if (message.role === 'system' && !includeToolDetails) return []
      return [{
        id: message.id,
        turnId: turn.turnId,
        role: message.role,
        text: message.text,
        messageType: message.messageType ?? '',
        imageCount: message.images?.length ?? 0,
        tool: includeToolDetails && message.tool ? {
          ...message.tool,
          details: [...message.tool.details],
        } : null,
      }]
    })
  })
}
