import { computed, ref } from 'vue'
import {
  compactThread,
  forkThread,
  getThreadMessages,
  interruptThreadTurn,
  renameThread,
  resumeThread,
  startThread,
  startThreadTurn,
  steerThreadTurn,
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
  extractThreadIdFromNotification,
  extractTurnIdFromNotification,
  isAgentContentEvent,
  liveReasoningMessageId,
  readAgentMessageCompleted,
  readAgentMessageDelta,
  readAgentMessageStartedId,
  readPlanMessageCompleted,
  readPlanMessageDelta,
  readPlanUpdatedMessage,
  readStructuredPlanUpdate,
  readReasoningCompletedId,
  readReasoningDelta,
  readReasoningSectionBreakMessageId,
  readReasoningStartedItemId,
  readStartedThread,
  readThreadContextUsageUpdate,
  readTurnActivity,
  readTurnCompletedInfo,
  readTurnDurationHints,
  readTurnErrorMessage,
  readTurnStartedInfo,
  readUserMessageCompleted,
  type TurnActivityState,
  type TurnStartedInfo,
} from './realtimeNotificationReaders'
import { useStructuredPlanState } from './useStructuredPlanState'
import { useServerRequestState } from './useServerRequestState'
import { useDesktopComposerState } from './useDesktopComposerState'
import { useDesktopRealtimeState } from './useDesktopRealtimeState'
import { useDesktopThreadState } from './useDesktopThreadState'
import { shouldQueueEventDrivenSyncForMethod } from './realtimeSyncPolicy'
import { useRateLimitState } from './useRateLimitState'
import { dataAuthorityPolicy } from './dataAuthorityPolicy'
import {
  clearDesktopRealtimeSyncQueue,
  consumeDesktopRealtimeSyncQueue,
  createDesktopRealtimeSyncQueue,
  hasPendingDesktopRealtimeSync,
  queueDesktopRealtimeSync,
} from './desktopRealtimeSyncQueue'
import {
  appendLiveReasoningDeltaForThread,
  appendLiveReasoningSectionBreakForThread,
  buildDisplayedMessages,
  buildLiveOverlay,
  buildRollbackAuditMessage,
  clearLiveReasoningTextForThread,
  mergeMessages,
  removeMessageById,
  replaceMessageById,
  removeLivePlanMessagesForTurn,
  removeRedundantLiveAgentMessages,
  updateLiveReasoningTextForThread,
  updateMessagesForThread,
  upsertLiveAssistantDeltaForThread,
  upsertMessage,
  updateTurnActivityState,
  updateTurnErrorState,
  updateTurnSummaryState,
  type TurnErrorState,
  type TurnSummaryState,
} from './desktopMessageState'
import {
  markThreadMessagesLoaded,
  markThreadResumed,
  pruneDesktopThreadScopedState,
  setThreadLoadedVersion,
  shouldShowMessagesLoading,
} from './desktopThreadScopedState'
import {
  buildTurnCollaborationMode,
} from './desktopTurnPreferences'
import { buildTurnPermissionOverride } from './desktopTurnPermissions'
import {
  buildCompletedTurnSummary,
  buildPendingTurnActivity,
  buildSteeringTurnActivity,
  clearActiveTurnForThread,
  normalizeComposerTurnInput,
  normalizeNewThreadTurnInput,
  normalizeThreadTextTurnInput,
  setActiveTurnForThread,
  shouldClearUnreadForStartedTurn,
} from './desktopTurnState'
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
  pruneThreadStateMap,
  reconcileOptimisticThreads,
  renameProjectDisplayName,
  renameThreadInGroups,
  updateThreadBooleanState,
  upsertThreadInGroups,
} from './threadGroupState'
import type {
  UiCollaborationModeOption,
  UiComposerSubmitPayload,
  ThreadScrollState,
  UiMessage,
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
    persistedMessagesByThreadId, liveAgentMessagesByThreadId, liveReasoningTextByThreadId,
    inProgressById, eventUnreadByThreadId, readStateByThreadId, scrollStateByThreadId,
    projectOrder, projectDisplayNameById, loadedVersionByThreadId, loadedMessagesByThreadId,
    resumedThreadById, allThreads, selectedThread, selectedThreadScrollState,
  } = threadState
  const composerState = useDesktopComposerState()
  const { availableModelIds, selectedModelId, selectedReasoningEffort, selectedPermissionMode,
    modelContextWindow, autoCompactTokenLimit,
    collaborationModeOptions, selectedCollaborationModeName, selectedCollaborationMode,
    hydrate: hydrateTurnPreferencesFromSettingsStore, refreshCollaborationModes, refreshModelPreferences,
    setSelectedModelId, setSelectedReasoningEffort, setSelectedCollaborationModeName, setSelectedPermissionMode } = composerState
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const contextUsageByThreadId = ref<Record<string, UiThreadContextUsage>>({})
  const structuredPlanState = useStructuredPlanState(selectedThreadId)
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
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
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)
  let eventSyncTimer: number | null = null
  const realtimeSyncQueue = createDesktopRealtimeSyncQueue()
  const activeReasoningItemIdByThreadId = new Map<string, string>()
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()
  const livePlanMessageIdByTurnId = new Map<string, string>()
  const optimisticUserMessageIdsByTurnId = new Map<string, string[]>()
  const pendingOptimisticUserMessageIdsByThreadId = new Map<string, string[]>()
  const latestMessageLoadRequestIdByThreadId = new Map<string, number>()
  let nextMessageLoadRequestId = 0
  let latestThreadsRequestId = 0
  let nextOptimisticUserMessageId = 0

  const selectedThreadServerRequests = serverRequestState.selected
  const isLoadingMessages = computed(() => loadingMessagesByThreadId.value[selectedThreadId.value] === true)
  const hasLoadedSelectedMessages = computed(
    () => loadedMessagesByThreadId.value[selectedThreadId.value] === true,
  )
  const allPendingServerRequests = serverRequestState.all
  const selectedLiveOverlay = computed(() =>
    buildLiveOverlay(
      selectedThreadId.value,
      turnActivityByThreadId.value,
      liveReasoningTextByThreadId.value,
      turnErrorByThreadId.value,
    ),
  )
  const selectedStructuredPlan = structuredPlanState.selected
  const selectedMessageLoadError = computed(() => messageLoadErrorByThreadId.value[selectedThreadId.value] ?? '')
  const selectedThreadContextUsage = computed<UiThreadContextUsage | null>(() => {
    const usage = contextUsageByThreadId.value[selectedThreadId.value]
    if (!usage) return null
    return {
      ...usage,
      contextWindow: usage.contextWindow ?? modelContextWindow.value,
      autoCompactTokenLimit: usage.autoCompactTokenLimit ?? autoCompactTokenLimit.value,
    }
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    return buildDisplayedMessages(persisted, liveAgent, turnSummaryByThreadId.value[threadId])
  })

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
    const pruned = pruneDesktopThreadScopedState({
      readStateByThreadId: readStateByThreadId.value,
      scrollStateByThreadId: scrollStateByThreadId.value,
      loadedMessagesByThreadId: loadedMessagesByThreadId.value,
      loadedVersionByThreadId: loadedVersionByThreadId.value,
      resumedThreadById: resumedThreadById.value,
      persistedMessagesByThreadId: persistedMessagesByThreadId.value,
      liveAgentMessagesByThreadId: liveAgentMessagesByThreadId.value,
      liveReasoningTextByThreadId: liveReasoningTextByThreadId.value,
      turnSummaryByThreadId: turnSummaryByThreadId.value,
      turnActivityByThreadId: turnActivityByThreadId.value,
      turnErrorByThreadId: turnErrorByThreadId.value,
      activeTurnIdByThreadId: activeTurnIdByThreadId.value,
      eventUnreadByThreadId: eventUnreadByThreadId.value,
      inProgressById: inProgressById.value,
      pendingServerRequestsByThreadId: pendingServerRequestsByThreadId.value,
    }, activeThreadIds)

    if (pruned.readStateByThreadId !== readStateByThreadId.value) {
      readStateByThreadId.value = pruned.readStateByThreadId
      saveReadStateMap(pruned.readStateByThreadId)
    }
    if (pruned.scrollStateByThreadId !== scrollStateByThreadId.value) {
      scrollStateByThreadId.value = pruned.scrollStateByThreadId
      saveThreadScrollStateMap(pruned.scrollStateByThreadId)
    }
    loadedMessagesByThreadId.value = pruned.loadedMessagesByThreadId
    loadedVersionByThreadId.value = pruned.loadedVersionByThreadId
    resumedThreadById.value = pruned.resumedThreadById
    persistedMessagesByThreadId.value = pruned.persistedMessagesByThreadId
    liveAgentMessagesByThreadId.value = pruned.liveAgentMessagesByThreadId
    liveReasoningTextByThreadId.value = pruned.liveReasoningTextByThreadId
    turnSummaryByThreadId.value = pruned.turnSummaryByThreadId
    turnActivityByThreadId.value = pruned.turnActivityByThreadId
    turnErrorByThreadId.value = pruned.turnErrorByThreadId
    messageLoadErrorByThreadId.value = Object.fromEntries(
      Object.entries(messageLoadErrorByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    activeTurnIdByThreadId.value = pruned.activeTurnIdByThreadId
    eventUnreadByThreadId.value = pruned.eventUnreadByThreadId
    inProgressById.value = pruned.inProgressById
    pendingServerRequestsByThreadId.value = pruned.pendingServerRequestsByThreadId
    contextUsageByThreadId.value = pruneThreadStateMap(contextUsageByThreadId.value, activeThreadIds)
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

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    const nextState = updateTurnSummaryState(turnSummaryByThreadId.value, threadId, summary)
    if (nextState !== turnSummaryByThreadId.value) {
      turnSummaryByThreadId.value = nextState
    }
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    const nextState = updateThreadBooleanState(inProgressById.value, threadId, nextInProgress)
    if (nextState === inProgressById.value) return
    inProgressById.value = nextState
    applyThreadFlags()
  }

  function markThreadUnreadByEvent(threadId: string): void {
    const nextState = markThreadUnreadState(eventUnreadByThreadId.value, threadId, selectedThreadId.value)
    if (nextState !== eventUnreadByThreadId.value) {
      eventUnreadByThreadId.value = nextState
      applyThreadFlags()
    }
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    const nextState = updateTurnActivityState(turnActivityByThreadId.value, threadId, activity)
    if (nextState !== turnActivityByThreadId.value) {
      turnActivityByThreadId.value = nextState
    }
  }

  function setTurnErrorForThread(threadId: string, message: string | null): void {
    const nextState = updateTurnErrorState(turnErrorByThreadId.value, threadId, message)
    if (nextState !== turnErrorByThreadId.value) {
      turnErrorByThreadId.value = nextState
    }
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadScrollState(threadId: string, nextState: ThreadScrollState): void {
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

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    persistedMessagesByThreadId.value = updateMessagesForThread(
      persistedMessagesByThreadId.value,
      threadId,
      nextMessages,
    )
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    liveAgentMessagesByThreadId.value = updateMessagesForThread(
      liveAgentMessagesByThreadId.value,
      threadId,
      nextMessages,
    )
  }

  function recordRollbackAudit(result: UiToolingRollbackFileResult): void {
    const threadId = selectedThreadId.value
    if (!threadId) return

    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    setPersistedMessagesForThread(threadId, upsertMessage(previous, buildRollbackAuditMessage(result)))
  }

  function addOptimisticUserMessage(
    threadId: string,
    turnInput: {
      text: string
      images: UiComposerSubmitPayload['images']
      skills: UiComposerSubmitPayload['skills']
    },
  ): string {
    if (!threadId) return ''

    nextOptimisticUserMessageId += 1
    const messageId = `optimistic-user:${threadId}:${String(nextOptimisticUserMessageId)}`
    const message: UiMessage = {
      id: messageId,
      role: 'user',
      text: turnInput.text,
      images: turnInput.images.map((image) => image.url).filter((url) => url.trim().length > 0),
      skills: turnInput.skills,
      messageType: 'userMessage.optimistic',
    }
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    setPersistedMessagesForThread(threadId, upsertMessage(previous, message))
    pendingOptimisticUserMessageIdsByThreadId.set(threadId, [
      ...(pendingOptimisticUserMessageIdsByThreadId.get(threadId) ?? []),
      messageId,
    ])
    return messageId
  }

  function bindOptimisticUserMessageToTurn(threadId: string, turnId: string, messageId: string): void {
    if (!turnId || !(persistedMessagesByThreadId.value[threadId] ?? []).some((message) => message.id === messageId)) return
    const pending = pendingOptimisticUserMessageIdsByThreadId.get(threadId) ?? []
    pendingOptimisticUserMessageIdsByThreadId.set(threadId, pending.filter((id) => id !== messageId))
    optimisticUserMessageIdsByTurnId.set(turnId, [...(optimisticUserMessageIdsByTurnId.get(turnId) ?? []), messageId])
    while (optimisticUserMessageIdsByTurnId.size > 1_000) {
      const oldestTurnId = optimisticUserMessageIdsByTurnId.keys().next().value as string | undefined
      if (!oldestTurnId) break
      optimisticUserMessageIdsByTurnId.delete(oldestTurnId)
    }
  }

  function consumeOptimisticUserMessageId(threadId: string, turnId: string): string {
    const turnQueue = turnId ? optimisticUserMessageIdsByTurnId.get(turnId) ?? [] : []
    const messageId = turnQueue[0] ?? ''
    if (!messageId) return ''
    if (turnQueue.length > 0) {
      const remaining = turnQueue.slice(1)
      if (remaining.length > 0) optimisticUserMessageIdsByTurnId.set(turnId, remaining)
      else optimisticUserMessageIdsByTurnId.delete(turnId)
    }
    const pending = pendingOptimisticUserMessageIdsByThreadId.get(threadId) ?? []
    const remainingPending = pending.filter((id) => id !== messageId)
    if (remainingPending.length > 0) pendingOptimisticUserMessageIdsByThreadId.set(threadId, remainingPending)
    else pendingOptimisticUserMessageIdsByThreadId.delete(threadId)
    return messageId
  }

  function removeOptimisticUserMessage(threadId: string, messageId: string): void {
    if (!threadId || !messageId) return
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    setPersistedMessagesForThread(threadId, removeMessageById(previous, messageId))
    const pending = pendingOptimisticUserMessageIdsByThreadId.get(threadId) ?? []
    const nextPending = pending.filter((id) => id !== messageId)
    if (nextPending.length > 0) pendingOptimisticUserMessageIdsByThreadId.set(threadId, nextPending)
    else pendingOptimisticUserMessageIdsByThreadId.delete(threadId)
    for (const [turnId, ids] of optimisticUserMessageIdsByTurnId) {
      const nextIds = ids.filter((id) => id !== messageId)
      if (nextIds.length > 0) optimisticUserMessageIdsByTurnId.set(turnId, nextIds)
      else optimisticUserMessageIdsByTurnId.delete(turnId)
    }
  }

  function beginPendingTurnForThread(
    threadId: string,
    mode: UiCollaborationModeOption = selectedCollaborationMode.value,
  ): void {
    shouldAutoScrollOnNextAgentEvent = true
    setTurnSummaryForThread(threadId, null)
    setTurnActivityForThread(
      threadId,
      buildPendingTurnActivity({
        modelId: selectedModelId.value,
        reasoningEffort: selectedReasoningEffort.value,
        mode,
      }),
    )
    setTurnErrorForThread(threadId, null)
    setThreadInProgress(threadId, true)
  }

  function failPendingTurnForThread(
    threadId: string,
    unknownError: unknown,
    fallbackMessage: string,
  ): Error {
    shouldAutoScrollOnNextAgentEvent = false
    setThreadInProgress(threadId, false)
    setTurnActivityForThread(threadId, null)
    const errorMessage = unknownError instanceof Error ? unknownError.message : fallbackMessage
    setTurnErrorForThread(threadId, errorMessage)
    error.value = errorMessage
    return unknownError instanceof Error ? unknownError : new Error(errorMessage)
  }

  function beginSteeringTurnForThread(threadId: string): void {
    shouldAutoScrollOnNextAgentEvent = true
    setTurnActivityForThread(
      threadId,
      buildSteeringTurnActivity({
        modelId: selectedModelId.value,
        reasoningEffort: selectedReasoningEffort.value,
      }),
    )
    setTurnErrorForThread(threadId, null)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveAgentMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    liveReasoningTextByThreadId.value = updateLiveReasoningTextForThread(
      liveReasoningTextByThreadId.value,
      threadId,
      text,
    )
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    liveReasoningTextByThreadId.value = appendLiveReasoningDeltaForThread(
      liveReasoningTextByThreadId.value,
      threadId,
      delta,
    )
  }

  function clearLiveReasoningForThread(threadId: string): void {
    liveReasoningTextByThreadId.value = clearLiveReasoningTextForThread(
      liveReasoningTextByThreadId.value,
      threadId,
    )
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
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

    const contextUsageUpdate = readThreadContextUsageUpdate(notification)
    if (contextUsageUpdate) {
      const previous = contextUsageByThreadId.value[contextUsageUpdate.threadId]
      contextUsageByThreadId.value = {
        ...contextUsageByThreadId.value,
        [contextUsageUpdate.threadId]: {
          ...contextUsageUpdate,
          contextWindow:
            contextUsageUpdate.contextWindow ??
            previous?.contextWindow ??
            modelContextWindow.value,
          autoCompactTokenLimit:
            previous?.autoCompactTokenLimit ??
            autoCompactTokenLimit.value,
        },
      }
    }

    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn) {
      const pendingOptimisticId = (pendingOptimisticUserMessageIdsByThreadId.get(startedTurn.threadId) ?? [])[0]
      if (pendingOptimisticId) bindOptimisticUserMessageToTurn(startedTurn.threadId, startedTurn.turnId, pendingOptimisticId)
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      activeTurnIdByThreadId.value = setActiveTurnForThread(
        activeTurnIdByThreadId.value,
        startedTurn.threadId,
        startedTurn.turnId,
      )
      setTurnSummaryForThread(startedTurn.threadId, null)
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      structuredPlanState.clear(startedTurn.threadId)
      if (shouldClearUnreadForStartedTurn(eventUnreadByThreadId.value, startedTurn)) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = readTurnCompletedInfo(notification)
    if (completedTurn) {
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const durationHints = readTurnDurationHints(notification)
      setTurnSummaryForThread(completedTurn.threadId, buildCompletedTurnSummary({
        completedTurn,
        startedTurn: startedTurnState,
        explicitDurationMs: durationHints.explicitDurationMs,
        turnDurationMs: durationHints.turnDurationMs,
      }))
      setLiveAgentMessagesForThread(
        completedTurn.threadId,
        removeLivePlanMessagesForTurn(
          liveAgentMessagesByThreadId.value[completedTurn.threadId] ?? [],
          completedTurn.turnId,
          livePlanMessageIdByTurnId.get(completedTurn.turnId),
        ),
      )
      activeTurnIdByThreadId.value = clearActiveTurnForThread(
        activeTurnIdByThreadId.value,
        completedTurn.threadId,
      )
      livePlanMessageIdByTurnId.delete(completedTurn.turnId)
      setThreadInProgress(completedTurn.threadId, false)
      setTurnActivityForThread(completedTurn.threadId, null)
      markThreadUnreadByEvent(completedTurn.threadId)
      structuredPlanState.end(completedTurn.threadId, completedTurn.turnId)
    }

    const turnErrorMessage = readTurnErrorMessage(notification)
    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (failedThreadId) {
        setTurnErrorForThread(failedThreadId, turnErrorMessage)
      }
      error.value = turnErrorMessage
    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    if (notification.method === 'thread/compacted') {
      const compactedThreadId = extractThreadIdFromNotification(notification)
      if (compactedThreadId) {
        const previousUsage = contextUsageByThreadId.value[compactedThreadId]
        contextUsageByThreadId.value = {
          ...contextUsageByThreadId.value,
          [compactedThreadId]: {
            threadId: compactedThreadId,
            turnId: previousUsage?.turnId ?? '',
            usedTokens: previousUsage?.usedTokens ?? 0,
            inputTokens: previousUsage?.inputTokens ?? 0,
            contextWindow: previousUsage?.contextWindow ?? modelContextWindow.value,
            autoCompactTokenLimit:
              previousUsage?.autoCompactTokenLimit ??
              autoCompactTokenLimit.value,
            updatedAtIso: notification.atIso || new Date().toISOString(),
            compactionState: 'compacted',
          },
        }
        setThreadInProgress(compactedThreadId, false)
        setTurnActivityForThread(compactedThreadId, null)
        setTurnErrorForThread(compactedThreadId, null)
      }
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    if (!notificationThreadId) return
    const isSelectedNotificationThread = notificationThreadId === selectedThreadId.value

    const completedUserMessages = readUserMessageCompleted(notification)
    if (completedUserMessages.length > 0) {
      const previousMessages = persistedMessagesByThreadId.value[notificationThreadId] ?? []
      const formalUserMessage = completedUserMessages.find((message) => message.role === 'user' && message.messageType === 'userMessage')
      const optimisticMessageId = formalUserMessage
        ? consumeOptimisticUserMessageId(notificationThreadId, extractTurnIdFromNotification(notification))
        : ''
      const messagesWithFormalUser = formalUserMessage && optimisticMessageId
        ? replaceMessageById(previousMessages, optimisticMessageId, formalUserMessage)
        : previousMessages
      setPersistedMessagesForThread(
        notificationThreadId,
        mergeMessages(messagesWithFormalUser, completedUserMessages, { preserveMissing: true }),
      )
    }

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta && dataAuthorityPolicy(notification.method)?.realtimeMode === 'apply-overlay') {
      liveAgentMessagesByThreadId.value = upsertLiveAssistantDeltaForThread(
        liveAgentMessagesByThreadId.value,
        notificationThreadId,
        {
          messageId: liveAgentMessageDelta.messageId,
          textDelta: liveAgentMessageDelta.delta,
          messageType: 'agentMessage.live',
          turnId: liveAgentMessageDelta.turnId,
        },
      )
    }

    const completedAgentMessage = readAgentMessageCompleted(notification)
    if (completedAgentMessage) {
      upsertLiveAgentMessage(notificationThreadId, completedAgentMessage)
    }

    const livePlanMessageDelta = readPlanMessageDelta(notification)
    if (livePlanMessageDelta) {
      if (livePlanMessageDelta.turnId) {
        livePlanMessageIdByTurnId.set(livePlanMessageDelta.turnId, livePlanMessageDelta.messageId)
      }
      liveAgentMessagesByThreadId.value = upsertLiveAssistantDeltaForThread(
        liveAgentMessagesByThreadId.value,
        notificationThreadId,
        {
          messageId: livePlanMessageDelta.messageId,
          textDelta: livePlanMessageDelta.delta,
          messageType: 'plan.live',
          turnId: livePlanMessageDelta.turnId,
        },
      )
    }

    const updatedPlanMessage = readPlanUpdatedMessage(
      notification,
      (turnId) => livePlanMessageIdByTurnId.get(turnId),
    )
    if (updatedPlanMessage) {
      upsertLiveAgentMessage(notificationThreadId, updatedPlanMessage)
    }
    const structuredPlanUpdate = readStructuredPlanUpdate(notification)
    if (structuredPlanUpdate && dataAuthorityPolicy(notification.method)?.realtimeMode === 'replace-snapshot') {
      structuredPlanState.apply(structuredPlanUpdate)
    }

    const completedPlanMessage = readPlanMessageCompleted(notification)
    if (completedPlanMessage) {
      upsertLiveAgentMessage(notificationThreadId, completedPlanMessage)
    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      activeReasoningItemIdByThreadId.set(notificationThreadId, startedReasoningItemId)
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      liveReasoningTextByThreadId.value = appendLiveReasoningSectionBreakForThread(
        liveReasoningTextByThreadId.value,
        notificationThreadId,
      )
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      const activeReasoningItemId = activeReasoningItemIdByThreadId.get(notificationThreadId) ?? ''
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemId)) {
        activeReasoningItemIdByThreadId.delete(notificationThreadId)
      }
    }

    if (isAgentContentEvent(notification)) {
      if (isSelectedNotificationThread && shouldAutoScrollOnNextAgentEvent && selectedThreadId.value) {
        setThreadScrollState(selectedThreadId.value, {
          scrollTop: 0,
          isAtBottom: true,
          scrollRatio: 1,
        })
      }
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
      clearLiveReasoningForThread(notificationThreadId)
    }

    if (notification.method === 'turn/completed') {
      activeReasoningItemIdByThreadId.delete(notificationThreadId)
      if (isSelectedNotificationThread) {
        shouldAutoScrollOnNextAgentEvent = false
      }
      clearLiveReasoningForThread(notificationThreadId)
    }

  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (!shouldQueueEventDrivenSyncForMethod(notification.method)) return

    const threadId = extractThreadIdFromNotification(notification)
    queueDesktopRealtimeSync(realtimeSyncQueue, threadId || undefined)

    if (eventSyncTimer !== null || typeof window === 'undefined') return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
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

      const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

      if (!currentExists) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      if (requestId === latestThreadsRequestId) isLoadingThreads.value = false
    }
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
      if (resumedThreadById.value[threadId] !== true) {
        await resumeThread(threadId)
        resumedThreadById.value = markThreadResumed(resumedThreadById.value, threadId)
      }

      const nextMessages = await getThreadMessages(threadId)
      if (latestMessageLoadRequestIdByThreadId.get(threadId) !== requestId) {
        return
      }
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
        preserveMissing: options.silent === true,
      })
      setPersistedMessagesForThread(threadId, mergedMessages)

      const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
      const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
      setLiveAgentMessagesForThread(threadId, nextLiveAgent)

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
      const previousUsage = contextUsageByThreadId.value[threadId]
      contextUsageByThreadId.value = {
        ...contextUsageByThreadId.value,
        [threadId]: {
          threadId,
          turnId: previousUsage?.turnId ?? '',
          usedTokens: previousUsage?.usedTokens ?? 0,
          inputTokens: previousUsage?.inputTokens ?? 0,
          contextWindow: previousUsage?.contextWindow ?? modelContextWindow.value,
          autoCompactTokenLimit:
            previousUsage?.autoCompactTokenLimit ??
            autoCompactTokenLimit.value,
          updatedAtIso: new Date().toISOString(),
          compactionState: 'compacting',
        },
      }
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, { label: 'Compacting context', details: [] })
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      await compactThread(threadId)
      queueDesktopRealtimeSync(realtimeSyncQueue, threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      const previousUsage = contextUsageByThreadId.value[threadId]
      if (previousUsage) {
        contextUsageByThreadId.value = {
          ...contextUsageByThreadId.value,
          [threadId]: { ...previousUsage, compactionState: 'idle' },
        }
      }
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to compact thread'
      setTurnErrorForThread(threadId, errorMessage)
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
    persistedMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    activeReasoningItemIdByThreadId.clear()
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

  async function sendMessageToSelectedThread(payload: UiComposerSubmitPayload): Promise<void> {
    const threadId = selectedThreadId.value
    const turnInput = normalizeComposerTurnInput(payload)
    if (!threadId || !turnInput.hasContent) return

    if (inProgressById.value[threadId] === true) {
      await steerActiveTurn(threadId, turnInput.text, turnInput.images, turnInput.skills)
      return
    }

    isSendingMessage.value = true
    error.value = ''
    beginPendingTurnForThread(threadId)
    const optimisticMessageId = addOptimisticUserMessage(threadId, turnInput)

    try {
      const turnId = await startTurnForThread(threadId, turnInput.text, turnInput.images, turnInput.skills)
      bindOptimisticUserMessageToTurn(threadId, turnId, optimisticMessageId)
    } catch (unknownError) {
      removeOptimisticUserMessage(threadId, optimisticMessageId)
      throw failPendingTurnForThread(threadId, unknownError, 'Unknown application error')
    } finally {
      isSendingMessage.value = false
    }
  }

  async function sendTextToThreadById(threadId: string, text: string): Promise<void> {
    const turnInput = normalizeThreadTextTurnInput(threadId, text)
    if (!turnInput.threadId || !turnInput.hasContent) return

    if (!allThreads.value.some((thread) => thread.id === turnInput.threadId)) {
      throw new Error('Thread was not found')
    }

    if (inProgressById.value[turnInput.threadId] === true) {
      await steerActiveTurn(turnInput.threadId, turnInput.text, turnInput.images, turnInput.skills)
      return
    }

    isSendingMessage.value = true
    error.value = ''
    beginPendingTurnForThread(turnInput.threadId)
    const optimisticMessageId = addOptimisticUserMessage(turnInput.threadId, turnInput)

    try {
      const turnId = await startTurnForThread(turnInput.threadId, turnInput.text, turnInput.images, turnInput.skills)
      bindOptimisticUserMessageToTurn(turnInput.threadId, turnId, optimisticMessageId)
    } catch (unknownError) {
      removeOptimisticUserMessage(turnInput.threadId, optimisticMessageId)
      throw failPendingTurnForThread(turnInput.threadId, unknownError, 'Unknown application error')
    } finally {
      isSendingMessage.value = false
    }
  }

  async function steerActiveTurn(
    threadId: string,
    nextText: string,
    nextImages: UiComposerSubmitPayload['images'],
    nextSkills: UiComposerSubmitPayload['skills'],
  ): Promise<void> {
    const turnId = activeTurnIdByThreadId.value[threadId]
    if (!turnId) {
      const errorMessage = 'The current turn is still starting. Wait a moment and try again.'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw new Error(errorMessage)
    }

    isSendingMessage.value = true
    error.value = ''
    beginSteeringTurnForThread(threadId)
    const optimisticMessageId = addOptimisticUserMessage(threadId, {
      text: nextText,
      images: nextImages,
      skills: nextSkills,
    })

    try {
      bindOptimisticUserMessageToTurn(threadId, turnId, optimisticMessageId)
      await steerThreadTurn(threadId, turnId, nextText, nextImages, nextSkills)
      queueDesktopRealtimeSync(realtimeSyncQueue, threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      removeOptimisticUserMessage(threadId, optimisticMessageId)
      shouldAutoScrollOnNextAgentEvent = false
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to steer active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    } finally {
      isSendingMessage.value = false
    }
  }

  async function sendMessageToNewThread(payload: UiComposerSubmitPayload, cwd: string): Promise<string> {
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
      setThreadInProgress(threadId, true)

      void loadThreads().catch(() => {
        queueDesktopRealtimeSync(realtimeSyncQueue)
      })

      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      beginPendingTurnForThread(threadId)
      const optimisticMessageId = addOptimisticUserMessage(threadId, turnInput)

      void startTurnForThread(threadId, turnInput.text, turnInput.images, turnInput.skills)
        .then((turnId) => bindOptimisticUserMessageToTurn(threadId, turnId, optimisticMessageId))
        .catch((unknownError) => {
          removeOptimisticUserMessage(threadId, optimisticMessageId)
          failPendingTurnForThread(threadId, unknownError, 'Unknown application error')
        })
      return threadId
    } catch (unknownError) {
      if (threadId) {
        throw failPendingTurnForThread(threadId, unknownError, 'Unknown application error')
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      shouldAutoScrollOnNextAgentEvent = false
      error.value = errorMessage
      throw unknownError
    } finally {
      isSendingMessage.value = false
    }
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    nextImages: UiComposerSubmitPayload['images'],
    nextSkills: UiComposerSubmitPayload['skills'],
  ): Promise<string> {
    const modelId = selectedModelId.value.trim()
    const reasoningEffort = selectedReasoningEffort.value
    const collaborationMode = buildTurnCollaborationMode(
      selectedCollaborationMode.value,
      modelId,
      reasoningEffort,
    )
    const permissionOverride = buildTurnPermissionOverride(selectedPermissionMode.value)

    try {
      if (resumedThreadById.value[threadId] !== true) {
        await resumeThread(threadId)
      }

      const turnId = permissionOverride
        ? await startThreadTurn(
          threadId,
          nextText,
          nextImages,
          nextSkills,
          modelId || undefined,
          reasoningEffort || undefined,
          collaborationMode,
          permissionOverride,
        )
        : await startThreadTurn(
          threadId,
          nextText,
          nextImages,
          nextSkills,
          modelId || undefined,
          reasoningEffort || undefined,
          collaborationMode,
        )
      activeTurnIdByThreadId.value = setActiveTurnForThread(
        activeTurnIdByThreadId.value,
        threadId,
        turnId,
      )

      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }

      queueDesktopRealtimeSync(realtimeSyncQueue, threadId)
      await syncFromNotifications()
      return turnId
    } catch (unknownError) {
      throw unknownError
    }
  }

  async function interruptTurnForThread(threadId: string): Promise<void> {
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) return
    const turnId = activeTurnIdByThreadId.value[threadId]
    if (!turnId) {
      const errorMessage = 'The current turn is still starting. Wait a moment before interrupting.'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      return
    }

    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId, turnId)
      setThreadInProgress(threadId, false)
      setTurnActivityForThread(threadId, null)
      setTurnErrorForThread(threadId, null)
      activeTurnIdByThreadId.value = clearActiveTurnForThread(activeTurnIdByThreadId.value, threadId)
      queueDesktopRealtimeSync(realtimeSyncQueue, threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
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

  async function syncThreadStatus(): Promise<void> {
    if (isPolling.value) return
    isPolling.value = true

    try {
      await loadThreads()

      if (!selectedThreadId.value) return

      const threadId = selectedThreadId.value
      const currentVersion = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
      const isInProgress = inProgressById.value[threadId] === true

      if (isInProgress || hasVersionChange) {
        await loadMessages(threadId, { silent: true })
      }
    } catch {
      // ignore poll failures and keep last known state
    } finally {
      isPolling.value = false
    }
  }

  async function syncFromNotifications(): Promise<void> {
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true

    const syncBatch = consumeDesktopRealtimeSyncQueue(realtimeSyncQueue)
    const shouldRefreshThreads = syncBatch.shouldRefreshThreads
    const threadIdsToRefresh = syncBatch.threadIdsToRefresh

    try {
      if (shouldRefreshThreads) {
        await loadThreads()
      }

      const activeThreadId = selectedThreadId.value
      if (!activeThreadId) return

      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const isInProgress = inProgressById.value[activeThreadId] === true
      const currentVersion = currentThreadVersion(activeThreadId)
      const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      if (isActiveDirty || isInProgress || hasVersionChange || shouldRefreshThreads) {
        await loadMessages(activeThreadId, { silent: true })
      }
    } catch {
      // Keep UI stable on transient event sync failures.
    } finally {
      isPolling.value = false

      if (
        hasPendingDesktopRealtimeSync(realtimeSyncQueue) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<void> {
    await serverRequestState.respond(reply)
  }

  function resetRealtimeDomainState(): void {
    clearDesktopRealtimeSyncQueue(realtimeSyncQueue)
    pendingTurnStartsById.clear()
    livePlanMessageIdByTurnId.clear()
    latestMessageLoadRequestIdByThreadId.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    activeReasoningItemIdByThreadId.clear()
    shouldAutoScrollOnNextAgentEvent = false
    loadingMessagesByThreadId.value = {}
    persistedMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveReasoningTextByThreadId.value = {}
    turnActivityByThreadId.value = {}
    contextUsageByThreadId.value = {}
    structuredPlanState.reset()
    turnSummaryByThreadId.value = {}
    turnErrorByThreadId.value = {}
    messageLoadErrorByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
  }

  const realtimeState = useDesktopRealtimeState({
    hydratePreferences: hydrateTurnPreferencesFromSettingsStore,
    loadPendingApprovals: serverRequestState.load,
    refreshRateLimits,
    applyNotification: applyRealtimeUpdates,
    queueNotificationSync: queueEventDrivenSync,
    syncThreadStatus,
    resetDomainState: resetRealtimeDomainState,
  })
  const { isAutoRefreshEnabled, autoRefreshSecondsLeft, toggleAutoRefreshTimer, startRealtimeSync, stopRealtimeSync } = realtimeState

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
    selectedMessageLoadError,
    selectedThreadId,
    isHiddenView,
    rateLimitSnapshot,
    availableModelIds,
    selectedModelId,
    selectedReasoningEffort,
    selectedPermissionMode,
    collaborationModeOptions,
    selectedCollaborationModeName,
    messages,
    isLoadingThreads,
    isLoadingMessages,
    hasLoadedSelectedMessages,
    isSendingMessage,
    isInterruptingTurn,
    isLoadingRateLimits,
    isAutoRefreshEnabled,
    autoRefreshSecondsLeft,
    error,
    clearError,
    refreshAll,
    refreshRateLimits,
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
    sendTextToThreadById,
    sendMessageToNewThread,
    interruptSelectedThreadTurn,
    interruptThreadTurnById,
    setSelectedModelId,
    setSelectedReasoningEffort,
    setSelectedCollaborationModeName,
    setSelectedPermissionMode,
    respondToPendingServerRequest,
    recordRollbackAudit,
    renameProject,
    hideProject,
    restoreProject,
    reorderProject,
    toggleAutoRefreshTimer,
    startRealtimeSync,
    stopRealtimeSync,
  }
}
