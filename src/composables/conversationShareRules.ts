import type { UiConversationShareMessage, UiConversationShareThemeSnapshot, UiMessage } from '../types/codex'
import type { ResolvedSkinPack, ThemeTokens } from '../theme/tokens'

export type ConversationShareItem = {
  id: string
  turnId: string
  message: UiMessage
  preview: string
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

export function buildConversationShareItems(messages: UiMessage[]): ConversationShareItem[] {
  const items: ConversationShareItem[] = []
  let fallbackTurnId = ''

  for (const message of messages) {
    if (!isConversationShareCandidate(message)) continue
    if (!message.turnId && message.role === 'user') fallbackTurnId = `message:${message.id}`
    const turnId = message.turnId?.trim() || fallbackTurnId || `message:${message.id}`
    items.push({
      id: message.id,
      turnId,
      message,
      preview: compactPreview(message.text || message.tool?.summary || message.tool?.title || ''),
      imageCount: message.images?.length ?? 0,
      hasToolDetails: Boolean(message.tool),
    })
  }

  return items
}

export function buildConversationShareMessages(
  items: ConversationShareItem[],
  selectedMessageIds: Set<string>,
  includeToolDetails: boolean,
): UiConversationShareMessage[] {
  return items.flatMap((item) => {
    if (!selectedMessageIds.has(item.id)) return []
    const message = item.message
    if (message.tool && !includeToolDetails && message.text.trim().length === 0) return []
    if (message.role === 'system' && !includeToolDetails) return []
    return [{
      id: message.id,
      turnId: item.turnId,
      role: message.role,
      text: message.text,
      messageType: message.messageType ?? '',
      imageCount: message.images?.length ?? 0,
      images: [...(message.images ?? [])],
      tool: includeToolDetails && message.tool ? {
        ...message.tool,
        details: [...message.tool.details],
      } : null,
    }]
  })
}

export function captureConversationShareTheme(
  skin: ResolvedSkinPack,
  tokens: ThemeTokens,
): UiConversationShareThemeSnapshot {
  return {
    skinId: skin.id,
    skinName: skin.name,
    colorMode: skin.colorMode,
    colors: {
      background: tokens.color.background,
      surface: tokens.color.surface,
      panel: tokens.color.panel,
      elevated: tokens.color.elevated,
      text: tokens.color.text,
      textMuted: tokens.color.textMuted,
      border: tokens.color.border,
      accent: tokens.color.accent,
      codeBackground: tokens.color.codeBackground,
    },
    fonts: { sans: tokens.font.sans, mono: tokens.font.mono },
    radii: { sm: tokens.radius.sm, md: tokens.radius.md, lg: tokens.radius.lg },
    recipes: {
      message: skin.recipes.message,
      identity: skin.recipes.identity,
      panel: skin.recipes.panel,
      backdrop: skin.recipes.backdrop,
    },
    background: skin.background ? {
      type: skin.background.type,
      fit: skin.background.fit ?? 'cover',
      position: skin.background.position ?? 'center',
      blur: skin.background.blur ?? 0,
      dim: skin.background.dim ?? 30,
      saturation: skin.background.saturation ?? 100,
    } : null,
    assets: {
      ...(skin.assets?.background ? { background: skin.assets.background } : {}),
      ...(skin.assets?.assistantAvatar ? { assistantAvatar: skin.assets.assistantAvatar } : {}),
      ...(skin.assets?.userAvatar ? { userAvatar: skin.assets.userAvatar } : {}),
    },
  }
}
