import { computed, ref } from 'vue'
import {
  buildTurnCollaborationMode,
  resolveComposerSubmitMode,
  type ComposerCollaborationModeOption,
  type ComposerSubmission,
} from '@codycodeagent/cody-web-core/composer'
import {
  conversationFeedFromState,
  conversationLiveOverlayFromState,
  conversationOverlayMessagesFromState,
  conversationStateFromRegistry,
  latestTerminalTurnEvent,
  pruneConversationStateRegistry,
  reduceConversationRegistryEvents,
  type CodexEvent,
  type ConversationScrollState,
  type ConversationStateRegistry,
} from '@codycodeagent/cody-web-core/conversation'
import {
  compactThread,
  forkThread,
  getThreadMessagesPage,
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
  normalizeRealtimeNotification,
  readStartedThread,
  readUserMessageCompleted,
} from './realtimeNotificationReaders'
import { useServerRequestState } from './useServerRequestState'
import { useDesktopComposerState } from './useDesktopComposerState'
import { useDesktopRealtimeState } from './useDesktopRealtimeState'
import { useDesktopThreadState } from './useDesktopThreadState'
import type { DesktopPlanState } from './desktopPlanState'
import { shouldQueueEventDrivenSyncForMethod } from './realtimeSyncPolicy'
import { useRateLimitState } from './useRateLimitState'
import {
  clearDesktopRealtimeSyncQueue,
  consumeDesktopRealtimeSyncQueue,
  createDesktopRealtimeSyncQueue,
  hasPendingDesktopRealtimeSync,
  queueDesktopRealtimeSync,
} from './desktopRealtimeSyncQueue'
import {
  buildDisplayedMessages,
  buildLiveOverlay,
  buildRollbackAuditMessage,
  mergeMessages,
  removeMessageById,
  replaceMessageById,
  removeRedundantLiveAgentMessages,
  updateMessagesForThread,
  upsertMessage,
  updateTurnActivityState,
  updateTurnErrorState,
  type TurnActivityState,
  type TurnErrorState,
  type TurnSummaryState,
} from './desktopMessageState'
import {
  markThreadMessagesLoaded,
  pruneDesktopThreadScopedState,
  setThreadLoadedVersion,
  shouldShowMessagesLoading,
} from './desktopThreadScopedState'
import { buildTurnPermissionOverride } from './desktopTurnPermissions'
import {
  buildPendingTurnActivity,
  buildSteeringTurnActivity,
  normalizeComposerTurnInput,
  normalizeNewThreadTurnInput,
  normalizeThreadTextTurnInput,
} from './desktopTurnState'
import {
  buildLocalMessageOutboxItem,
  deleteLocalMessageOutboxItem,
  loadLocalMessageOutboxItems,
  saveLocalMessageOutboxItem,
  type LocalMessageOutboxItem,
} from './localMessageOutbox'
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
    persistedMessagesByThreadId,
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
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const outboxItemsByThreadId = ref<Record<string, LocalMessageOutboxItem[]>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const conversationStateByThreadId = ref<ConversationStateRegistry>({})
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
  const loadingEarlierMessagesByThreadId = ref<Record<string, boolean>>({})
  const messageLoadErrorByThreadId = ref<Record<string, string>>({})
  const messagePageByThreadId = ref<Record<string, {
    total: number
    nextOffset: number
    nextBeforeMessageId: string | null
    remainingBefore: number
    hasMoreBefore: boolean
  }>>({})
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)
  let eventSyncTimer: number | null = null
  const realtimeSyncQueue = createDesktopRealtimeSyncQueue()
  let shouldAutoScrollOnNextAgentEvent = false
  let localCoreEventSequence = 0
  const optimisticUserMessageIdsByTurnId = new Map<string, string[]>()
  const pendingOptimisticUserMessageIdsByThreadId = new Map<string, string[]>()
  const latestMessageLoadRequestIdByThreadId = new Map<string, number>()
  let nextMessageLoadRequestId = 0
  let latestThreadsRequestId = 0
  let nextOptimisticUserMessageId = 0
  let hasHydratedOutbox = false
  const drainingOutboxThreadIds = new Set<string>()
  const outboxRetryTimersByThreadId = new Map<string, number>()

  const selectedThreadServerRequests = serverRequestState.selected
  const selectedCoreConversation = computed(() => (
    conversationStateFromRegistry(conversationStateByThreadId.value, selectedThreadId.value)
  ))
  const isLoadingMessages = computed(() => loadingMessagesByThreadId.value[selectedThreadId.value] === true)
  const isLoadingEarlierMessages = computed(() => loadingEarlierMessagesByThreadId.value[selectedThreadId.value] === true)
  const selectedThreadHasMoreMessagesBefore = computed(() => messagePageByThreadId.value[selectedThreadId.value]?.hasMoreBefore === true)
  const selectedThreadEarlierMessageCount = computed(() => {
    const page = messagePageByThreadId.value[selectedThreadId.value]
    if (!page?.hasMoreBefore) return 0
    return Math.max(page.remainingBefore, 1)
  })
  const hasLoadedSelectedMessages = computed(
    () => loadedMessagesByThreadId.value[selectedThreadId.value] === true,
  )
  const allPendingServerRequests = serverRequestState.all
  const selectedLiveOverlay = computed(() => {
    const coreOverlay = conversationLiveOverlayFromState(selectedCoreConversation.value)
    const localOverlay = buildLiveOverlay(
      selectedThreadId.value,
      turnActivityByThreadId.value,
      turnErrorByThreadId.value,
    )
    if (!coreOverlay) return localOverlay
    if (!localOverlay) return coreOverlay
    return {
      activityLabel: coreOverlay.activityLabel || localOverlay.activityLabel,
      activityDetails: coreOverlay.activityDetails.length ? coreOverlay.activityDetails : localOverlay.activityDetails,
      reasoningText: coreOverlay.reasoningText || localOverlay.reasoningText,
      errorText: coreOverlay.errorText || localOverlay.errorText,
    }
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

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const liveAgent = removeRedundantLiveAgentMessages(
      conversationOverlayMessagesFromState(
        conversationStateFromRegistry(conversationStateByThreadId.value, threadId),
      ) as UiMessage[],
      persisted,
    )
    return buildDisplayedMessages(persisted, liveAgent, completedTurnSummaryForThread(threadId))
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

  function setEarlierMessagesLoadingForThread(threadId: string, isLoading: boolean): void {
    if (!threadId) return
    if (!isLoading) {
      loadingEarlierMessagesByThreadId.value = omitKey(loadingEarlierMessagesByThreadId.value, threadId)
      return
    }
    loadingEarlierMessagesByThreadId.value = {
      ...loadingEarlierMessagesByThreadId.value,
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
      turnActivityByThreadId: turnActivityByThreadId.value,
      turnErrorByThreadId: turnErrorByThreadId.value,
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
    turnActivityByThreadId.value = pruned.turnActivityByThreadId
    turnErrorByThreadId.value = pruned.turnErrorByThreadId
    messageLoadErrorByThreadId.value = Object.fromEntries(
      Object.entries(messageLoadErrorByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    messagePageByThreadId.value = Object.fromEntries(
      Object.entries(messagePageByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    eventUnreadByThreadId.value = pruned.eventUnreadByThreadId
    inProgressById.value = pruned.inProgressById
    pendingServerRequestsByThreadId.value = pruned.pendingServerRequestsByThreadId
    conversationStateByThreadId.value = pruneConversationStateRegistry(
      conversationStateByThreadId.value,
      activeThreadIds,
    )
    loadingMessagesByThreadId.value = Object.fromEntries(
      Object.entries(loadingMessagesByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
    )
    loadingEarlierMessagesByThreadId.value = Object.fromEntries(
      Object.entries(loadingEarlierMessagesByThreadId.value).filter(([threadId]) => activeThreadIds.has(threadId)),
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

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    persistedMessagesByThreadId.value = updateMessagesForThread(
      persistedMessagesByThreadId.value,
      threadId,
      nextMessages,
    )
  }

  function sortOutboxItems(items: LocalMessageOutboxItem[]): LocalMessageOutboxItem[] {
    return [...items].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
  }

  function setOutboxItemsForThread(threadId: string, items: LocalMessageOutboxItem[]): void {
    if (!threadId) return
    const nextItems = sortOutboxItems(items)
    if (nextItems.length === 0) {
      outboxItemsByThreadId.value = omitKey(outboxItemsByThreadId.value, threadId)
      return
    }
    outboxItemsByThreadId.value = {
      ...outboxItemsByThreadId.value,
      [threadId]: nextItems,
    }
  }

  function upsertOutboxItem(item: LocalMessageOutboxItem): void {
    const previous = outboxItemsByThreadId.value[item.threadId] ?? []
    setOutboxItemsForThread(item.threadId, [
      ...previous.filter((row) => row.id !== item.id),
      item,
    ])
  }

  function removeOutboxItemFromState(threadId: string, itemId: string): void {
    const previous = outboxItemsByThreadId.value[threadId] ?? []
    setOutboxItemsForThread(threadId, previous.filter((row) => row.id !== itemId))
  }

  async function persistOutboxItem(item: LocalMessageOutboxItem): Promise<void> {
    upsertOutboxItem(item)
    await saveLocalMessageOutboxItem(item)
  }

  async function deleteOutboxItem(item: LocalMessageOutboxItem): Promise<void> {
    removeOutboxItemFromState(item.threadId, item.id)
    await deleteLocalMessageOutboxItem(item.id)
  }

  function queuedMessagesForThread(threadId: string): UiQueuedMessage[] {
    return (outboxItemsByThreadId.value[threadId] ?? [])
      .filter((item) => item.status === 'queued' || item.status === 'sending' || item.status === 'failed')
      .map((item) => ({
        id: item.id,
        threadId: item.threadId,
        text: item.text,
        status: item.status,
        createdAtIso: item.createdAtIso,
        lastError: item.lastError,
      }))
  }

  function isMatchingOutboxMessage(item: LocalMessageOutboxItem, message: UiMessage): boolean {
    if (message.role !== 'user') return false
    if (item.turnId && message.turnId === item.turnId) return true
    if (item.text.replace(/\s+/gu, ' ').trim() !== message.text.replace(/\s+/gu, ' ').trim()) return false
    const itemSkills = item.skills.map((skill) => `${skill.name}:${skill.path}`).join('|')
    const messageSkills = (message.skills ?? []).map((skill) => `${skill.name}:${skill.path}`).join('|')
    return itemSkills === messageSkills
  }

  async function reconcileOutboxForThread(threadId: string): Promise<void> {
    const items = outboxItemsByThreadId.value[threadId] ?? []
    if (items.length === 0) return
    const messages = persistedMessagesByThreadId.value[threadId] ?? []
    const removable = items.filter((item) => messages.some((message) => isMatchingOutboxMessage(item, message)))
    await Promise.all(removable.map((item) => deleteOutboxItem(item)))
  }

  async function hydrateOutboxFromStore(): Promise<void> {
    if (hasHydratedOutbox) return
    hasHydratedOutbox = true
    const items = await loadLocalMessageOutboxItems()
    const byThread: Record<string, LocalMessageOutboxItem[]> = {}
    for (const item of items) {
      if (!item.threadId) continue
      const rows = byThread[item.threadId] ?? []
      rows.push(item.status === 'sending' ? { ...item, status: 'queued' } : item)
      byThread[item.threadId] = rows
    }
    outboxItemsByThreadId.value = Object.fromEntries(
      Object.entries(byThread).map(([threadId, itemsForThread]) => [threadId, sortOutboxItems(itemsForThread)]),
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
      images: ComposerSubmission<UiComposerContextKind>['images']
      skills: ComposerSubmission<UiComposerContextKind>['skills']
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
    mode: ComposerCollaborationModeOption = selectedCollaborationMode.value,
  ): void {
    shouldAutoScrollOnNextAgentEvent = true
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

  function applyRealtimeUpdates(notification: RpcNotification): void {
    // Establish one Core event snapshot at the transport boundary. Every
    // reader below consumes this exact snapshot instead of reparsing payloads.
    const conversationEvents = normalizeRealtimeNotification(notification)
    applyCoreConversationEvents(conversationEvents)

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

    const startedTurn = conversationEvents.find((event) => event.type === 'turn.started' && Boolean(event.turnId))
    if (startedTurn?.turnId) {
      const pendingOptimisticId = (pendingOptimisticUserMessageIdsByThreadId.get(startedTurn.threadId) ?? [])[0]
      if (pendingOptimisticId) bindOptimisticUserMessageToTurn(startedTurn.threadId, startedTurn.turnId, pendingOptimisticId)
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      if (eventUnreadByThreadId.value[startedTurn.threadId] === true) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = latestTerminalTurnEvent(conversationEvents)
    if (completedTurn?.turnId) {
      setThreadInProgress(completedTurn.threadId, false)
      setTurnActivityForThread(completedTurn.threadId, null)
      markThreadUnreadByEvent(completedTurn.threadId)
      void drainOutboxForThread(completedTurn.threadId)
    }

    const coreTurnError = completedTurn?.turnId
      ? conversationStateFromRegistry(conversationStateByThreadId.value, completedTurn.threadId).turns[completedTurn.turnId]?.error ?? ''
      : ''
    if (coreTurnError) {
      error.value = coreTurnError
    } else if (completedTurn) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    const compaction = conversationEvents.find((event) => event.type === 'thread.compacted')
    if (compaction) {
      setThreadInProgress(compaction.threadId, false)
      setTurnActivityForThread(compaction.threadId, null)
      setTurnErrorForThread(compaction.threadId, null)
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
      void reconcileOutboxForThread(notificationThreadId)
    }

    if (isAgentContentEvent(notification)) {
      if (isSelectedNotificationThread && shouldAutoScrollOnNextAgentEvent && selectedThreadId.value) {
        setThreadScrollState(selectedThreadId.value, {
          scrollTop: 0,
          isAtBottom: true,
          scrollRatio: 1,
        })
      }
    }

    if (normalizeRealtimeNotification(notification).some((event) => (
      event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted'
    ))) {
      if (isSelectedNotificationThread) {
        shouldAutoScrollOnNextAgentEvent = false
      }
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
      const page = await getThreadMessagesPage(threadId, { limit: 10, offset: 0 })
      if (latestMessageLoadRequestIdByThreadId.get(threadId) !== requestId) {
        return
      }
      const nextMessages = page.messages
      const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
      const previousPage = messagePageByThreadId.value[threadId]
      const preservePreviousWindow = options.silent === true
        && previousPage !== undefined
        && page.total >= previousPage.total
      const mergedMessages = mergeMessages(previousPersisted, nextMessages, {
        preserveMissing: preservePreviousWindow,
      })
      setPersistedMessagesForThread(threadId, mergedMessages)
      messagePageByThreadId.value = {
        ...messagePageByThreadId.value,
        [threadId]: {
          total: page.total,
          nextOffset: preservePreviousWindow ? previousPage.nextOffset : page.nextOffset,
          nextBeforeMessageId: preservePreviousWindow
            ? previousPage.nextBeforeMessageId
            : page.nextBeforeMessageId,
          remainingBefore: preservePreviousWindow
            ? previousPage.remainingBefore
            : page.remainingBefore,
          hasMoreBefore: preservePreviousWindow
            ? previousPage.hasMoreBefore
            : page.hasMoreBefore,
        },
      }
      void reconcileOutboxForThread(threadId)

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

  async function loadEarlierMessages(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    if (loadingEarlierMessagesByThreadId.value[normalizedThreadId] === true) return

    const pageState = messagePageByThreadId.value[normalizedThreadId]
    if (!pageState?.hasMoreBefore) return

    setEarlierMessagesLoadingForThread(normalizedThreadId, true)
    setMessageLoadErrorForThread(normalizedThreadId, '')

    try {
      const page = await getThreadMessagesPage(normalizedThreadId, {
        limit: 10,
        offset: pageState.nextOffset,
        beforeMessageId: pageState.nextBeforeMessageId ?? undefined,
      })
      const previousMessages = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
      const previousIds = new Set(previousMessages.map((message) => message.id))
      const earlierMessages = page.messages.filter((message) => !previousIds.has(message.id))
      setPersistedMessagesForThread(normalizedThreadId, [...earlierMessages, ...previousMessages])
      messagePageByThreadId.value = {
        ...messagePageByThreadId.value,
        [normalizedThreadId]: {
          total: page.total,
          nextOffset: page.nextOffset,
          nextBeforeMessageId: page.nextBeforeMessageId,
          remainingBefore: page.remainingBefore,
          hasMoreBefore: page.hasMoreBefore,
        },
      }
    } catch (unknownError) {
      const message = unknownError instanceof Error && unknownError.message
        ? unknownError.message
        : 'Failed to load earlier messages.'
      setMessageLoadErrorForThread(normalizedThreadId, message)
    } finally {
      setEarlierMessagesLoadingForThread(normalizedThreadId, false)
    }
  }

  async function refreshAll(options: { loadSelectedMessages?: boolean } = {}) {
    error.value = ''

    try {
      await hydrateOutboxFromStore()
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
      if (selectedThreadId.value) {
        void drainOutboxForThread(selectedThreadId.value)
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
    const previousUsage = conversationStateFromRegistry(conversationStateByThreadId.value, threadId).contextUsage
    try {
      applyLocalConversationEvent('thread.compaction.started', threadId)
      setTurnErrorForThread(threadId, null)
      setThreadInProgress(threadId, true)
      await compactThread(threadId)
      queueDesktopRealtimeSync(realtimeSyncQueue, threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      applyLocalConversationEvent('thread.context.updated', threadId, previousUsage?.turnId ?? '', {
        turnId: previousUsage?.turnId ?? '',
        usedTokens: previousUsage?.usedTokens ?? 0,
        inputTokens: previousUsage?.inputTokens ?? 0,
        contextWindow: previousUsage?.contextWindow ?? null,
        autoCompactTokenLimit: previousUsage?.autoCompactTokenLimit ?? null,
      })
      applyLocalConversationEvent('turn.activity', threadId, '', { label: '', details: [] })
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

  function scheduleOutboxRetry(threadId: string): void {
    if (typeof window === 'undefined' || outboxRetryTimersByThreadId.has(threadId)) return
    const timerId = window.setTimeout(() => {
      outboxRetryTimersByThreadId.delete(threadId)
      void drainOutboxForThread(threadId)
    }, 5_000)
    outboxRetryTimersByThreadId.set(threadId, timerId)
  }

  async function enqueueMessageForThread(
    threadId: string,
    payload: ComposerSubmission<UiComposerContextKind>,
  ): Promise<LocalMessageOutboxItem | null> {
    const turnInput = normalizeComposerTurnInput(payload)
    if (!threadId || !turnInput.hasContent) return null

    const item = buildLocalMessageOutboxItem({
      threadId,
      payload: {
        text: turnInput.text,
        images: turnInput.images,
        skills: turnInput.skills,
        contexts: payload.contexts,
      },
    })
    await persistOutboxItem(item)
    return item
  }

  async function drainOutboxForThread(threadId: string, options: { itemId?: string } = {}): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    if (drainingOutboxThreadIds.has(normalizedThreadId)) return
    if (inProgressById.value[normalizedThreadId] === true) return

    const rows = outboxItemsByThreadId.value[normalizedThreadId] ?? []
    const item = options.itemId
      ? rows.find((row) => row.id === options.itemId && (row.status === 'queued' || row.status === 'failed'))
      : rows.find((row) => row.status === 'queued' || row.status === 'failed')
    if (!item) return

    drainingOutboxThreadIds.add(normalizedThreadId)
    const sendingItem: LocalMessageOutboxItem = {
      ...item,
      status: 'sending',
      attempts: item.attempts + 1,
      updatedAtIso: new Date().toISOString(),
      lastError: undefined,
    }
    await persistOutboxItem(sendingItem)

    isSendingMessage.value = true
    error.value = ''
    beginPendingTurnForThread(normalizedThreadId)

    try {
      const turnId = await startTurnForThread(
        normalizedThreadId,
        sendingItem.text,
        sendingItem.images,
        sendingItem.skills,
      )
      await persistOutboxItem({
        ...sendingItem,
        turnId,
        updatedAtIso: new Date().toISOString(),
      })
      await reconcileOutboxForThread(normalizedThreadId)
    } catch (unknownError) {
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      shouldAutoScrollOnNextAgentEvent = false
      setThreadInProgress(normalizedThreadId, false)
      setTurnActivityForThread(normalizedThreadId, null)
      setTurnErrorForThread(normalizedThreadId, errorMessage)
      error.value = errorMessage
      await persistOutboxItem({
        ...sendingItem,
        status: 'failed',
        updatedAtIso: new Date().toISOString(),
        lastError: errorMessage,
      })
      scheduleOutboxRetry(normalizedThreadId)
    } finally {
      drainingOutboxThreadIds.delete(normalizedThreadId)
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

    if (resolveComposerSubmitMode(inProgressById.value[threadId] === true, selectedSubmitMode.value) === 'steer') {
      await steerActiveTurn(threadId, turnInput.text, turnInput.images, turnInput.skills)
      options.onAccepted?.()
      return
    }

    const item = await enqueueMessageForThread(threadId, payload)
    if (!item) return
    options.onAccepted?.()
    await drainOutboxForThread(threadId)
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
    await drainOutboxForThread(turnInput.threadId)
  }

  async function sendQueuedMessageNow(threadId: string, itemId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedItemId = itemId.trim()
    if (!normalizedThreadId || !normalizedItemId) return

    const item = (outboxItemsByThreadId.value[normalizedThreadId] ?? []).find((row) => row.id === normalizedItemId)
    if (!item || item.status === 'sending') return

    if (inProgressById.value[normalizedThreadId] === true) {
      try {
        await steerActiveTurn(normalizedThreadId, item.text, item.images, item.skills)
        await deleteOutboxItem(item)
      } catch {
        // steerActiveTurn already surfaces the error in the selected thread state.
      }
      return
    }

    await drainOutboxForThread(normalizedThreadId, { itemId: normalizedItemId })
  }

  async function deleteQueuedMessage(threadId: string, itemId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedItemId = itemId.trim()
    if (!normalizedThreadId || !normalizedItemId) return
    const item = (outboxItemsByThreadId.value[normalizedThreadId] ?? []).find((row) => row.id === normalizedItemId)
    if (!item || item.status === 'sending') return
    await deleteOutboxItem(item)
  }

  async function steerActiveTurn(
    threadId: string,
    nextText: string,
    nextImages: ComposerSubmission<UiComposerContextKind>['images'],
    nextSkills: ComposerSubmission<UiComposerContextKind>['skills'],
  ): Promise<void> {
    const turnId = activeTurnIdForThread(threadId)
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
    nextImages: ComposerSubmission<UiComposerContextKind>['images'],
    nextSkills: ComposerSubmission<UiComposerContextKind>['skills'],
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
      applyLocalConversationEvent('turn.started', threadId, turnId, { optimistic: true })

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
    const turnId = activeTurnIdForThread(threadId)
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
      applyLocalConversationEvent('turn.interrupted', threadId, turnId, { optimistic: true })
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
    latestMessageLoadRequestIdByThreadId.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    shouldAutoScrollOnNextAgentEvent = false
    loadingMessagesByThreadId.value = {}
    loadingEarlierMessagesByThreadId.value = {}
    persistedMessagesByThreadId.value = {}
    turnActivityByThreadId.value = {}
    turnErrorByThreadId.value = {}
    messageLoadErrorByThreadId.value = {}
    messagePageByThreadId.value = {}
    conversationStateByThreadId.value = {}
    for (const timerId of outboxRetryTimersByThreadId.values()) {
      if (typeof window !== 'undefined') window.clearTimeout(timerId)
    }
    outboxRetryTimersByThreadId.clear()
    drainingOutboxThreadIds.clear()
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

  function applyCoreConversationEvents(events: readonly CodexEvent[]): void {
    conversationStateByThreadId.value = reduceConversationRegistryEvents(
      conversationStateByThreadId.value,
      events,
    )
  }

  function applyLocalConversationEvent(
    type: CodexEvent['type'],
    threadId: string,
    turnId = '',
    data: Record<string, unknown> = {},
  ): void {
    if (!threadId) return
    localCoreEventSequence += 1
    applyCoreConversationEvents([{
      id: `codyweb:local:${String(localCoreEventSequence)}:${type}:${threadId}:${turnId}`,
      type,
      threadId,
      ...(turnId ? { turnId } : {}),
      atIso: new Date().toISOString(),
      data,
    }])
  }

  function activeTurnIdForThread(threadId: string): string {
    return conversationStateFromRegistry(conversationStateByThreadId.value, threadId).activeTurnId
  }

  function completedTurnSummaryForThread(threadId: string): TurnSummaryState | null {
    const feed = conversationFeedFromState(conversationStateFromRegistry(conversationStateByThreadId.value, threadId))
    for (let index = feed.length - 1; index >= 0; index -= 1) {
      const entry = feed[index]
      if (entry?.kind === 'turn' && entry.status === 'completed' && entry.durationMs !== null) {
        return { turnId: entry.turnId, durationMs: entry.durationMs }
      }
    }
    return null
  }

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
    isLoadingEarlierMessages,
    selectedThreadHasMoreMessagesBefore,
    selectedThreadEarlierMessageCount,
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
    loadEarlierMessages,
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
    toggleAutoRefreshTimer,
    startRealtimeSync,
    stopRealtimeSync,
  }
}
