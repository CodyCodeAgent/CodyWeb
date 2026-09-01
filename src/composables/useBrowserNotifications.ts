import { computed, ref } from 'vue'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import {
  subscribeConversationEvents,
  subscribeProductNotifications,
  type ProductNotification,
} from '../api/codexRealtimeClient'

export type BrowserNotificationPreference = 'off' | 'important' | 'all'
export type BrowserNotificationPermission = NotificationPermission | 'unsupported'
export type BrowserNotificationSeverity = 'info' | 'success' | 'warning' | 'danger'

export type BrowserNotificationEvent = {
  id: string
  kind:
    | 'approval'
    | 'turn-completed'
    | 'turn-failed'
    | 'rate-limit'
    | 'thread-compacted'
    | 'workflow'
    | 'ready-for-review'
    | 'command-failed'
    | 'test-failed'
    | 'generic'
  title: string
  body: string
  severity: BrowserNotificationSeverity
  createdAtIso: string
  sourceId: string
}

const PREFERENCE_STORAGE_KEY = 'cody-web-ui.browser-notifications.v1'
const MAX_EVENTS = 30


export function notificationFromConversationEvent(event: CodexEvent): BrowserNotificationEvent | null {
  const turnId = event.turnId ?? ''
  const scope = event.threadId ? `Thread ${event.threadId}` : 'Codex'
  const sourceId = event.id
  if (event.type === 'approval.requested' || event.type === 'question.requested') {
    const method = typeof event.data.method === 'string' ? event.data.method : ''
    return {
      id: `conversation:${sourceId}`,
      kind: 'approval',
      title: event.type === 'approval.requested' ? 'Approval required' : 'Answer required',
      body: method ? `${method} is waiting for your decision.` : 'Codex is waiting for your decision.',
      severity: 'warning', createdAtIso: event.atIso, sourceId,
    }
  }
  if (event.type === 'turn.failed') return {
    id: `conversation:${sourceId}`, kind: 'turn-failed', title: 'Task failed',
    body: typeof event.data.error === 'string' ? event.data.error : 'Codex failed to complete the task.',
    severity: 'danger', createdAtIso: event.atIso, sourceId,
  }
  if (event.type === 'turn.interrupted') return {
    id: `conversation:${sourceId}`, kind: 'turn-failed', title: 'Task interrupted',
    body: turnId ? `${scope} stopped turn ${turnId}.` : `${scope} stopped a turn.`,
    severity: 'warning', createdAtIso: event.atIso, sourceId,
  }
  if (event.type === 'turn.completed') return {
    id: `conversation:${sourceId}`, kind: 'turn-completed', title: 'Task completed',
    body: turnId ? `${scope} finished turn ${turnId}.` : `${scope} finished a turn.`,
    severity: 'success', createdAtIso: event.atIso, sourceId,
  }
  if (event.type === 'thread.compacted') return {
    id: `conversation:${sourceId}`, kind: 'thread-compacted', title: 'Thread compacted',
    body: event.threadId ? `Thread ${event.threadId} was compacted.` : 'A thread was compacted.',
    severity: 'info', createdAtIso: event.atIso, sourceId,
  }
  return null
}

function browserKindFromProductKind(kind: string): BrowserNotificationEvent['kind'] {
  if (kind === 'ready_for_review') return 'ready-for-review'
  if (kind === 'command_failed') return 'command-failed'
  if (kind === 'test_failed') return 'test-failed'
  if (kind.startsWith('task_') || kind === 'user_input_required') return 'workflow'
  return 'generic'
}

export function notificationFromProductNotification(notification: ProductNotification): BrowserNotificationEvent | null {
  if (!notification.id || !notification.kind || !notification.title) return null
  return {
    id: `product:${notification.id}`,
    kind: browserKindFromProductKind(notification.kind),
    title: notification.title,
    body: notification.summary,
    severity: notification.severity,
    createdAtIso: notification.createdAtIso,
    sourceId: notification.id,
  }
}

export function shouldSendBrowserNotification(
  event: BrowserNotificationEvent,
  preference: BrowserNotificationPreference,
): boolean {
  if (preference === 'off') return false
  if (preference === 'all') return true
  return event.severity === 'warning' || event.severity === 'danger' || event.kind === 'approval'
}

function loadPreference(): BrowserNotificationPreference {
  if (typeof window === 'undefined') return 'important'

  const raw = window.localStorage.getItem(PREFERENCE_STORAGE_KEY)
  return raw === 'off' || raw === 'important' || raw === 'all' ? raw : 'important'
}

function readPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission
}

function eventNotificationOptions(event: BrowserNotificationEvent): NotificationOptions {
  return {
    body: event.body,
    tag: event.sourceId,
    silent: event.severity === 'success' || event.severity === 'info',
  }
}

export function useBrowserNotifications() {
  const preference = ref<BrowserNotificationPreference>(loadPreference())
  const permission = ref<BrowserNotificationPermission>(readPermission())
  const events = ref<BrowserNotificationEvent[]>([])
  const lastError = ref('')
  const isSupported = computed(() => permission.value !== 'unsupported')
  const unreadCount = computed(() => events.value.filter((event) => event.severity !== 'info').length)
  let stopConversationStream: (() => void) | null = null
  let stopProductStream: (() => void) | null = null

  function setPreference(nextPreference: BrowserNotificationPreference): void {
    preference.value = nextPreference
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREFERENCE_STORAGE_KEY, nextPreference)
    }
  }

  async function requestPermission(): Promise<void> {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      permission.value = 'unsupported'
      return
    }

    try {
      permission.value = await window.Notification.requestPermission()
    } catch (error) {
      permission.value = window.Notification.permission
      lastError.value = error instanceof Error ? error.message : 'Unable to request notification permission.'
    }
  }

  function sendNativeNotification(event: BrowserNotificationEvent): void {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return
    if (window.Notification.permission !== 'granted') return
    if (!shouldSendBrowserNotification(event, preference.value)) return

    try {
      new window.Notification(event.title, eventNotificationOptions(event))
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Unable to show browser notification.'
    }
  }

  function recordEvent(event: BrowserNotificationEvent): void {
    events.value = [
      event,
      ...events.value.filter((existing) => existing.id !== event.id),
    ].slice(0, MAX_EVENTS)
    sendNativeNotification(event)
  }

  function notifyConversationEvent(event: CodexEvent): void {
    const notification = notificationFromConversationEvent(event)
    if (notification) recordEvent(notification)
  }

  function notifyProductEvent(notification: ProductNotification): void {
    const event = notificationFromProductNotification(notification)
    if (event) {
      recordEvent(event)
    }
  }

  function clearEvents(): void {
    events.value = []
  }

  function start(): void {
    if (!stopConversationStream) {
      stopConversationStream = subscribeConversationEvents(notifyConversationEvent)
    }
    if (!stopProductStream) {
      stopProductStream = subscribeProductNotifications(notifyProductEvent)
    }
  }

  function stop(): void {
    stopConversationStream?.()
    stopProductStream?.()
    stopConversationStream = null
    stopProductStream = null
  }

  return {
    preference,
    permission,
    events,
    lastError,
    isSupported,
    unreadCount,
    setPreference,
    requestPermission,
    notifyConversationEvent,
    notifyProductEvent,
    clearEvents,
    start,
    stop,
  }
}
