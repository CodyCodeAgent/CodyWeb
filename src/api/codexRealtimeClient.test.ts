import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeWebSocketUrl,
  createCodexRealtimeClient,
  parseBridgeWebSocketMessage,
} from './codexRealtimeClient'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readonly listeners = new Map<string, Array<(event: any) => void>>()
  readyState = FakeWebSocket.CONNECTING
  closeCount = 0
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closeCount += 1
    this.readyState = 3
  }

  send(value: string): void { this.sent.push(value) }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function fakeWindow(protocol = 'http:', host = 'localhost:5173'): Window {
  return {
    location: { protocol, host },
    setTimeout: (() => 1) as Window['setTimeout'],
    clearTimeout: (() => undefined) as Window['clearTimeout'],
  } as unknown as Window
}

afterEach(() => vi.useRealTimers())

describe('codex realtime client', () => {
  it('builds websocket URLs from the current page origin', () => {
    expect(bridgeWebSocketUrl(fakeWindow('http:', '127.0.0.1:5173'))).toBe('ws://127.0.0.1:5173/codex-api/ws')
    expect(bridgeWebSocketUrl(fakeWindow('https:', 'codex.example.com'))).toBe('wss://codex.example.com/codex-api/ws')
  })

  it('parses rpc websocket frames and ignores malformed payloads', () => {
    expect(parseBridgeWebSocketMessage(JSON.stringify({
      type: 'rpc',
      atIso: '2026-07-07T01:00:00.000Z',
      notification: {
        method: 'item/agentMessage/delta',
        params: { delta: 'hello' },
      },
    }), () => 'fallback')).toEqual({
      type: 'rpc',
      notification: {
        method: 'item/agentMessage/delta',
        params: { delta: 'hello' },
        atIso: '2026-07-07T01:00:00.000Z',
      },
    })

    expect(parseBridgeWebSocketMessage('{', () => 'fallback')).toBeNull()
    expect(parseBridgeWebSocketMessage(JSON.stringify({ type: 'ready' }), () => 'fallback')).toBeNull()
  })

  it('parses product websocket frames with safe defaults', () => {
    expect(parseBridgeWebSocketMessage(JSON.stringify({
      type: 'product',
      notification: {
        id: 'n-1',
        kind: 'workflow',
        title: 'Workflow finished',
        summary: '',
        severity: 'success',
      },
    }), () => '2026-07-07T02:00:00.000Z')).toEqual({
      type: 'product',
      notification: {
        id: 'n-1',
        kind: 'workflow',
        title: 'Workflow finished',
        summary: '',
        severity: 'success',
        createdAtIso: '2026-07-07T02:00:00.000Z',
        threadId: '',
        turnId: '',
        method: '',
      },
    })
  })

  it('shares one websocket for rpc and product subscriptions and closes it when idle', () => {
    FakeWebSocket.instances = []
    const receivedRpc: unknown[] = []
    const receivedProduct: unknown[] = []
    const client = createCodexRealtimeClient({
      getWindow: () => fakeWindow(),
      getWebSocket: () => FakeWebSocket,
      nowIso: () => '2026-07-07T03:00:00.000Z',
    })

    const unsubscribeRpc = client.subscribeRpcNotifications((notification) => {
      receivedRpc.push(notification)
    })
    const unsubscribeProduct = client.subscribeProductNotifications((notification) => {
      receivedProduct.push(notification)
    })

    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://localhost:5173/codex-api/ws')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'rpc',
        notification: { method: 'turn/started', params: { threadId: 'thread-1' } },
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'product',
        notification: {
          id: 'n-1',
          kind: 'workflow',
          title: 'Workflow done',
          summary: 'ok',
          severity: 'success',
        },
      }),
    })

    expect(receivedRpc).toMatchObject([
      { method: 'turn/started', params: { threadId: 'thread-1' } },
    ])
    expect(receivedProduct).toMatchObject([
      { id: 'n-1', title: 'Workflow done' },
    ])

    unsubscribeRpc()
    expect(socket.closeCount).toBe(0)
    unsubscribeProduct()
    expect(socket.closeCount).toBe(1)
  })

  it('publishes authoritative websocket connection state and reconnect diagnostics', () => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    const states: Array<Record<string, unknown>> = []
    let now = 0
    const client = createCodexRealtimeClient({
      getWindow: () => fakeWindow(),
      getWebSocket: () => FakeWebSocket,
      nowIso: () => `2026-07-07T03:00:0${String(now++)}.000Z`,
      random: () => 0.5,
    })

    const unsubscribe = client.subscribeConnection((state) => states.push(state))
    expect(states.map((state) => state.phase)).toEqual(['idle', 'connecting'])

    const firstSocket = FakeWebSocket.instances[0]
    firstSocket.readyState = FakeWebSocket.OPEN
    firstSocket.emit('open')
    expect(states.at(-1)).toMatchObject({
      phase: 'connected',
      reconnectAttempt: 0,
      closeCode: null,
      closeReason: '',
    })

    firstSocket.readyState = 3
    firstSocket.emit('close', { code: 1006, reason: 'network changed' })
    expect(states.at(-1)).toMatchObject({
      phase: 'reconnecting',
      reconnectAttempt: 1,
      closeCode: 1006,
      closeReason: 'network changed',
    })
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const secondSocket = FakeWebSocket.instances[1]
    secondSocket.readyState = FakeWebSocket.OPEN
    secondSocket.emit('open')
    expect(states.at(-1)).toMatchObject({ phase: 'connected', reconnectAttempt: 0 })

    unsubscribe()
    expect(secondSocket.closeCount).toBe(1)
  })

  it('keeps one socket when connection and notification subscribers coexist', () => {
    FakeWebSocket.instances = []
    const client = createCodexRealtimeClient({
      getWindow: () => fakeWindow(),
      getWebSocket: () => FakeWebSocket,
    })

    const stopConnection = client.subscribeConnection(() => undefined)
    const stopRpc = client.subscribeRpcNotifications(() => undefined)
    const stopProduct = client.subscribeProductNotifications(() => undefined)
    expect(FakeWebSocket.instances).toHaveLength(1)

    stopConnection()
    stopRpc()
    expect(FakeWebSocket.instances[0].closeCount).toBe(0)
    stopProduct()
    expect(FakeWebSocket.instances[0].closeCount).toBe(1)
  })

  it('starts a fresh connection lifecycle after the last subscriber releases the hub', () => {
    FakeWebSocket.instances = []
    const client = createCodexRealtimeClient({
      getWindow: () => fakeWindow(),
      getWebSocket: () => FakeWebSocket,
    })
    const firstStates: string[] = []
    const stopFirst = client.subscribeConnection((state) => firstStates.push(state.phase))
    FakeWebSocket.instances[0]!.emit('open')
    stopFirst()

    const secondStates: string[] = []
    const stopSecond = client.subscribeConnection((state) => secondStates.push(state.phase))
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(firstStates).toEqual(['idle', 'connecting', 'connected'])
    expect(secondStates).toEqual(['idle', 'connecting'])
    stopSecond()
  })

  it('ignores delayed open, message and close callbacks from a replaced socket', () => {
    FakeWebSocket.instances = []
    const states: string[] = []
    const receivedRpc: unknown[] = []
    const client = createCodexRealtimeClient({
      getWindow: () => fakeWindow(),
      getWebSocket: () => FakeWebSocket,
    })
    const stopRpc = client.subscribeRpcNotifications((notification) => receivedRpc.push(notification))
    const stopConnection = client.subscribeConnection((state) => states.push(state.phase))
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.emit('open')

    client.reconnectNow()
    const secondSocket = FakeWebSocket.instances[1]!
    const statesBeforeLateCallbacks = [...states]
    firstSocket.emit('open')
    firstSocket.emit('message', {
      data: JSON.stringify({ type: 'rpc', notification: { method: 'late/notification', params: {} } }),
    })
    firstSocket.emit('close', { code: 1006, reason: 'late close' })

    expect(states).toEqual(statesBeforeLateCallbacks)
    expect(receivedRpc).toEqual([])

    secondSocket.emit('open')
    secondSocket.emit('message', {
      data: JSON.stringify({ type: 'rpc', notification: { method: 'current/notification', params: {} } }),
    })
    expect(states.at(-1)).toBe('connected')
    expect(receivedRpc).toEqual([expect.objectContaining({ method: 'current/notification' })])
    stopRpc()
    stopConnection()
  })
})
