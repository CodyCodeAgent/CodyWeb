import { computed, ref, watch } from 'vue'
import {
  buildTurnCollaborationMode,
  resolveComposerSubmitMode,
  type ComposerCollaborationModeOption,
  type ComposerSubmission,
} from '@codycodeagent/cody-web-core/composer'
import {
  conversationFeedFromState,
  conversationLiveOverlayFromState,
  conversationTranscriptFromState,
  type CodexEvent,
  type ConversationScrollState,
} from '@codycodeagent/cody-web-core/conversation'
import {
  compactThread,
  buildTurnInput,
  forkThread,
  interruptThreadTurn,
  renameThread,
  startThread,
} from '../api/codexThreadClient'
import {
  fetchCatalog,
  saveCatalogProjectDisplayName,
  saveCatalogProjectOrder,
  setProjectHidden,
  setThreadHidden,
} from '../api/codexCatalogClient'
import type { RpcNotification } from '../api/codexRealtimeClient'
import {
  readStartedThread,
} from './realtimeNotificationReaders'
import { useServerRequestState } from './useServerRequestState'
import { useDesktopComposerState } from './useDesktopComposerState'
import { useDesktopRealtimeState } from './useDesktopRealtimeState'
import { useDesktopThreadState } from './useDesktopThreadState'
import type { DesktopPlanState } from './desktopPlanState'
import { useCoreConversationRegistry } from './useCoreConversationRegistry'
import { shouldQueueEventDrivenSyncForMethod } from './realtimeSyncPolicy'
import { useRateLimitState } from './useRateLimitState'
import {
  buildRollbackAuditMessage,
} from './desktopMessageState'
import {
  markThreadMessagesLoaded,
  setThreadLoadedVersion,
  shouldShowMessagesLoading,
} from './desktopThreadScopedState'
import { buildTurnPermissionOverride } from './desktopTurnPermissions'
import {
  normalizeComposerTurnInput,
  normalizeNewThreadTurnInput,
  normalizeThreadTextTurnInput,
} from './desktopTurnState'
import { buildPendingConversationCommand, type PendingConversationCommand } from './conversationCommand'
import { normalizeThreadScrollState, saveProjectDisplayNames, saveProjectOrder, saveReadStateMap, saveThreadScrollStateMap } from './desktopStateStorage'
import {
  areStringArraysEqual,
  buildThreadGroupsWithFlags,
  flattenThreads,
  markThreadReadState,
  markThreadUnreadState,
  mergeProjectOrder,
  mergeThreadGroups,
  moveProjectInOrder,
  omitKey,
  orderGroupsByProjectOrder,
  reconcileOptimisticThreads,
  renameProjectDisplayName,
  renameThreadInGroups,
  updateThreadBooleanState,
  upsertThreadInGroups,
} from './threadGroupState'
import type {
  UiComposerContextKind,
  UiMessage,
  UiQueuedMessage,
  UiServerRequestReply,
  UiThread,
  UiThreadContextUsage,
  UiToolingRollbackFileResult,
} from '../types/codex'

export { buildRollbackAuditMessage } from './desktopMessageState'

const EVENT_SYNC_DEBOUNCE_MS = 220

