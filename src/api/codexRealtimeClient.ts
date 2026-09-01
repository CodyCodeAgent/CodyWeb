import { asRecord } from './protocolValueReaders'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import {
  createReconnectingConversationSocket,
  type ReconnectingSocket,
} from '@codycodeagent/cody-web-core/client'

export type ProductNotification = {
  id: string
  kind: string
  title: string
  summary: string
  severity: 'info' | 'success' | 'warning' | 'danger'
  createdAtIso: string
  threadId: string
  turnId: string
  method: string
}

export type RealtimeConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export type RealtimeConnectionSnapshot = {
  phase: RealtimeConnectionPhase
  reconnectAttempt: number
  connectedAtIso: string
  disconnectedAtIso: string
  closeCode: number | null
  closeReason: string
}

type BridgeWebSocketMessage =
  | {
      type: 'ready'
      atIso?: string
    }
  | {
      type: 'product'
      notification?: unknown
      atIso?: string
    }
  | {
      type: 'conversation'
      event?: unknown
      atIso?: string
    }

type ParsedBridgeWebSocketMessage =
  | {
      type: 'product'
      notification: ProductNotification
    }
  | {
      type: 'conversation'
      event: CodexEvent
    }

type SocketEventMap = {
  open: Event
  message: MessageEvent
  close: CloseEvent
  error: Event
}

type RealtimeSocket = Pick<WebSocket, 'readyState' | 'close' | 'send'> & {
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: (event: SocketEventMap[K]) => void,
  ): void
}

type RealtimeSocketConstructor = {
  new(url: string): RealtimeSocket
  readonly OPEN?: number
  readonly CONNECTING?: number
}

type CodexRealtimeClientOptions = {
  getWindow?: () => Window | undefined
  getWebSocket?: () => RealtimeSocketConstructor | undefined
  nowIso?: () => string
  random?: () => number
}

function initialConnectionSnapshot(): RealtimeConnectionSnapshot {
  return {
    phase: 'idle',
    reconnectAttempt: 0,
    connectedAtIso: '',
    disconnectedAtIso: '',
    closeCode: null,
    closeReason: '',
  }
}

function defaultNowIso(): string {
  return new Date().toISOString()
}

function defaultWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window
}

function defaultWebSocket(): RealtimeSocketConstructor | undefined {
  return typeof WebSocket === 'undefined' ? undefined : WebSocket
}

