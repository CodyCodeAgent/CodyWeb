import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { useCoreConversationRegistry } from './useCoreConversationRegistry'

const mocks = vi.hoisted(() => {
  type ConnectionSnapshot = {
    phase: 'idle' | 'connecting' | 'connected' | 'reconnecting'
    reconnectAttempt: number
    connectedAtIso: string
    disconnectedAtIso: string
    closeCode: number | null
    closeReason: string
  }
  let eventListener: ((event: CodexEvent) => void) | null = null
  let connectionListener: ((snapshot: ConnectionSnapshot) => void) | null = null
  return {
    attach: vi.fn(async () => ({ events: [] as CodexEvent[] })),
    read: vi.fn(async () => [] as CodexEvent[]),
    submit: vi.fn(async (input: { clientCommandId: string }) => ({ clientCommandId: input.clientCommandId })),
    subscribeEvents: vi.fn((listener: (event: CodexEvent) => void) => {
      eventListener = listener
      return () => { if (eventListener === listener) eventListener = null }
    }),
    subscribeConnection: vi.fn((listener: (snapshot: ConnectionSnapshot) => void) => {
      connectionListener = listener
      listener({
        phase: 'connected', reconnectAttempt: 0,
        connectedAtIso: '2026-09-01T00:00:00.000Z', disconnectedAtIso: '',
        closeCode: null, closeReason: '',
      })
      return () => { if (connectionListener === listener) connectionListener = null }
    }),
    emit(event: CodexEvent) { eventListener?.(event) },
    connection(snapshot: ConnectionSnapshot) { connectionListener?.(snapshot) },
    reset() {
      eventListener = null
      connectionListener = null
      vi.clearAllMocks()
    },
  }
})

vi.mock('../api/codexThreadClient', () => ({
  attachThreadConversation: mocks.attach,
  getThreadEvents: mocks.read,
  submitThreadCommand: mocks.submit,
}))

vi.mock('../api/codexRealtimeClient', () => ({
  subscribeConversationEvents: mocks.subscribeEvents,
  subscribeRealtimeConnection: mocks.subscribeConnection,
}))

function event(input: Partial<CodexEvent> & Pick<CodexEvent, 'id' | 'type' | 'threadId'>): CodexEvent {
  return {
    atIso: '2026-09-01T00:00:00.000Z',
    data: {},
    ...input,
  }
}

afterEach(() => mocks.reset())

describe('useCoreConversationRegistry', () => {
  it('uses one multiplexed realtime subscription for every thread', () => {
    const registry = useCoreConversationRegistry()
    registry.stateFor('thread-a')
    registry.stateFor('thread-b')
    expect(mocks.subscribeEvents).toHaveBeenCalledTimes(1)
    expect(mocks.subscribeConnection).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('keeps a background-thread event that arrives before selection and attach', async () => {
    const registry = useCoreConversationRegistry()
    mocks.emit(event({
      id: 'answer-before-selection', type: 'assistant.completed', threadId: 'thread-b',
      turnId: 'turn-b', itemId: 'agent-b', data: { text: '后台线程输出' },
    }))

    await registry.connect('thread-b')

    expect(mocks.attach).toHaveBeenCalledWith('thread-b')
    expect(registry.stateFor('thread-b').messages).toEqual([
      expect.objectContaining({ id: 'agent:agent-b', text: '后台线程输出' }),
    ])
    registry.dispose()
  })

  it('shows an optimistic user row before admission and reconciles the native item in place', async () => {
    let accept!: (value: { clientCommandId: string }) => void
    mocks.submit.mockImplementationOnce((input: { clientCommandId: string }) => new Promise(resolve => {
      accept = resolve
    }))
    const registry = useCoreConversationRegistry()
    const submitting = registry.submit({
      threadId: 'thread-a', commandId: 'command-a', text: '立即显示', mode: 'queue',
      turnInput: { input: [{ type: 'text', text: '立即显示', text_elements: [] }] },
    })

    expect(registry.stateFor('thread-a').messages).toEqual([
      expect.objectContaining({ id: 'user:command-a', text: '立即显示', outbox: { status: 'queued' } }),
    ])
    accept({ clientCommandId: 'command-a' })
    await submitting
    mocks.emit(event({
      id: 'bound-a', type: 'command.bound', threadId: 'thread-a', turnId: 'turn-a',
      itemId: 'command-a', data: { clientCommandId: 'command-a' },
    }))
    mocks.emit(event({
      id: 'native-a', type: 'user.completed', threadId: 'thread-a', turnId: 'turn-a',
      itemId: 'native-user-a', data: { text: '立即显示' },
    }))

    expect(registry.stateFor('thread-a').messages).toEqual([
      expect.objectContaining({ id: 'user:native-user-a', text: '立即显示', turnId: 'turn-a' }),
    ])
    registry.dispose()
  })

  it('keeps browser reconnect state separate from native Turn state', async () => {
    const registry = useCoreConversationRegistry()
    mocks.emit(event({ id: 'turn-a', type: 'turn.started', threadId: 'thread-a', turnId: 'turn-a' }))
    await registry.connect('thread-a')
    mocks.connection({
      phase: 'reconnecting', reconnectAttempt: 3,
      connectedAtIso: '2026-09-01T00:00:00.000Z', disconnectedAtIso: '2026-09-01T00:00:03.000Z',
      closeCode: 1006, closeReason: 'network changed',
    })

    const state = registry.stateFor('thread-a')
    expect(state.transportConnection).toMatchObject({
      status: 'reconnecting', reconnectAttempt: 3, closeCode: 1006, closeReason: 'network changed',
    })
    expect(state.activeTurnId).toBe('turn-a')
    expect(state.turns['turn-a']?.lifecycle).toBe('running')
    registry.dispose()
  })

  it('reconciles focused, running and pending-request conversations while leaving the rest lazy', async () => {
    const registry = useCoreConversationRegistry()
    registry.focus('thread-a')
    await registry.connect('thread-a')
    await registry.connect('thread-b')
    await registry.connect('thread-c')
    await registry.connect('thread-d')
    mocks.emit(event({ id: 'running-b', type: 'turn.started', threadId: 'thread-b', turnId: 'turn-b' }))
    mocks.emit(event({
      id: 'approval-c', type: 'approval.requested', threadId: 'thread-c', turnId: 'turn-c',
      data: { requestId: 'request-c', method: 'item/fileChange/requestApproval' },
    }))
    mocks.read.mockClear()

    mocks.connection({
      phase: 'reconnecting', reconnectAttempt: 1,
      connectedAtIso: '2026-09-01T00:00:00.000Z', disconnectedAtIso: '2026-09-01T00:00:01.000Z',
      closeCode: 1006, closeReason: 'network changed',
    })
    mocks.connection({
      phase: 'connected', reconnectAttempt: 0,
      connectedAtIso: '2026-09-01T00:00:02.000Z', disconnectedAtIso: '2026-09-01T00:00:01.000Z',
      closeCode: null, closeReason: '',
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.read.mock.calls).toEqual([
      ['thread-a'],
      ['thread-b'],
      ['thread-c'],
    ])

    registry.focus('thread-d')
    await registry.refresh('thread-d')
    expect(mocks.read.mock.calls).toEqual([
      ['thread-a'],
      ['thread-b'],
      ['thread-c'],
      ['thread-d'],
    ])
    registry.dispose()
  })
})