export function useDesktopState() {
  const threadState = useDesktopThreadState()
  const {
    projectGroups, sourceGroups, optimisticThreadById, selectedThreadId, isHiddenView,
    inProgressById, eventUnreadByThreadId, readStateByThreadId, scrollStateByThreadId,
    projectOrder, projectDisplayNameById, loadedVersionByThreadId, loadedMessagesByThreadId,
    resumedThreadById, allThreads, selectedThread, selectedThreadScrollState,
  } = threadState
  const composerState = useDesktopComposerState()
  const { availableModelIds, selectedModelId, selectedReasoningEffort, selectedPermissionMode, selectedSubmitMode,
    modelContextWindow, autoCompactTokenLimit,
    collaborationModeOptions, selectedCollaborationModeName, selectedCollaborationMode,
    hydrate: hydrateTurnPreferencesFromSettingsStore, refreshCollaborationModes, refreshModelPreferences,
    setSelectedModelId, setSelectedReasoningEffort, setSelectedCollaborationModeName, setSelectedPermissionMode,
    setSelectedSubmitMode } = composerState
  const coreConversations = useCoreConversationRegistry()
  const conversationStateByThreadId = coreConversations.stateByThreadId
  const serverRequestState = useServerRequestState(selectedThreadId, (message) => { error.value = message })
  const pendingServerRequestsByThreadId = serverRequestState.byThreadId
  const {
    rateLimitSnapshot,
    isLoadingRateLimits,
    refreshRateLimits,
    handleRateLimitNotification,
  } = useRateLimitState()

  const isLoadingThreads = ref(false)
  const loadingMessagesByThreadId = ref<Record<string, boolean>>({})
  const messageLoadErrorByThreadId = ref<Record<string, string>>({})
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const error = ref('')
  const hasLoadedThreads = ref(false)
  let eventSyncTimer: number | null = null
  let shouldAutoScrollOnNextAgentEvent = false
  const latestMessageLoadRequestIdByThreadId = new Map<string, number>()
  let nextMessageLoadRequestId = 0
  let latestThreadsRequestId = 0
  let nextOptimisticUserMessageId = 0
  const directThreadRecoveryById = new Map<string, Promise<void>>()
  const stopCoreEventSubscription = coreConversations.subscribeEvents((event) => {
    if (event.type === 'command.failed') {
      const message = typeof event.data.error === 'string' ? event.data.error : 'Command failed before a native Turn was created.'
      error.value = message
    }
    const conversation = coreConversations.stateFor(event.threadId)
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted') {
      markThreadUnreadByEvent(event.threadId)
      if (event.threadId === selectedThreadId.value) shouldAutoScrollOnNextAgentEvent = false
    }
    if (event.type === 'turn.failed' || event.type === 'turn.disconnected') {
      const turnId = event.turnId || conversation.activeTurnId
      const message = turnId ? conversation.turns[turnId]?.error ?? '' : ''
      if (message) error.value = message
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.completed' || event.type === 'reasoning.delta' || event.type === 'plan.delta' || event.type === 'plan.replaced') {
      if (event.threadId === selectedThreadId.value && shouldAutoScrollOnNextAgentEvent) {
        setThreadScrollState(event.threadId, { scrollTop: 0, isAtBottom: true, scrollRatio: 1 })
      }
    }
  })

  const selectedThreadServerRequests = serverRequestState.selected
  const selectedCoreConversation = computed(() => (
    coreConversations.stateFor(selectedThreadId.value)
  ))
  const isLoadingMessages = computed(() => loadingMessagesByThreadId.value[selectedThreadId.value] === true)
  const hasLoadedSelectedMessages = computed(
    () => loadedMessagesByThreadId.value[selectedThreadId.value] === true,
  )
  const allPendingServerRequests = serverRequestState.all
  const selectedLiveOverlay = computed(() => {
    return conversationLiveOverlayFromState(selectedCoreConversation.value)
  })
  const selectedStructuredPlan = computed<DesktopPlanState | null>(() => {
    const plan = selectedCoreConversation.value.plan
    if (!plan?.turnId || !plan.steps?.length) return null
    return {
      threadId: plan.threadId,
      turnId: plan.turnId,
      explanation: plan.explanation ?? '',
      steps: plan.steps,
      updatedAtIso: plan.updatedAtIso,
      revision: plan.revision,
      lifecycle: plan.lifecycle,
      possiblyStale: plan.possiblyStale,
    }
  })
  const selectedMessageLoadError = computed(() => messageLoadErrorByThreadId.value[selectedThreadId.value] ?? '')
  const selectedThreadContextUsage = computed<UiThreadContextUsage | null>(() => {
    const usage = selectedCoreConversation.value.contextUsage
    if (!usage) return null
    return {
      ...usage,
      threadId: selectedCoreConversation.value.threadId || selectedThreadId.value,
      contextWindow: usage.contextWindow ?? modelContextWindow.value,
      autoCompactTokenLimit: usage.autoCompactTokenLimit ?? autoCompactTokenLimit.value,
    }
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    return conversationTranscriptFromState(coreConversations.stateFor(threadId)) as UiMessage[]
  })
  const selectedQueuedMessages = computed<UiQueuedMessage[]>(() => queuedMessagesForThread(selectedThreadId.value))

  function setSelectedThreadId(nextThreadId: string): void {
    if (selectedThreadId.value === nextThreadId) return
    threadState.setSelectedThreadId(nextThreadId)
    shouldAutoScrollOnNextAgentEvent = false
  }

  function setMessagesLoadingForThread(threadId: string, isLoading: boolean): void {
    if (!threadId) return
    const previous = loadingMessagesByThreadId.value[threadId] === true
    if (previous === isLoading) return

    if (!isLoading) {
      loadingMessagesByThreadId.value = omitKey(loadingMessagesByThreadId.value, threadId)
      return
    }

    loadingMessagesByThreadId.value = {
      ...loadingMessagesByThreadId.value,
      [threadId]: true,
    }
  }

  function setMessageLoadErrorForThread(threadId: string, message: string): void {
    if (!threadId) return
    if (!message) {
      messageLoadErrorByThreadId.value = omitKey(messageLoadErrorByThreadId.value, threadId)
      return
    }
    messageLoadErrorByThreadId.value = {
      ...messageLoadErrorByThreadId.value,
      [threadId]: message,
    }
  }

  function clearError(): void {
    error.value = ''
  }

  function applyThreadFlags(): void {
    const flaggedGroups = buildThreadGroupsWithFlags(sourceGroups.value, {
      selectedThreadId: selectedThreadId.value,
      inProgressById: inProgressById.value,
      readStateByThreadId: readStateByThreadId.value,
      eventUnreadByThreadId: eventUnreadByThreadId.value,
    })
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function addOptimisticThread(thread: UiThread): void {
    optimisticThreadById.value = {
      ...optimisticThreadById.value,
      [thread.id]: thread,
    }
    sourceGroups.value = upsertThreadInGroups(sourceGroups.value, thread)
    applyThreadFlags()
  }

  function updateOptimisticThreadTitle(threadId: string, title: string): void {
    const optimisticThread = optimisticThreadById.value[threadId]
    if (!optimisticThread) return

    optimisticThreadById.value = {
      ...optimisticThreadById.value,
      [threadId]: {
        ...optimisticThread,
        title,
        preview: title,
      },
    }
  }

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    // A direct /thread/:threadId link can be valid before catalog/thread-list has
    // included it (for example after an App Server restart or list pagination).
    // Keep its hydrated state until thread/read settles instead of treating it as
    // stale catalog data and discarding the transcript.
    if (selectedThreadId.value) activeThreadIds.add(selectedThreadId.value)
    const pruneMap = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(
      Object.entries(value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    readStateByThreadId.value = pruneMap(readStateByThreadId.value)
    saveReadStateMap(readStateByThreadId.value)
    scrollStateByThreadId.value = pruneMap(scrollStateByThreadId.value)
    saveThreadScrollStateMap(scrollStateByThreadId.value)
    loadedMessagesByThreadId.value = pruneMap(loadedMessagesByThreadId.value)
    loadedVersionByThreadId.value = pruneMap(loadedVersionByThreadId.value)
    resumedThreadById.value = pruneMap(resumedThreadById.value)
    messageLoadErrorByThreadId.value = Object.fromEntries(
      Object.entries(messageLoadErrorByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    eventUnreadByThreadId.value = pruneMap(eventUnreadByThreadId.value)
    inProgressById.value = pruneMap(inProgressById.value)
    pendingServerRequestsByThreadId.value = pruneMap(pendingServerRequestsByThreadId.value)
    coreConversations.prune(activeThreadIds)
    loadingMessagesByThreadId.value = Object.fromEntries(
      Object.entries(loadingMessagesByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    for (const threadId of latestMessageLoadRequestIdByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) {
        latestMessageLoadRequestIdByThreadId.delete(threadId)
      }
    }
  }

  function markThreadAsRead(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    if (!thread) return

    const nextState = markThreadReadState(readStateByThreadId.value, eventUnreadByThreadId.value, thread)
    let didChange = false
    if (nextState.readStateByThreadId !== readStateByThreadId.value) {
      readStateByThreadId.value = nextState.readStateByThreadId
      saveReadStateMap(nextState.readStateByThreadId)
      didChange = true
    }
    if (nextState.eventUnreadByThreadId !== eventUnreadByThreadId.value) {
      eventUnreadByThreadId.value = nextState.eventUnreadByThreadId
      didChange = true
    }
    if (didChange) {
      applyThreadFlags()
    }
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    const nextState = updateThreadBooleanState(inProgressById.value, threadId, nextInProgress)
    if (nextState === inProgressById.value) return
    inProgressById.value = nextState
    applyThreadFlags()
  }

  // Sidebar activity is a projection of Core state, including state replaced
  // by a native history refresh. It must never be advanced independently by
  // an HTTP acknowledgement or a product event handler.
  watch(conversationStateByThreadId, (states) => {
    let nextState = inProgressById.value
    for (const [threadId, state] of Object.entries(states)) {
      nextState = updateThreadBooleanState(nextState, threadId, Boolean(state.activeTurnId))
    }
    if (nextState === inProgressById.value) return
    inProgressById.value = nextState
    applyThreadFlags()
  })

  function markThreadUnreadByEvent(threadId: string): void {
    const nextState = markThreadUnreadState(eventUnreadByThreadId.value, threadId, selectedThreadId.value)
    if (nextState !== eventUnreadByThreadId.value) {
      eventUnreadByThreadId.value = nextState
      applyThreadFlags()
    }
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadScrollState(threadId: string, nextState: ConversationScrollState): void {
    if (!threadId) return

    const normalizedState = normalizeThreadScrollState(nextState)
    if (!normalizedState) return

    const previousState = scrollStateByThreadId.value[threadId]
    if (
      previousState &&
      previousState.scrollTop === normalizedState.scrollTop &&
      previousState.isAtBottom === normalizedState.isAtBottom &&
      previousState.scrollRatio === normalizedState.scrollRatio
    ) {
      return
    }

    scrollStateByThreadId.value = {
      ...scrollStateByThreadId.value,
      [threadId]: normalizedState,
    }
    saveThreadScrollStateMap(scrollStateByThreadId.value)
  }

  function queuedMessagesForThread(threadId: string): UiQueuedMessage[] {
    return coreConversations.stateFor(threadId).messages
      .filter((message) => message.role === 'user' && Boolean(message.outbox))
      .map((message) => {
        const id = message.id.startsWith('user:') ? message.id.slice('user:'.length) : message.id
        return {
          id,
          threadId,
          text: message.text,
          status: message.outbox!.status,
          createdAtIso: '',
          lastError: message.outbox?.lastError,
          canManage: message.outbox?.status === 'failed',
        }
      })
  }

  function recordRollbackAudit(result: UiToolingRollbackFileResult): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const message = buildRollbackAuditMessage(result)
    coreConversations.ingest(threadId, {
      id: message.id,
      type: 'tool.completed',
      threadId,
      itemId: message.id,
      atIso: new Date().toISOString(),
      data: { tool: message.tool },
    })
  }

  function addOptimisticUserMessage(
    threadId: string,
    turnInput: {
      text: string
      images: ComposerSubmission<UiComposerContextKind>['images']
      skills: ComposerSubmission<UiComposerContextKind>['skills']
    },
    preferredMessageId = '',
  ): string {
    if (!threadId) return ''

    if (!preferredMessageId) nextOptimisticUserMessageId += 1
    const messageId = preferredMessageId || `command:${threadId}:${String(nextOptimisticUserMessageId)}`
    coreConversations.enqueue({
      threadId,
      commandId: messageId,
      text: turnInput.text,
      images: turnInput.images.map((image) => image.url).filter((url) => url.trim().length > 0),
      skills: turnInput.skills,
    })
    return messageId
  }

  function ensureOutboxOptimisticUserMessage(item: PendingConversationCommand): string {
    return addOptimisticUserMessage(item.threadId, item, item.id)
  }

  function bindOptimisticUserMessageToTurn(threadId: string, turnId: string, messageId: string): void {
    if (!turnId || !messageId) return
    coreConversations.bind(threadId, messageId, turnId)
  }

  function removeOptimisticUserMessage(threadId: string, messageId: string): void {
    if (!threadId || !messageId) return
    coreConversations.discard(threadId, messageId)
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    // Raw RPC notifications are product metadata only. Conversation lifecycle
    // is normalized once on the server and consumed through Core above.
    if (handleRateLimitNotification(notification)) {
      return
    }

    const startedThread = readStartedThread(notification)
    if (startedThread) {
      addOptimisticThread(startedThread)
    }

    if (serverRequestState.handle(notification)) {
      return
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (!shouldQueueEventDrivenSyncForMethod(notification.method)) return
    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      // Realtime conversation state already arrived through Core. This refresh
      // is only for catalog metadata (title, unread grouping, project tree).
      void loadThreads().catch(() => undefined)
    }, EVENT_SYNC_DEBOUNCE_MS)
  }

  async function loadThreads() {
    const requestId = ++latestThreadsRequestId
    if (!hasLoadedThreads.value) {
      isLoadingThreads.value = true
    }

    try {
      const catalog = await fetchCatalog(isHiddenView.value ? 'hidden' : 'visible')
      if (requestId !== latestThreadsRequestId) return
      const groups = catalog.groups

      const localDisplayNames = projectDisplayNameById.value
      projectDisplayNameById.value = {
        ...localDisplayNames,
        ...catalog.projectDisplayNameById,
      }
      saveProjectDisplayNames(projectDisplayNameById.value)
      for (const [projectKey, displayName] of Object.entries(localDisplayNames)) {
        if (!catalog.projectDisplayNameById[projectKey] && groups.some((group) => group.projectName === projectKey)) {
          void saveCatalogProjectDisplayName(projectKey, displayName)
        }
      }

      const nextProjectOrder = catalog.hasStoredProjectOrder
        ? catalog.projectOrder
        : mergeProjectOrder(projectOrder.value, groups)
      if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
        projectOrder.value = nextProjectOrder
        saveProjectOrder(projectOrder.value)
      }
      if (!catalog.hasStoredProjectOrder && nextProjectOrder.length > 0) {
        void saveCatalogProjectOrder(nextProjectOrder)
      }

      const orderedGroups = orderGroupsByProjectOrder(groups, projectOrder.value)
      const optimisticResult = isHiddenView.value
        ? { groups: orderedGroups, optimisticThreadById: optimisticThreadById.value }
        : reconcileOptimisticThreads(orderedGroups, optimisticThreadById.value)
      if (optimisticResult.optimisticThreadById !== optimisticThreadById.value) {
        optimisticThreadById.value = optimisticResult.optimisticThreadById
      }
      sourceGroups.value = optimisticResult.groups
      applyThreadFlags()
      hasLoadedThreads.value = true

      const flatThreads = flattenThreads(projectGroups.value)
      pruneThreadScopedState(flatThreads)

      if (!selectedThreadId.value) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      if (requestId === latestThreadsRequestId) isLoadingThreads.value = false
    }
  }

  /**
   * A native Codex thread is durable, but a newly started App Server does not
   * necessarily include it in thread/list until thread/resume has materialized
   * it in that process. Deep links must therefore recover the native session
   * before treating an empty catalog as "thread not found".
   */
  async function recoverDirectThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    if (resumedThreadById.value[normalizedThreadId] === true) return

    const existing = directThreadRecoveryById.get(normalizedThreadId)
    if (existing) return existing

    const recovery = (async () => {
      try {
        await coreConversations.connect(normalizedThreadId)
        const historyError = coreConversations.stateFor(normalizedThreadId).history.error
        if (historyError) throw new Error(historyError)
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [normalizedThreadId]: true,
        }
        await loadThreads()
      } finally {
        directThreadRecoveryById.delete(normalizedThreadId)
      }
    })()
    directThreadRecoveryById.set(normalizedThreadId, recovery)
    return recovery
  }

  async function loadMessages(threadId: string, options: { silent?: boolean } = {}) {
    if (!threadId) {
      return
    }

    const requestId = nextMessageLoadRequestId + 1
    nextMessageLoadRequestId = requestId
    latestMessageLoadRequestIdByThreadId.set(threadId, requestId)
    const shouldShowLoading = shouldShowMessagesLoading({
      loadedMessagesByThreadId: loadedMessagesByThreadId.value,
      threadId,
      silent: options.silent === true,
    })
    if (shouldShowLoading) {
      setMessagesLoadingForThread(threadId, true)
    }
    setMessageLoadErrorForThread(threadId, '')

    try {
      if (loadedMessagesByThreadId.value[threadId] === true) await coreConversations.refresh(threadId)
      else await coreConversations.connect(threadId)
      if (latestMessageLoadRequestIdByThreadId.get(threadId) !== requestId) {
        return
      }
      const historyError = coreConversations.stateFor(threadId).history.error
      if (historyError) throw new Error(historyError)
      loadedMessagesByThreadId.value = markThreadMessagesLoaded(loadedMessagesByThreadId.value, threadId)

      const version = currentThreadVersion(threadId)
      loadedVersionByThreadId.value = setThreadLoadedVersion(
        loadedVersionByThreadId.value,
        threadId,
        version,
      )
      markThreadAsRead(threadId)
    } catch (unknownError) {
      if (latestMessageLoadRequestIdByThreadId.get(threadId) === requestId) {
        const message = unknownError instanceof Error && unknownError.message
          ? unknownError.message
          : 'Failed to load messages.'
        setMessageLoadErrorForThread(threadId, message)
      }
    } finally {
      if (latestMessageLoadRequestIdByThreadId.get(threadId) === requestId) {
        latestMessageLoadRequestIdByThreadId.delete(threadId)
        setMessagesLoadingForThread(threadId, false)
      }
    }
  }

  async function refreshAll(options: { loadSelectedMessages?: boolean } = {}) {
    error.value = ''

    try {
      await hydrateTurnPreferencesFromSettingsStore()
      await Promise.all([
        loadThreads(),
        refreshModelPreferences(),
        refreshCollaborationModes(),
        refreshRateLimits(),
      ])
      if (options.loadSelectedMessages !== false) {
        await loadMessages(selectedThreadId.value)
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function selectThread(threadId: string) {
    setSelectedThreadId(threadId)

    try {
      await loadMessages(threadId)
    } catch (unknownError) {
      if (selectedThreadId.value === threadId) {
        error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      }
    }
  }

  async function hideThreadById(threadId: string) {
    try {
      await setThreadHidden(threadId, true)
      await loadThreads()
      if (selectedThreadId.value === threadId) setSelectedThreadId(flattenThreads(projectGroups.value)[0]?.id ?? '')
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to hide thread'
    }
  }

  async function restoreThreadById(threadId: string): Promise<void> {
    try {
      await setThreadHidden(threadId, false)
      await loadThreads()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to restore thread'
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    try {
      const forkedThreadId = await forkThread(threadId)
      await loadThreads()
      if (forkedThreadId) {
        setSelectedThreadId(forkedThreadId)
        await loadMessages(forkedThreadId)
      }
      return forkedThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to fork thread'
      return ''
    }
  }

  async function compactThreadById(threadId: string): Promise<void> {
    try {
      setThreadInProgress(threadId, true)
      await compactThread(threadId)
      await coreConversations.refresh(threadId)
      await loadThreads()
    } catch (unknownError) {
      setThreadInProgress(threadId, false)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to compact thread'
      error.value = errorMessage
    }
  }

  async function setHiddenView(nextValue: boolean): Promise<void> {
    if (isHiddenView.value === nextValue) return
    isHiddenView.value = nextValue
    sourceGroups.value = []
    projectGroups.value = []
    loadedMessagesByThreadId.value = {}
    loadingMessagesByThreadId.value = {}
    latestMessageLoadRequestIdByThreadId.clear()
    shouldAutoScrollOnNextAgentEvent = false

    try {
      await loadThreads()
      await loadMessages(selectedThreadId.value)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function renameThreadById(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedTitle = title.trim()
    if (!normalizedThreadId || !normalizedTitle) return

    const previousSourceGroups = sourceGroups.value
    const previousProjectGroups = projectGroups.value
    const previousOptimisticThreads = optimisticThreadById.value

    updateOptimisticThreadTitle(normalizedThreadId, normalizedTitle)
    sourceGroups.value = renameThreadInGroups(sourceGroups.value, normalizedThreadId, normalizedTitle)
    projectGroups.value = renameThreadInGroups(projectGroups.value, normalizedThreadId, normalizedTitle)

    try {
      await renameThread(normalizedThreadId, normalizedTitle)
      await loadThreads()
    } catch (unknownError) {
      optimisticThreadById.value = previousOptimisticThreads
      sourceGroups.value = previousSourceGroups
      projectGroups.value = previousProjectGroups
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rename thread'
      throw unknownError
    }
  }

  async function enqueueMessageForThread(
    threadId: string,
    payload: ComposerSubmission<UiComposerContextKind>,
  ): Promise<PendingConversationCommand | null> {
    const turnInput = normalizeComposerTurnInput(payload)
    if (!threadId || !turnInput.hasContent) return null

    const item = buildPendingConversationCommand({
      threadId,
      payload: {
        text: turnInput.text,
        images: turnInput.images,
        skills: turnInput.skills,
        contexts: payload.contexts,
      },
    })
    // Core owns the optimistic row immediately. Browser storage must never
    // become a second durable queue that can resurrect stale commands after
    // a refresh or service deployment.
    ensureOutboxOptimisticUserMessage(item)
    return item
  }

  async function submitOutboxItem(item: PendingConversationCommand, mode: 'queue' | 'steer'): Promise<void> {
    isSendingMessage.value = true
    error.value = ''
    const modelId = selectedModelId.value.trim()
    const reasoningEffort = selectedReasoningEffort.value
    const collaborationMode = buildTurnCollaborationMode(selectedCollaborationMode.value, modelId, reasoningEffort)
    const permissionOverride = buildTurnPermissionOverride(selectedPermissionMode.value)
    try {
      await coreConversations.submit({
        threadId: item.threadId,
        commandId: item.id,
        text: item.text,
        images: item.images.map((image) => image.url).filter(Boolean),
        skills: item.skills,
        mode,
        turnInput: {
          input: buildTurnInput(item.text, item.images, item.skills),
          ...(modelId ? { model: modelId } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          ...(permissionOverride?.approvalPolicy ? { approvalPolicy: permissionOverride.approvalPolicy } : {}),
          ...(permissionOverride?.sandboxPolicy ? { sandboxPolicy: permissionOverride.sandboxPolicy } : {}),
        },
      })
    } catch (unknownError) {
      const message = unknownError instanceof Error ? unknownError.message : 'Conversation command was not accepted.'
      error.value = message
      throw unknownError
    } finally {
      isSendingMessage.value = false
    }
  }

  async function sendMessageToSelectedThread(
    payload: ComposerSubmission<UiComposerContextKind>,
    options: { onAccepted?: () => void } = {},
  ): Promise<void> {
    const threadId = selectedThreadId.value
    const turnInput = normalizeComposerTurnInput(payload)
    if (!threadId || !turnInput.hasContent) return

    if (resolveComposerSubmitMode(Boolean(coreConversations.stateFor(threadId).activeTurnId), selectedSubmitMode.value) === 'steer') {
      const item = await enqueueMessageForThread(threadId, payload)
      if (!item) return
      options.onAccepted?.()
      await submitOutboxItem(item, 'steer')
      return
    }

    const item = await enqueueMessageForThread(threadId, payload)
    if (!item) return
    options.onAccepted?.()
    await submitOutboxItem(item, 'queue')
  }

  async function sendTextToThreadById(threadId: string, text: string): Promise<void> {
    const turnInput = normalizeThreadTextTurnInput(threadId, text)
    if (!turnInput.threadId || !turnInput.hasContent) return

    if (!allThreads.value.some((thread) => thread.id === turnInput.threadId)) {
      throw new Error('Thread was not found')
    }

    const item = await enqueueMessageForThread(turnInput.threadId, {
      text: turnInput.text,
      images: turnInput.images,
      skills: turnInput.skills,
    })
    if (!item) return
    await submitOutboxItem(item, 'queue')
  }

  async function sendQueuedMessageNow(threadId: string, itemId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedItemId = itemId.trim()
    if (!normalizedThreadId || !normalizedItemId) return

    const failed = coreConversations.stateFor(normalizedThreadId).messages.find((message) => (
      message.id === `user:${normalizedItemId}` && message.role === 'user' && message.outbox?.status === 'failed'
    ))
    if (!failed) return
    const replacement = await enqueueMessageForThread(normalizedThreadId, {
      text: failed.text,
      images: (failed.images ?? []).map((url, index) => {
        const encodedPath = url.startsWith('local-image://') ? url.slice('local-image://'.length) : ''
        let path = url
        if (encodedPath) {
          try { path = decodeURIComponent(encodedPath) } catch { path = encodedPath }
        }
        return { id: `retry-image-${String(index)}`, name: `image-${String(index + 1)}`, path, url, mimeType: 'application/octet-stream' }
      }),
      skills: (failed.skills ?? []).map((skill) => ({ ...skill, description: '', displayName: skill.displayName ?? skill.name })),
    })
    if (!replacement) return
    coreConversations.discard(normalizedThreadId, normalizedItemId)
    await submitOutboxItem(replacement, coreConversations.stateFor(normalizedThreadId).activeTurnId ? 'steer' : 'queue')
  }

  async function deleteQueuedMessage(threadId: string, itemId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedItemId = itemId.trim()
    if (!normalizedThreadId || !normalizedItemId) return
    const message = coreConversations.stateFor(normalizedThreadId).messages.find((row) => row.id === `user:${normalizedItemId}`)
    if (message?.outbox?.status !== 'failed') return
    removeOptimisticUserMessage(normalizedThreadId, normalizedItemId)
  }

  async function sendMessageToNewThread(payload: ComposerSubmission<UiComposerContextKind>, cwd: string): Promise<string> {
    const turnInput = normalizeNewThreadTurnInput(payload, cwd)
    const selectedModel = selectedModelId.value.trim()
    if (!turnInput.hasContent) return ''

    isSendingMessage.value = true
    error.value = ''
    let threadId = ''

    try {
      threadId = await startThread(turnInput.targetCwd || undefined, selectedModel || undefined)
      if (!threadId) return ''

      const createdAtIso = new Date().toISOString()
      setSelectedThreadId(threadId)
      addOptimisticThread({
        id: threadId,
        title: 'Untitled thread',
        projectName: turnInput.targetCwd || 'unknown-project',
        cwd: turnInput.targetCwd,
        createdAtIso,
        updatedAtIso: createdAtIso,
        preview: turnInput.text,
        unread: false,
        inProgress: false,
      })
      void loadThreads().catch(() => undefined)

      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      const item = await enqueueMessageForThread(threadId, payload)
      if (item) void submitOutboxItem(item, 'queue').catch(() => undefined)
      return threadId
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      shouldAutoScrollOnNextAgentEvent = false
      error.value = errorMessage
      throw unknownError
    } finally {
      isSendingMessage.value = false
    }
  }

  async function interruptTurnForThread(threadId: string): Promise<void> {
    if (!threadId) return
    if (!coreConversations.stateFor(threadId).activeTurnId) return

    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId)
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    await interruptTurnForThread(selectedThreadId.value)
  }

  async function interruptThreadTurnById(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    await interruptTurnForThread(normalizedThreadId)
  }

  function renameProject(projectName: string, displayName: string): void {
    const nextDisplayNames = renameProjectDisplayName(projectDisplayNameById.value, projectName, displayName)
    if (nextDisplayNames === projectDisplayNameById.value) return
    projectDisplayNameById.value = nextDisplayNames
    saveProjectDisplayNames(nextDisplayNames)
    void saveCatalogProjectDisplayName(projectName, displayName)
  }

  async function hideProject(projectName: string): Promise<void> {
    if (projectName.length === 0) return
    try {
      await setProjectHidden(projectName, true)
      await loadThreads()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to hide project'
    }
  }

  async function restoreProject(projectName: string): Promise<void> {
    if (!projectName) return
    try {
      const hiddenThreadIds = projectGroups.value
        .find((group) => group.projectName === projectName)
        ?.threads.map((thread) => thread.id) ?? []
      await Promise.all([
        setProjectHidden(projectName, false),
        ...hiddenThreadIds.map((threadId) => setThreadHidden(threadId, false)),
      ])
      await loadThreads()
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to restore project'
    }
  }

  function reorderProject(projectName: string, toIndex: number): void {
    const nextProjectOrder = moveProjectInOrder(projectOrder.value, projectName, toIndex)
    if (nextProjectOrder === projectOrder.value) return

    projectOrder.value = nextProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void saveCatalogProjectOrder(nextProjectOrder)
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<void> {
    await serverRequestState.respond(reply)
  }

  function resetRealtimeDomainState(): void {
    latestMessageLoadRequestIdByThreadId.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    shouldAutoScrollOnNextAgentEvent = false
    loadingMessagesByThreadId.value = {}
    messageLoadErrorByThreadId.value = {}
    stopCoreEventSubscription()
    coreConversations.dispose()
  }

  const realtimeState = useDesktopRealtimeState({
    hydratePreferences: hydrateTurnPreferencesFromSettingsStore,
    loadPendingApprovals: serverRequestState.load,
    refreshRateLimits,
    applyNotification: applyRealtimeUpdates,
    queueNotificationSync: queueEventDrivenSync,
    resetDomainState: resetRealtimeDomainState,
  })
  const { startRealtimeSync, stopRealtimeSync } = realtimeState

  return {
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadScrollState,
    selectedThreadServerRequests,
    selectedThreadContextUsage,
    allPendingServerRequests,
    selectedLiveOverlay,
    selectedStructuredPlan,
    selectedCoreConversation,
    selectedMessageLoadError,
    selectedQueuedMessages,
    selectedThreadId,
    isHiddenView,
    rateLimitSnapshot,
    availableModelIds,
    selectedModelId,
    selectedReasoningEffort,
    selectedPermissionMode,
    selectedSubmitMode,
    collaborationModeOptions,
    selectedCollaborationModeName,
    messages,
    isLoadingThreads,
    isLoadingMessages,
    hasLoadedSelectedMessages,
    isSendingMessage,
    isInterruptingTurn,
    isLoadingRateLimits,
    error,
    clearError,
    refreshAll,
    refreshRateLimits,
    recoverDirectThread,
    selectThread,
    loadMessages,
    setThreadScrollState,
    hideThreadById,
    restoreThreadById,
    forkThreadById,
    compactThreadById,
    setHiddenView,
    renameThreadById,
    sendMessageToSelectedThread,
    sendQueuedMessageNow,
    deleteQueuedMessage,
    sendTextToThreadById,
    sendMessageToNewThread,
    interruptSelectedThreadTurn,
    interruptThreadTurnById,
    setSelectedModelId,
    setSelectedReasoningEffort,
    setSelectedCollaborationModeName,
    setSelectedPermissionMode,
    setSelectedSubmitMode,
    respondToPendingServerRequest,
    recordRollbackAudit,
    renameProject,
    hideProject,
    restoreProject,
    reorderProject,
    startRealtimeSync,
    stopRealtimeSync,
  }
}