export function bridgeWebSocketUrl(windowRef: Pick<Window, 'location'>): string {
  const protocol = windowRef.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${windowRef.location.host}/codex-api/ws`
}

export function normalizeProductNotification(
  value: unknown,
  fallbackCreatedAtIso = defaultNowIso(),
): ProductNotification | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.kind !== 'string' || record.kind.length === 0) return null
  if (typeof record.title !== 'string' || record.title.length === 0) return null
  if (typeof record.summary !== 'string') return null
  if (
    record.severity !== 'info' &&
    record.severity !== 'success' &&
    record.severity !== 'warning' &&
    record.severity !== 'danger'
  ) {
    return null
  }

  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    severity: record.severity,
    createdAtIso: typeof record.createdAtIso === 'string' && record.createdAtIso.length > 0
      ? record.createdAtIso
      : fallbackCreatedAtIso,
    threadId: typeof record.threadId === 'string' ? record.threadId : '',
    turnId: typeof record.turnId === 'string' ? record.turnId : '',
    method: typeof record.method === 'string' ? record.method : '',
  }
}

export function parseBridgeWebSocketMessage(
  rawData: MessageEvent['data'],
  nowIso = defaultNowIso,
): ParsedBridgeWebSocketMessage | null {
  try {
    const parsed = JSON.parse(String(rawData)) as BridgeWebSocketMessage
    if (parsed.type === 'product') {
      const notification = normalizeProductNotification(parsed.notification, nowIso())
      return notification ? { type: 'product', notification } : null
    }

    if (parsed.type === 'conversation') {
      const event = parsed.event && typeof parsed.event === 'object' ? parsed.event as Record<string, unknown> : null
      if (
        event && typeof event.id === 'string' && typeof event.type === 'string' &&
        typeof event.threadId === 'string' && typeof event.atIso === 'string' && asRecord(event.data)
      ) {
        return { type: 'conversation', event: event as unknown as CodexEvent }
      }
    }
  } catch {
    return null
  }

  return null
}

export function createCodexRealtimeClient(options: CodexRealtimeClientOptions = {}) {
  const productNotificationListeners = new Set<(value: ProductNotification) => void>()
  const connectionListeners = new Set<(value: RealtimeConnectionSnapshot) => void>()
  const conversationEventListeners = new Set<(value: CodexEvent) => void>()
  const subscribedConversationThreadIds = new Set<string>()
  let bridgeSocket: ReconnectingSocket | null = null
  let connectionSnapshot = initialConnectionSnapshot()
  let hasConnected = false

  const getWindow = options.getWindow ?? defaultWindow
  const getWebSocket = options.getWebSocket ?? defaultWebSocket
  const nowIso = options.nowIso ?? defaultNowIso

  function hasBridgeSocketListeners(): boolean {
    return productNotificationListeners.size > 0 || conversationEventListeners.size > 0 || connectionListeners.size > 0
  }

  function publishConnection(patch: Partial<RealtimeConnectionSnapshot>): void {
    connectionSnapshot = { ...connectionSnapshot, ...patch }
    for (const listener of connectionListeners) listener({ ...connectionSnapshot })
  }

  function closeBridgeSocketIfIdle(): void {
    if (hasBridgeSocketListeners()) return
    bridgeSocket?.close()
    bridgeSocket = null
    hasConnected = false
    connectionSnapshot = initialConnectionSnapshot()
    publishConnection({ phase: 'idle' })
  }

  function handleBridgeSocketMessage(rawData: MessageEvent['data']): void {
    const message = parseBridgeWebSocketMessage(rawData, nowIso)
    if (!message) return

    if (message.type === 'product') {
      for (const listener of productNotificationListeners) listener(message.notification)
      return
    }
    for (const listener of conversationEventListeners) listener(message.event)
  }

  function publishConversationSubscription(): void {
    bridgeSocket?.send(JSON.stringify({
      type: 'conversation.subscribe',
      threadIds: [...subscribedConversationThreadIds],
    }))
  }

  function ensureBridgeSocket(): void {
    const windowRef = getWindow()
    const WebSocketRef = getWebSocket()
    if (!windowRef || !WebSocketRef) return
    if (!hasBridgeSocketListeners()) return

    if (bridgeSocket) return
    publishConnection({
      phase: hasConnected ? 'reconnecting' : 'connecting',
    })
    bridgeSocket = createReconnectingConversationSocket({
      url: bridgeWebSocketUrl(windowRef),
      createSocket: (url) => new WebSocketRef(url) as unknown as WebSocket,
      parse(data) {
        handleBridgeSocketMessage(data as MessageEvent['data'])
        return null
      },
      listener(event) {
        if (event.type === 'event') return
        if (event.type === 'connected') {
          hasConnected = true
          publishConnection({
            phase: 'connected',
            reconnectAttempt: 0,
            connectedAtIso: event.atIso ?? nowIso(),
            closeCode: null,
            closeReason: '',
          })
          publishConversationSubscription()
          return
        }
        publishConnection({
          phase: event.willReconnect === false ? 'disconnected' : 'reconnecting',
          reconnectAttempt: event.reconnectAttempt ?? connectionSnapshot.reconnectAttempt + 1,
          disconnectedAtIso: event.atIso ?? nowIso(),
          closeCode: event.closeCode ?? null,
          closeReason: event.closeReason ?? event.error ?? '',
        })
      },
      ...(options.random ? { random: options.random } : {}),
    })
  }

  function subscribeProductNotifications(onNotification: (value: ProductNotification) => void): () => void {
    if (!getWindow() || !getWebSocket()) {
      return () => {}
    }

    productNotificationListeners.add(onNotification)
    ensureBridgeSocket()

    return () => {
      productNotificationListeners.delete(onNotification)
      closeBridgeSocketIfIdle()
    }
  }

  function subscribeConversationEvents(onEvent: (value: CodexEvent) => void): () => void {
    if (!getWindow() || !getWebSocket()) return () => {}
    conversationEventListeners.add(onEvent)
    ensureBridgeSocket()
    return () => {
      conversationEventListeners.delete(onEvent)
      closeBridgeSocketIfIdle()
    }
  }

  /** The server sends normalized conversation events only for the threads a
   * tab is actively projecting. This keeps a busy tab from flooding every
   * other tab with unrelated tool output. */
  function setConversationThreadSubscriptions(threadIds: readonly string[]): void {
    const next = new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))
    if (next.size === subscribedConversationThreadIds.size && [...next].every((threadId) => subscribedConversationThreadIds.has(threadId))) return
    subscribedConversationThreadIds.clear()
    for (const threadId of next) subscribedConversationThreadIds.add(threadId)
    publishConversationSubscription()
  }

  function subscribeConnection(onConnection: (value: RealtimeConnectionSnapshot) => void): () => void {
    if (!getWindow() || !getWebSocket()) return () => {}
    connectionListeners.add(onConnection)
    onConnection({ ...connectionSnapshot })
    ensureBridgeSocket()
    return () => {
      connectionListeners.delete(onConnection)
      closeBridgeSocketIfIdle()
    }
  }

  function reconnectNow(): void {
    if (!hasBridgeSocketListeners()) return
    const socket = bridgeSocket
    bridgeSocket = null
    socket?.close()
    ensureBridgeSocket()
  }

  return {
    reconnectNow,
    subscribeConversationEvents,
    setConversationThreadSubscriptions,
    subscribeConnection,
    subscribeProductNotifications,
  }
}

const defaultRealtimeClient = createCodexRealtimeClient()

export const subscribeProductNotifications = defaultRealtimeClient.subscribeProductNotifications
export const subscribeConversationEvents = defaultRealtimeClient.subscribeConversationEvents
export const setConversationThreadSubscriptions = defaultRealtimeClient.setConversationThreadSubscriptions
export const subscribeRealtimeConnection = defaultRealtimeClient.subscribeConnection
export const reconnectCodexRealtime = defaultRealtimeClient.reconnectNow
