import { computed, ref } from 'vue'
import { latestTerminalTurnEvent } from '@codycodeagent/cody-web-core/conversation'
import { readThreadId as readCoreThreadId, readTurnId as readCoreTurnId } from '@codycodeagent/cody-web-core/protocol'
import { normalizeCodexNotification } from '@codycodeagent/cody-web-core/session'
import {
  subscribeProductNotifications,
  subscribeRpcNotifications,
  type ProductNotification,
  type RpcNotification,
} from '../api/codexRealtimeClient'
import { asRecord, readNumber, readString as readProtocolString } from '../api/protocolValueReaders'

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

function readString(value: unknown): string {
  return readProtocolString(value).trim()
}

function readNestedString(value: unknown, keys: string[]): string {
  let cursor: unknown = value
  for (const key of keys) {
    const record = asRecord(cursor)
    if (!record) return ''
    cursor = record[key]
  }
  return readString(cursor)
}

function notificationThreadId(params: unknown): string {
  return readCoreThreadId(params) || readNestedString(params, ['params', 'threadId'])
}

function notificationTurnId(params: unknown): string {
  return readCoreTurnId(params) || readNestedString(params, ['params', 'turnId'])
}

function readServerRequestMethod(params: unknown): string {
  return (
    readNestedString(params, ['method']) ||
    readNestedString(params, ['request', 'method']) ||
    readNestedString(params, ['params', 'method'])
  )
}

function readMaxRateLimitPercent(params: unknown): number | null {
  const root = asRecord(params)
  if (!root) return null

  const candidates: unknown[] = []
  const directSnapshot = asRecord(root.rateLimits)
  if (directSnapshot) {
    candidates.push(asRecord(directSnapshot.primary), asRecord(directSnapshot.secondary))
  }

  const codexSnapshot = asRecord(asRecord(root.rateLimitsByLimitId)?.codex)
  if (codexSnapshot) {
    candidates.push(asRecord(codexSnapshot.primary), asRecord(codexSnapshot.secondary))
  }

  const percents = candidates
    .map((candidate) => readNumber(asRecord(candidate)?.usedPercent))
    .filter((percent): percent is number => percent !== null)

  return percents.length > 0 ? Math.max(...percents) : null
}

function buildSourceId(notification: RpcNotification): string {
  const params = notification.params
  const threadId = notificationThreadId(params)
  const turnId = notificationTurnId(params)
  return [notification.method, threadId, turnId, notification.atIso]
    .filter(Boolean)
    .join(':')
}

export function notificationFromRpcNotification(notification: RpcNotification): BrowserNotificationEvent | null {
  const params = notification.params
  const sourceId = buildSourceId(notification)
  const events = normalizeCodexNotification(notification)
  const threadId = events[0]?.threadId || notificationThreadId(params)
  const turnId = events.find((event) => event.turnId)?.turnId || notificationTurnId(params)
  const terminal = latestTerminalTurnEvent(events)
  const scope = threadId ? `Thread ${threadId}` : 'Codex'

  if (notification.method === 'server/request') {
    const requestMethod = readServerRequestMethod(params)
    return {
      id: `notify:${sourceId}`,
      kind: 'approval',
      title: 'Approval required',
      body: requestMethod ? `${requestMethod} is waiting for your decision.` : 'Codex is waiting for your decision.',
      severity: 'warning',
      createdAtIso: notification.atIso,
      sourceId,
    }
  }

  if (terminal) {
    if (terminal.type === 'turn.failed') {
      return {
        id: `notify:${sourceId}`,
        kind: 'turn-failed',
        title: 'Task failed',
        body: readString(terminal.data.error) || 'Codex failed to complete the task.',
        severity: 'danger',
        createdAtIso: notification.atIso,
        sourceId,
      }
    }

    if (terminal.type === 'turn.interrupted') {
      return {
        id: `notify:${sourceId}`,
        kind: 'turn-failed',
        title: 'Task interrupted',
        body: turnId ? `${scope} stopped turn ${turnId}.` : `${scope} stopped a turn.`,
        severity: 'warning',
        createdAtIso: notification.atIso,
        sourceId,
      }
    }

    return {
      id: `notify:${sourceId}`,
      kind: 'turn-completed',
      title: 'Task completed',
      body: turnId ? `${scope} finished turn ${turnId}.` : `${scope} finished a turn.`,
      severity: 'success',
      createdAtIso: notification.atIso,
      sourceId,
    }
  }

  if (notification.method === 'account/rateLimits/updated') {
    const maxPercent = readMaxRateLimitPercent(params)
    if (maxPercent === null || maxPercent < 90) return null

    return {
      id: `notify:${sourceId}`,
      kind: 'rate-limit',
      title: 'Rate limit is high',
      body: `Codex usage is at ${Math.round(maxPercent)}%.`,
      severity: 'warning',
      createdAtIso: notification.atIso,
      sourceId,
    }
  }

  if (events.some((event) => event.type === 'thread.compacted')) {
    return {
      id: `notify:${sourceId}`,
      kind: 'thread-compacted',
      title: 'Thread compacted',
      body: threadId ? `Thread ${threadId} was compacted.` : 'A thread was compacted.',
      severity: 'info',
      createdAtIso: notification.atIso,
      sourceId,
    }
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
  let stopCodexStream: (() => void) | null = null
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

  function notifyRpcEvent(notification: RpcNotification): void {
    const event = notificationFromRpcNotification(notification)
    if (event) {
      recordEvent(event)
    }
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
    if (!stopCodexStream) {
      stopCodexStream = subscribeRpcNotifications(notifyRpcEvent)
    }
    if (!stopProductStream) {
      stopProductStream = subscribeProductNotifications(notifyProductEvent)
    }
  }

  function stop(): void {
    stopCodexStream?.()
    stopProductStream?.()
    stopCodexStream = null
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
    notifyRpcEvent,
    notifyProductEvent,
    clearEvents,
    start,
    stop,
  }
}
