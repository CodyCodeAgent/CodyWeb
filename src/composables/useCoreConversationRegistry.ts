import { ref } from 'vue'
import {
  createConversationController,
  type ConversationController,
  type ConversationSubscriptionEvent,
  type ConversationTransport,
} from '@codycodeagent/cody-web-core/client'
import {
  createConversationState,
  type ConversationState,
} from '@codycodeagent/cody-web-core/conversation'
import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'
import { attachThreadConversation, getThreadEvents, submitThreadCommand } from '../api/codexThreadClient'
import {
  subscribeConversationEvents,
  subscribeRealtimeConnection,
  type RealtimeConnectionSnapshot,
} from '../api/codexRealtimeClient'

/**
 * The only browser-side owner of conversation projection state. Product
 * composables retain catalog/navigation state, never a second message merge.
 */
export function useCoreConversationRegistry() {
  const stateByThreadId = ref<Record<string, ConversationState>>({})
  const controllers = new Map<string, ConversationController>()
  const unsubscribeByThreadId = new Map<string, () => void>()
  const transportListenersByThreadId = new Map<string, Set<(event: ConversationSubscriptionEvent) => void>>()
  const eventListeners = new Set<(event: Parameters<ConversationController['ingestEvent']>[0]) => void>()
  let connectionSnapshot: RealtimeConnectionSnapshot | null = null
  let focusedThreadId = ''

  const stopConversationEvents = subscribeConversationEvents((event) => {
    controllerFor(event.threadId).ingestEvent(event)
    for (const listener of eventListeners) listener(event)
  })

  const stopConnection = subscribeRealtimeConnection((snapshot) => {
    connectionSnapshot = snapshot
    const event: ConversationSubscriptionEvent | null = snapshot.phase === 'connected'
      ? { type: 'connected', atIso: snapshot.connectedAtIso }
      : snapshot.phase === 'reconnecting'
        ? {
            type: 'disconnected',
            error: snapshot.closeReason || 'CodyWeb realtime transport disconnected.',
            atIso: snapshot.disconnectedAtIso,
            reconnectAttempt: snapshot.reconnectAttempt,
            closeCode: snapshot.closeCode,
            closeReason: snapshot.closeReason,
          }
        : null
    if (!event) return
    for (const [threadId, listeners] of transportListenersByThreadId) {
      if (event.type === 'connected') {
        const state = stateByThreadId.value[threadId]
        const needsImmediateReconciliation = threadId === focusedThreadId
          || Boolean(state?.activeTurnId)
          || Boolean(state?.pendingRequests.length)
        if (!needsImmediateReconciliation) continue
      }
      for (const listener of listeners) listener(event)
    }
  })

  function transportForThread(threadId: string): ConversationTransport {
    return {
      async attach(attachedThreadId) {
        // Attachment is a replaceable owner snapshot consumed by Core during
        // reconciliation. It is deliberately not re-broadcast as a new live
        // event; doing both gives reconnects two semantic paths.
        return attachThreadConversation(attachedThreadId)
      },
      read: getThreadEvents,
      submit(command) {
        return submitThreadCommand({
          threadId: command.threadId,
          clientCommandId: command.clientCommandId,
          mode: command.mode,
          turnInput: command.input as Parameters<typeof submitThreadCommand>[0]['turnInput'],
          context: command.context as Parameters<typeof submitThreadCommand>[0]['context'],
        })
      },
      subscribe(_threadId, listener) {
        const listeners = transportListenersByThreadId.get(threadId) ?? new Set()
        listeners.add(listener)
        transportListenersByThreadId.set(threadId, listeners)
        if (connectionSnapshot?.phase === 'connected') {
          listener({ type: 'connected', atIso: connectionSnapshot.connectedAtIso })
        } else if (connectionSnapshot?.phase === 'reconnecting') {
          listener({
            type: 'disconnected',
            atIso: connectionSnapshot.disconnectedAtIso,
            reconnectAttempt: connectionSnapshot.reconnectAttempt,
            closeCode: connectionSnapshot.closeCode,
            closeReason: connectionSnapshot.closeReason,
          })
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) transportListenersByThreadId.delete(threadId)
        }
      },
    }
  }

  function controllerFor(threadId: string): ConversationController {
    const normalized = threadId.trim()
    const existing = controllers.get(normalized)
    if (existing) return existing
    const controller = createConversationController(normalized, transportForThread(normalized))
    controllers.set(normalized, controller)
    stateByThreadId.value = { ...stateByThreadId.value, [normalized]: controller.getState() }
    unsubscribeByThreadId.set(normalized, controller.subscribe((state) => {
      stateByThreadId.value = { ...stateByThreadId.value, [normalized]: state }
    }))
    return controller
  }

  function stateFor(threadId: string): ConversationState {
    return stateByThreadId.value[threadId] ?? createConversationState(threadId)
  }

  function focus(threadId: string): void {
    focusedThreadId = threadId.trim()
  }

  async function connect(threadId: string): Promise<void> {
    if (!threadId.trim()) return
    await controllerFor(threadId).start()
  }

  async function refresh(threadId: string): Promise<void> {
    if (!threadId.trim()) return
    await controllerFor(threadId).refresh()
  }

  function submit(input: {
    threadId: string
    commandId: string
    text: string
    images?: string[]
    skills?: ComposerSkill[]
    mode: 'queue' | 'steer'
    turnInput: Parameters<typeof submitThreadCommand>[0]['turnInput']
    context?: Parameters<typeof submitThreadCommand>[0]['context']
  }): Promise<{ clientCommandId: string }> {
    return controllerFor(input.threadId).submitUserMessage({
      id: input.commandId,
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
    }, {
      mode: input.mode,
      input: input.turnInput,
      ...(input.context ? { context: input.context } : {}),
    })
  }

  function discard(threadId: string, commandId: string): void {
    controllerFor(threadId).discardQueuedUserMessage(commandId)
  }

  function ingest(threadId: string, event: Parameters<ConversationController['ingestEvent']>[0]): void {
    controllerFor(threadId).ingestEvent(event)
  }

  function subscribeEvents(listener: (event: Parameters<ConversationController['ingestEvent']>[0]) => void): () => void {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
  }

  function prune(activeThreadIds: ReadonlySet<string>): void {
    for (const [threadId, controller] of controllers) {
      if (activeThreadIds.has(threadId)) continue
      unsubscribeByThreadId.get(threadId)?.()
      unsubscribeByThreadId.delete(threadId)
      controller.dispose()
      controllers.delete(threadId)
    }
    stateByThreadId.value = Object.fromEntries(
      Object.entries(stateByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
  }

  function dispose(): void {
    for (const stop of unsubscribeByThreadId.values()) stop()
    unsubscribeByThreadId.clear()
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
    stopConversationEvents()
    stopConnection()
    transportListenersByThreadId.clear()
    eventListeners.clear()
    stateByThreadId.value = {}
  }

  return { stateByThreadId, stateFor, focus, connect, refresh, submit, discard, ingest, subscribeEvents, prune, dispose }
}
