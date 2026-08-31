import type { UiMessage } from '../types/codex'
import type { LocalMessageOutboxItem } from './localMessageOutbox'

export const UNKNOWN_OUTBOX_DELIVERY_ERROR = '发送状态未知，未自动重发。请确认后手动重试。'

/** Reload never grants authority to send. A command with a bound native Turn
 * remains observable; every other unfinished command requires an explicit
 * user retry so refreshes and multiple tabs cannot duplicate execution. */
export function recoverOutboxItemAfterReload(
  item: LocalMessageOutboxItem,
  updatedAtIso: string,
): LocalMessageOutboxItem {
  if (item.status === 'sending' && item.turnId) return item
  if (item.status !== 'sending' && item.status !== 'queued') return item
  return {
    ...item,
    status: 'failed',
    lastError: UNKNOWN_OUTBOX_DELIVERY_ERROR,
    updatedAtIso,
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function isEquivalent(item: LocalMessageOutboxItem, message: UiMessage): boolean {
  if (message.role !== 'user' || normalizeText(item.text) !== normalizeText(message.text)) return false
  const itemSkills = item.skills.map((skill) => `${skill.name}:${skill.path}`).join('|')
  const messageSkills = (message.skills ?? []).map((skill) => `${skill.name}:${skill.path}`).join('|')
  const itemImages = item.images.map((image) => image.url.trim()).join('|')
  const messageImages = (message.images ?? []).map((image) => image.trim()).join('|')
  return itemSkills === messageSkills && itemImages === messageImages
}

/**
 * Reconciles durable native user items to local commands one-to-one.
 * Optimistic rows never acknowledge themselves, and identical prompts or
 * multiple steer inputs sharing one Turn consume only one occurrence each.
 */
export function selectReconciledOutboxItems(
  items: readonly LocalMessageOutboxItem[],
  transcript: readonly UiMessage[],
): LocalMessageOutboxItem[] {
  const messages = transcript.filter((message) => (
    message.role === 'user' && message.messageType?.startsWith('userMessage.') !== true
  ))
  const remainingItemIds = new Set(items.map((item) => item.id))
  const reconciled: LocalMessageOutboxItem[] = []
  for (const message of messages) {
    const exactId = message.id.startsWith('user:') ? message.id.slice('user:'.length) : ''
    const exact = exactId
      ? items.find((item) => remainingItemIds.has(item.id) && item.id === exactId)
      : undefined
    const sameTurn = exact ?? items.find((item) => (
      remainingItemIds.has(item.id)
      && Boolean(item.turnId)
      && item.turnId === message.turnId
      && isEquivalent(item, message)
    ))
    if (!sameTurn) continue
    remainingItemIds.delete(sameTurn.id)
    reconciled.push(sameTurn)
  }
  return reconciled
}
