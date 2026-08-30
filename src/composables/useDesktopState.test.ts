import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_SETTING_KEYS, DESKTOP_STORAGE_KEYS } from './desktopSettingsKeys'
import { buildRollbackAuditMessage, useDesktopState } from './useDesktopState'
import { buildThreadActivityEntries } from './useThreadActivity'
import {
  buildLocalMessageOutboxItem,
  loadLocalMessageOutboxItems,
  resetLocalMessageOutboxForTests,
  saveLocalMessageOutboxItem,
} from './localMessageOutbox'
import type { UiMessage, UiProjectGroup, UiRateLimitSnapshot, UiThreadMessagePage, UiToolingRollbackFileResult } from '../types/codex'
import type { RpcNotification } from '../api/codexRealtimeClient'

const codexApiMock = vi.hoisted(() => {
  let notificationListener: ((value: RpcNotification) => void) | null = null
  const getThreadGroups = vi.fn(async (): Promise<UiProjectGroup[]> => [])
  const getThreadMessages = vi.fn(async (_threadId?: string): Promise<UiMessage[]> => [])
  const getThreadMessagesPage = vi.fn(async (
    threadId?: string,
    options: { limit?: number; offset?: number; beforeMessageId?: string } = {},
  ): Promise<UiThreadMessagePage> => {
    const messages = await getThreadMessages(threadId)
    const limit = options.limit ?? 10
    const offset = options.offset ?? 0
    return {
      threadId: threadId ?? '',
      messages,
      total: messages.length,
      limit,
      offset,
      nextOffset: offset + messages.length,
      nextBeforeMessageId: messages[0]?.id ?? null,
      remainingBefore: 0,
      hasMoreBefore: false,
      cache: {
        status: 'ready',
        hydratedAtIso: '2026-07-07T00:00:00.000Z',
        refreshedAtIso: '2026-07-07T00:00:00.000Z',
        checkedAtIso: '2026-07-07T00:00:00.000Z',
      },
    }
  })

  return {
    getNotificationListener: () => notificationListener,
    compactThread: vi.fn(),
    forkThread: vi.fn(),
    getAccountRateLimits: vi.fn(async (): Promise<UiRateLimitSnapshot | null> => null),
    getAvailableModelIds: vi.fn(async (): Promise<string[]> => []),
    getCollaborationModes: vi.fn(async () => []),
    getCurrentModelConfig: vi.fn(async () => ({
      model: '',
      reasoningEffort: '',
      modelContextWindow: 200_000,
      autoCompactTokenLimit: 180_000,
    })),
    fetchUserSetting: vi.fn(async (): Promise<unknown> => null),
    writeUserSetting: vi.fn(async (key: string, value: unknown) => ({
      key,
      value,
      updatedAtIso: '2026-07-07T00:00:00.000Z',
    })),
    fetchPendingServerRequests: vi.fn(async () => []),
    getThreadGroups,
    fetchCatalog: vi.fn(async () => ({
      groups: await getThreadGroups(),
      projectDisplayNameById: {},
      projectOrder: [],
      hasStoredProjectOrder: false,
      sync: null,
    })),
    saveCatalogProjectDisplayName: vi.fn(),
    saveCatalogProjectOrder: vi.fn(),
    setProjectHidden: vi.fn(),
    setThreadHidden: vi.fn(),
    getThreadMessages,
    getThreadMessagesPage,
    interruptThreadTurn: vi.fn(),
    normalizeRateLimitSnapshot: vi.fn(() => null),
    renameThread: vi.fn(),
    respondServerRequest: vi.fn(),
    resumeThread: vi.fn(),
    startThread: vi.fn(),
    startThreadTurn: vi.fn(),
    steerThreadTurn: vi.fn(),
    subscribeRpcNotifications: vi.fn((listener: (value: RpcNotification) => void) => {
      notificationListener = listener
      return vi.fn(() => {
        notificationListener = null
      })
    }),
  }
})

vi.mock('../api/codexBridgeClient', () => ({
  fetchPendingServerRequests: codexApiMock.fetchPendingServerRequests,
  respondServerRequest: codexApiMock.respondServerRequest,
}))
vi.mock('../api/codexModelClient', () => ({
  getAvailableModelIds: codexApiMock.getAvailableModelIds,
  getCollaborationModes: codexApiMock.getCollaborationModes,
  getCurrentModelConfig: codexApiMock.getCurrentModelConfig,
}))
vi.mock('../api/codexRateLimitClient', () => ({
  getAccountRateLimits: codexApiMock.getAccountRateLimits,
  normalizeRateLimitSnapshot: codexApiMock.normalizeRateLimitSnapshot,
}))
vi.mock('../api/codexSettingsClient', () => ({
  fetchUserSetting: codexApiMock.fetchUserSetting,
  writeUserSetting: codexApiMock.writeUserSetting,
}))
vi.mock('../api/codexRealtimeClient', () => ({
  subscribeRpcNotifications: codexApiMock.subscribeRpcNotifications,
}))
vi.mock('../api/codexCatalogClient', () => ({
  fetchCatalog: codexApiMock.fetchCatalog,
  saveCatalogProjectDisplayName: codexApiMock.saveCatalogProjectDisplayName,
  saveCatalogProjectOrder: codexApiMock.saveCatalogProjectOrder,
  setProjectHidden: codexApiMock.setProjectHidden,
  setThreadHidden: codexApiMock.setThreadHidden,
}))
vi.mock('../api/codexThreadClient', () => ({
  compactThread: codexApiMock.compactThread,
  forkThread: codexApiMock.forkThread,
  getThreadMessages: codexApiMock.getThreadMessages,
  getThreadMessagesPage: codexApiMock.getThreadMessagesPage,
  interruptThreadTurn: codexApiMock.interruptThreadTurn,
  renameThread: codexApiMock.renameThread,
  resumeThread: codexApiMock.resumeThread,
  startThread: codexApiMock.startThread,
  startThreadTurn: codexApiMock.startThreadTurn,
  steerThreadTurn: codexApiMock.steerThreadTurn,
}))

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserGlobals(selectedThreadId = ''): void {
  const storage = new MemoryStorage()
  if (selectedThreadId) {
    storage.setItem(DESKTOP_STORAGE_KEYS.selectedThread, selectedThreadId)
  }

  vi.stubGlobal('window', {
    localStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  })
}

function buildRollbackResult(overrides: Partial<UiToolingRollbackFileResult> = {}): UiToolingRollbackFileResult {
  return {
    cwd: '/workspace/app',
    repoRoot: '/workspace/app',
    filePath: 'src/app.ts',
    relativePath: 'src/app.ts',
    rollbackApplied: true,
    remainingStatus: '',
    checkpoint: {
      id: 'checkpoint-1',
      label: 'Before rollback',
      cwd: '/workspace/app',
      repoRoot: '/workspace/app',
      createdAtIso: '2026-07-05T00:00:00.000Z',
      paths: ['src/app.ts'],
      patchPath: '/workspace/app/.git/cody-web-ui-checkpoints/checkpoint-1/workspace.patch',
      patchBytes: 128,
      hasPatch: true,
    },
    ...overrides,
  }
}

function buildMessagePage(
  threadId: string,
  messages: UiMessage[],
  overrides: Partial<Omit<UiThreadMessagePage, 'threadId' | 'messages' | 'cache'>> = {},
): UiThreadMessagePage {
  const offset = overrides.offset ?? 0
  const limit = overrides.limit ?? 10
  const total = overrides.total ?? messages.length
  const nextOffset = overrides.nextOffset ?? offset + messages.length
  return {
    threadId,
    messages,
    total,
    limit,
    offset,
    nextOffset,
    nextBeforeMessageId: overrides.nextBeforeMessageId ?? messages[0]?.id ?? null,
    remainingBefore: overrides.remainingBefore ?? Math.max(total - nextOffset, 0),
    hasMoreBefore: overrides.hasMoreBefore ?? false,
    cache: {
      status: 'ready',
      hydratedAtIso: '2026-07-07T00:00:00.000Z',
      refreshedAtIso: '2026-07-07T00:00:00.000Z',
      checkedAtIso: '2026-07-07T00:00:00.000Z',
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetLocalMessageOutboxForTests()
  vi.clearAllMocks()
})

describe('useDesktopState realtime messages', () => {
  it('tracks context usage and exposes manual compaction lifecycle immediately', async () => {
    installBrowserGlobals('thread-1')
    const state = useDesktopState()
    state.startRealtimeSync()
    await flushPromises()

    codexApiMock.getNotificationListener()?.({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 145_000, totalTokens: 150_000 },
          modelContextWindow: 200_000,
        },
      },
      atIso: '2026-07-24T10:00:00.000Z',
    })

    expect(state.selectedThreadContextUsage.value).toMatchObject({
      threadId: 'thread-1',
      usedTokens: 150_000,
      contextWindow: 200_000,
      autoCompactTokenLimit: null,
      compactionState: 'idle',
    })

    const pendingCompact = deferred<void>()
    codexApiMock.compactThread.mockReturnValueOnce(pendingCompact.promise)
    const compactPromise = state.compactThreadById('thread-1')
    expect(state.selectedThreadContextUsage.value?.compactionState).toBe('compacting')

    codexApiMock.getNotificationListener()?.({
      method: 'thread/compacted',
      params: { threadId: 'thread-1' },
      atIso: '2026-07-24T10:00:02.000Z',
    })
    expect(state.selectedThreadContextUsage.value?.compactionState).toBe('compacted')
    pendingCompact.resolve()
    await compactPromise
    state.stopRealtimeSync()
  })

  it('keeps the authoritative rate limit snapshot while a realtime invalidation refreshes it', async () => {
    installBrowserGlobals()
    const initialSnapshot = {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780000000 },
      secondary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1780500000 },
      credits: null,
      availableResetCredits: 1,
    }
    const refreshedSnapshot = {
      ...initialSnapshot,
      primary: { ...initialSnapshot.primary, usedPercent: 13 },
    }
    const pendingRefresh = deferred<typeof refreshedSnapshot>()
    codexApiMock.getAccountRateLimits
      .mockResolvedValueOnce(initialSnapshot)
      .mockReturnValueOnce(pendingRefresh.promise)
    const state = useDesktopState()

    state.startRealtimeSync()
    await flushPromises()
    expect(state.rateLimitSnapshot.value?.primary?.usedPercent).toBe(12)

    codexApiMock.getNotificationListener()?.({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1780000000 },
          secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1780500000 },
        },
      },
      atIso: '2026-07-12T12:00:00.000Z',
    })

    expect(state.rateLimitSnapshot.value?.primary?.usedPercent).toBe(12)
    expect(codexApiMock.normalizeRateLimitSnapshot).not.toHaveBeenCalled()
    pendingRefresh.resolve(refreshedSnapshot)
    await flushPromises()
    expect(state.rateLimitSnapshot.value?.primary?.usedPercent).toBe(13)
    state.stopRealtimeSync()
  })

  it('hydrates and persists turn preferences through the settings store', async () => {
    installBrowserGlobals()
    codexApiMock.fetchUserSetting.mockResolvedValueOnce({
      key: DESKTOP_SETTING_KEYS.turnPreferences,
      value: {
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
        collaborationModeName: 'plan',
        permissionMode: 'yolo',
        submitMode: 'steer',
      },
      updatedAtIso: '2026-07-07T00:00:00.000Z',
    })
    codexApiMock.getAvailableModelIds.mockResolvedValueOnce(['gpt-5.5', 'gpt-5'])

    const state = useDesktopState()

    await state.refreshAll()

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.selectedReasoningEffort.value).toBe('high')
    expect(state.selectedCollaborationModeName.value).toBe('plan')
    expect(state.selectedPermissionMode.value).toBe('yolo')
    expect(state.selectedSubmitMode.value).toBe('steer')

    state.setSelectedReasoningEffort('xhigh')

    expect(codexApiMock.writeUserSetting).toHaveBeenLastCalledWith(
      DESKTOP_SETTING_KEYS.turnPreferences,
      {
        modelId: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        collaborationModeName: 'plan',
        permissionMode: 'yolo',
        submitMode: 'steer',
      },
    )
  })

  it('can refresh shell data without reading the persisted selected thread messages', async () => {
    installBrowserGlobals('stale-large-thread')
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Project',
        cwd: '/repo',
        threads: [
          {
            id: 'stale-large-thread',
            title: 'Large old thread',
            projectName: 'Project',
            cwd: '/repo',
            createdAtIso: '2026-07-07T00:00:00.000Z',
            updatedAtIso: '2026-07-08T00:00:00.000Z',
            preview: 'Large old thread',
            unread: false,
            inProgress: false,
          },
        ],
      },
    ]
    codexApiMock.getThreadGroups.mockImplementationOnce(async () => groups)
    const state = useDesktopState()

    await state.refreshAll({ loadSelectedMessages: false })

    expect(codexApiMock.getThreadGroups).toHaveBeenCalledOnce()
    expect(codexApiMock.getThreadMessages).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('stale-large-thread')
  })

  it('renders live assistant deltas before the turn completes', () => {
    installBrowserGlobals('thread-live')
    const state = useDesktopState()

    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()

    listener?.({
      method: 'turn/started',
      params: {
        threadId: 'thread-live',
        turn: {
          id: 'turn-live',
          startedAt: '2026-07-07T00:00:00.000Z',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })
    listener?.({
      method: 'item/started',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: {
          id: 'msg-live',
          type: 'agentMessage',
        },
      },
      atIso: '2026-07-07T00:00:01.000Z',
    })
    listener?.({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        itemId: 'msg-live',
        delta: '实时',
      },
      atIso: '2026-07-07T00:00:02.000Z',
    })

    expect(state.messages.value).toEqual([
      {
        id: 'msg-live',
        turnId: 'turn-live',
        role: 'assistant',
        text: '实时',
        messageType: 'agentMessage.live',
      },
    ])
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Writing response')

    listener?.({
      method: 'item/agentMessage/delta',
      params: {
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        item_id: 'msg-live',
        delta: '输出',
      },
      atIso: '2026-07-07T00:00:03.000Z',
    })

    expect(state.messages.value[0]?.text).toBe('实时输出')

    state.stopRealtimeSync()
  })

  it('streams selected thread deltas without waiting for a message refresh', () => {
    installBrowserGlobals('thread-live')
    const state = useDesktopState()

    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()
    codexApiMock.getThreadMessages.mockClear()

    listener?.({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        itemId: 'msg-live',
        delta: 'Hello',
      },
      atIso: '2026-07-07T00:00:02.000Z',
    })
    listener?.({
      method: 'item/plan/delta',
      params: {
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        item_id: 'plan-live',
        delta: '1. [todo] Verify realtime output',
      },
      atIso: '2026-07-07T00:00:03.000Z',
    })

    expect(state.messages.value).toEqual([
      {
        id: 'msg-live',
        turnId: 'turn-live',
        role: 'assistant',
        text: 'Hello',
        messageType: 'agentMessage.live',
      },
      {
        id: 'plan-live',
        turnId: 'turn-live',
        role: 'assistant',
        text: '1. [todo] Verify realtime output',
        messageType: 'plan.live',
      },
    ])
    expect(codexApiMock.getThreadMessages).not.toHaveBeenCalled()

    state.stopRealtimeSync()
  })

  it('tracks and resolves pending server approval requests for the selected thread', async () => {
    installBrowserGlobals('thread-approval')
    const state = useDesktopState()

    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()

    listener?.({
      method: 'server/request',
      params: {
        id: 71,
        method: 'item/commandExecution/requestApproval',
        receivedAtIso: '2026-07-07T00:00:00.000Z',
        params: {
          threadId: 'thread-approval',
          turnId: 'turn-approval',
          itemId: 'command-1',
          command: 'npm test',
          cwd: '/repo',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })
    listener?.({
      method: 'server/request',
      params: {
        id: 72,
        method: 'item/fileChange/requestApproval',
        receivedAtIso: '2026-07-07T00:00:01.000Z',
        params: {
          turnId: 'turn-global',
          itemId: 'file-1',
          grantRoot: '/repo',
        },
      },
      atIso: '2026-07-07T00:00:01.000Z',
    })

    expect(state.selectedThreadServerRequests.value.map((request) => request.id)).toEqual([71, 72])
    expect(state.allPendingServerRequests.value.map((request) => request.id)).toEqual([71, 72])

    await state.respondToPendingServerRequest({
      id: 71,
      approvalScope: 'workspace',
      result: { decision: 'accept' },
    })

    expect(codexApiMock.respondServerRequest).toHaveBeenCalledWith({
      id: 71,
      approvalScope: 'workspace',
      result: { decision: 'accept' },
      error: undefined,
    })
    expect(state.selectedThreadServerRequests.value.map((request) => request.id)).toEqual([72])

    listener?.({
      method: 'server/request/resolved',
      params: { request_id: 72 },
      atIso: '2026-07-07T00:00:02.000Z',
    })

    expect(state.selectedThreadServerRequests.value).toEqual([])
    expect(state.allPendingServerRequests.value).toEqual([])

    state.stopRealtimeSync()
  })

  it('keeps live content for threads selected after the stream starts', async () => {
    installBrowserGlobals('thread-a')
    const state = useDesktopState()

    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()

    listener?.({
      method: 'turn/started',
      params: {
        threadId: 'thread-b',
        turn: {
          id: 'turn-b',
          startedAt: '2026-07-07T00:00:00.000Z',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })
    listener?.({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        itemId: 'msg-b',
        delta: '后台实时输出',
      },
      atIso: '2026-07-07T00:00:01.000Z',
    })
    listener?.({
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        itemId: 'plan-b',
        delta: '1. [todo] 后台计划',
      },
      atIso: '2026-07-07T00:00:02.000Z',
    })
    listener?.({
      method: 'item/completed',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        item: {
          id: 'msg-b',
          type: 'agentMessage',
          text: '后台最终输出',
        },
      },
      atIso: '2026-07-07T00:00:03.000Z',
    })

    expect(state.messages.value).toEqual([])

    await state.selectThread('thread-b')

    expect(state.messages.value).toEqual([
      {
        id: 'msg-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: '后台最终输出',
        messageType: 'agentMessage.live',
      },
      {
        id: 'plan-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: '1. [todo] 后台计划',
        messageType: 'plan.live',
      },
    ])

    listener?.({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        explanation: '计划更新',
        plan: [
          {
            step: '检查实时输出',
            status: 'inProgress',
          },
        ],
      },
      atIso: '2026-07-07T00:00:04.000Z',
    })

    expect(state.selectedStructuredPlan.value).toMatchObject({
      threadId: 'thread-b', turnId: 'turn-b', revision: 1, lifecycle: 'active', possiblyStale: false,
      steps: [{ status: 'inProgress', step: '检查实时输出' }],
    })

    listener?.({
      method: 'item/completed',
      params: { threadId: 'thread-b', turnId: 'turn-b', item: { id: 'change-1', type: 'fileChange' } },
      atIso: '2026-07-07T00:00:05.000Z',
    })
    expect(state.selectedStructuredPlan.value).toMatchObject({ revision: 1, possiblyStale: false })

    listener?.({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-b', turnId: 'turn-b',
        plan: [{ step: '检查实时输出', status: 'completed' }, { step: '运行测试', status: 'inProgress' }],
      },
      atIso: '2026-07-07T00:00:06.000Z',
    })
    expect(state.selectedStructuredPlan.value).toMatchObject({
      revision: 2, possiblyStale: false,
      steps: [{ status: 'completed' }, { status: 'inProgress' }],
    })

    expect(state.messages.value).toEqual([
      {
        id: 'msg-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: '后台最终输出',
        messageType: 'agentMessage.live',
      },
      {
        id: 'plan-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: '1. [done] 检查实时输出\n2. [doing] 运行测试',
        messageType: 'plan.live',
      },
    ])

    listener?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-b',
        turn: {
          id: 'turn-b',
          startedAt: '2026-07-07T00:00:00.000Z',
          completedAt: '2026-07-07T00:00:08.000Z',
        },
      },
      atIso: '2026-07-07T00:00:08.000Z',
    })

    expect(state.selectedStructuredPlan.value).toMatchObject({ lifecycle: 'ended', possiblyStale: true })

    expect(state.messages.value).toEqual([
      {
        id: 'msg-b',
        turnId: 'turn-b',
        role: 'assistant',
        text: '后台最终输出',
        messageType: 'agentMessage',
      },
      {
        id: 'turn-summary:turn-b',
        turnId: 'turn-b',
        role: 'system',
        text: 'Worked for 8s',
        messageType: 'worked',
      },
    ])

    state.stopRealtimeSync()
  })

  it('keeps message loading scoped to the selected thread', async () => {
    installBrowserGlobals('thread-a')
    const threadALoad = deferred<UiMessage[]>()
    const threadBLoad = deferred<UiMessage[]>()
    codexApiMock.getThreadMessages.mockImplementation(async (threadId?: string) => {
      if (threadId === 'thread-a') return threadALoad.promise
      if (threadId === 'thread-b') return threadBLoad.promise
      return []
    })

    const state = useDesktopState()

    const threadAPromise = state.selectThread('thread-a')
    await flushPromises()
    expect(state.isLoadingMessages.value).toBe(true)

    const threadBPromise = state.selectThread('thread-b')
    await flushPromises()
    expect(state.isLoadingMessages.value).toBe(true)

    threadBLoad.resolve([])
    await threadBPromise
    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.isLoadingMessages.value).toBe(false)

    threadALoad.resolve([])
    await threadAPromise
    expect(state.selectedThreadId.value).toBe('thread-b')
    expect(state.isLoadingMessages.value).toBe(false)
  })

  it('ignores stale message loads that finish after a newer load for the same thread', async () => {
    installBrowserGlobals('thread-a')
    const firstLoad = deferred<UiMessage[]>()
    const secondLoad = deferred<UiMessage[]>()
    codexApiMock.getThreadMessages
      .mockImplementationOnce(async () => firstLoad.promise)
      .mockImplementationOnce(async () => secondLoad.promise)

    const state = useDesktopState()

    const firstPromise = state.selectThread('thread-a')
    await flushPromises()
    const secondPromise = state.selectThread('thread-a')
    await flushPromises()

    secondLoad.resolve([{ id: 'new', role: 'assistant', text: 'new response' }])
    await secondPromise
    expect(state.messages.value.map((message) => message.text)).toEqual(['new response'])

    firstLoad.resolve([{ id: 'old', role: 'assistant', text: 'old response' }])
    await firstPromise
    expect(state.messages.value.map((message) => message.text)).toEqual(['new response'])
  })

  it('prepends earlier cached pages without reloading the whole thread', async () => {
    installBrowserGlobals('thread-a')
    const latestMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `latest-${String(index + 1)}`,
      role: 'assistant' as const,
      text: `Latest ${String(index + 1)}`,
    }))
    const earlierMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `earlier-${String(index + 1)}`,
      role: 'assistant' as const,
      text: `Earlier ${String(index + 1)}`,
    }))
    codexApiMock.getThreadMessagesPage
      .mockResolvedValueOnce(buildMessagePage('thread-a', latestMessages, {
        total: 25,
        offset: 0,
        nextOffset: 10,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', earlierMessages, {
        total: 25,
        offset: 10,
        nextOffset: 20,
        hasMoreBefore: true,
      }))

    const state = useDesktopState()

    await state.selectThread('thread-a')
    expect(state.messages.value.map((message) => message.id)).toEqual(latestMessages.map((message) => message.id))
    expect(state.selectedThreadHasMoreMessagesBefore.value).toBe(true)
    expect(state.selectedThreadEarlierMessageCount.value).toBe(15)

    await state.loadEarlierMessages('thread-a')

    expect(codexApiMock.getThreadMessagesPage).toHaveBeenNthCalledWith(2, 'thread-a', {
      limit: 10,
      offset: 10,
      beforeMessageId: 'latest-1',
    })
    expect(state.messages.value.map((message) => message.id)).toEqual([
      ...earlierMessages.map((message) => message.id),
      ...latestMessages.map((message) => message.id),
    ])
    expect(state.selectedThreadEarlierMessageCount.value).toBe(5)
  })

  it('keeps the earlier-page offset after a silent first-page refresh', async () => {
    installBrowserGlobals('thread-a')
    const latestMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `latest-${String(index + 1)}`,
      role: 'assistant' as const,
      text: `Latest ${String(index + 1)}`,
    }))
    const firstEarlierMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `earlier-a-${String(index + 1)}`,
      role: 'assistant' as const,
      text: `Earlier A ${String(index + 1)}`,
    }))
    const secondEarlierMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `earlier-b-${String(index + 1)}`,
      role: 'assistant' as const,
      text: `Earlier B ${String(index + 1)}`,
    }))
    codexApiMock.getThreadMessagesPage
      .mockResolvedValueOnce(buildMessagePage('thread-a', latestMessages, {
        total: 35,
        offset: 0,
        nextOffset: 10,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', firstEarlierMessages, {
        total: 35,
        offset: 10,
        nextOffset: 20,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', latestMessages, {
        total: 35,
        offset: 0,
        nextOffset: 10,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', secondEarlierMessages, {
        total: 35,
        offset: 20,
        nextOffset: 30,
        hasMoreBefore: true,
      }))

    const state = useDesktopState()

    await state.selectThread('thread-a')
    await state.loadEarlierMessages('thread-a')
    await state.loadMessages('thread-a', { silent: true })
    await state.loadEarlierMessages('thread-a')

    expect(codexApiMock.getThreadMessagesPage).toHaveBeenNthCalledWith(4, 'thread-a', {
      limit: 10,
      offset: 20,
      beforeMessageId: 'earlier-a-1',
    })
    expect(state.messages.value.map((message) => message.id)).toEqual([
      ...secondEarlierMessages.map((message) => message.id),
      ...firstEarlierMessages.map((message) => message.id),
      ...latestMessages.map((message) => message.id),
    ])
    expect(state.selectedThreadEarlierMessageCount.value).toBe(5)
  })

  it('keeps a stable history boundary while silent refreshes append newer messages', async () => {
    installBrowserGlobals('thread-a')
    const latestMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${String(index + 91)}`,
      role: 'assistant' as const,
      text: `Message ${String(index + 91)}`,
    }))
    const refreshedLatestMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${String(index + 96)}`,
      role: 'assistant' as const,
      text: `Message ${String(index + 96)}`,
    }))
    const earlierMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${String(index + 81)}`,
      role: 'assistant' as const,
      text: `Message ${String(index + 81)}`,
    }))
    codexApiMock.getThreadMessagesPage
      .mockResolvedValueOnce(buildMessagePage('thread-a', latestMessages, {
        total: 100,
        nextOffset: 10,
        nextBeforeMessageId: 'message-91',
        remainingBefore: 90,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', refreshedLatestMessages, {
        total: 105,
        nextOffset: 10,
        nextBeforeMessageId: 'message-96',
        remainingBefore: 95,
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(buildMessagePage('thread-a', earlierMessages, {
        total: 105,
        nextOffset: 25,
        nextBeforeMessageId: 'message-81',
        remainingBefore: 80,
        hasMoreBefore: true,
      }))

    const state = useDesktopState()
    await state.selectThread('thread-a')
    await state.loadMessages('thread-a', { silent: true })

    expect(state.selectedThreadEarlierMessageCount.value).toBe(90)
    await state.loadEarlierMessages('thread-a')

    expect(codexApiMock.getThreadMessagesPage).toHaveBeenNthCalledWith(3, 'thread-a', {
      limit: 10,
      offset: 10,
      beforeMessageId: 'message-91',
    })
    expect(state.selectedThreadEarlierMessageCount.value).toBe(80)
    expect(state.messages.value.map((message) => message.id)).toContain('message-81')
  })

  it('clears visible message loading when a silent refresh supersedes it', async () => {
    vi.useFakeTimers()
    installBrowserGlobals('thread-a')
    const firstLoad = deferred<UiMessage[]>()
    const silentLoad = deferred<UiMessage[]>()
    const threadGroups = [
      {
        projectName: 'repo',
        cwd: '/workspace/repo',
        threads: [
          {
            id: 'thread-a',
            title: 'Thread A',
            projectName: 'repo',
            cwd: '/workspace/repo',
            createdAtIso: '2026-07-07T00:00:00.000Z',
            updatedAtIso: '2026-07-07T00:01:00.000Z',
            preview: 'hello',
            unread: false,
            inProgress: true,
          },
        ],
      },
    ]
    codexApiMock.getThreadGroups.mockResolvedValue(threadGroups as unknown as never[])
    codexApiMock.getThreadMessages
      .mockImplementationOnce(async () => firstLoad.promise)
      .mockImplementationOnce(async () => silentLoad.promise)

    const state = useDesktopState()
    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()

    const firstPromise = state.selectThread('thread-a')
    await flushPromises()
    expect(state.isLoadingMessages.value).toBe(true)

    listener?.({
      method: 'thread/updated',
      params: {
        threadId: 'thread-a',
      },
      atIso: '2026-07-07T00:00:01.000Z',
    })
    await vi.advanceTimersByTimeAsync(220)
    await flushPromises()
    expect(codexApiMock.getThreadMessages).toHaveBeenCalledTimes(2)
    expect(state.isLoadingMessages.value).toBe(true)

    silentLoad.resolve([{ id: 'silent', role: 'assistant', text: 'loaded response' }])
    await flushPromises()
    expect(state.messages.value.map((message) => message.text)).toEqual(['loaded response'])
    expect(state.isLoadingMessages.value).toBe(false)

    firstLoad.resolve([{ id: 'stale', role: 'assistant', text: 'stale response' }])
    await firstPromise
    expect(state.messages.value.map((message) => message.text)).toEqual(['loaded response'])
    expect(state.isLoadingMessages.value).toBe(false)

    state.stopRealtimeSync()
  })

  it('keeps thread selection usable when message loading fails and clears the error after retry', async () => {
    installBrowserGlobals('thread-a')
    codexApiMock.getThreadMessages
      .mockRejectedValueOnce(new Error('codex app-server RPC thread/read timed out after 20000ms'))
      .mockResolvedValueOnce([{ id: 'loaded', role: 'assistant', text: 'loaded after retry' }])

    const state = useDesktopState()

    await expect(state.selectThread('thread-a')).resolves.toBeUndefined()

    expect(codexApiMock.resumeThread).not.toHaveBeenCalled()
    expect(state.selectedThreadId.value).toBe('thread-a')
    expect(state.isLoadingMessages.value).toBe(false)
    expect(state.selectedMessageLoadError.value).toBe('codex app-server RPC thread/read timed out after 20000ms')
    expect(state.messages.value).toEqual([])

    await state.loadMessages('thread-a')

    expect(state.selectedMessageLoadError.value).toBe('')
    expect(state.messages.value).toEqual([
      { id: 'loaded', role: 'assistant', text: 'loaded after retry' },
    ])
  })

  it('shows outgoing user messages before the turn start response finishes', async () => {
    installBrowserGlobals('thread-a')
    const turnStart = deferred<string>()
    const threadGroups = [
      {
        projectName: 'repo',
        cwd: '/workspace/repo',
        threads: [
          {
            id: 'thread-a',
            title: 'Thread A',
            projectName: 'repo',
            cwd: '/workspace/repo',
            createdAtIso: '2026-07-07T00:00:00.000Z',
            updatedAtIso: '2026-07-07T00:01:00.000Z',
            preview: 'hello',
            unread: false,
            inProgress: true,
          },
        ],
      },
    ]
    codexApiMock.startThreadTurn.mockImplementation(async () => turnStart.promise)
    codexApiMock.getThreadGroups.mockResolvedValue(threadGroups as unknown as never[])
    codexApiMock.getThreadMessages.mockResolvedValue([
      {
        id: 'server-user',
        role: 'user',
        text: '我觉得可以，干吧',
        messageType: 'userMessage',
      },
    ])

    const state = useDesktopState()
    const sendPromise = state.sendMessageToSelectedThread({
      text: '我觉得可以，干吧',
      images: [],
      skills: [],
    })

    expect(state.selectedQueuedMessages.value).toEqual([
      expect.objectContaining({
        text: '我觉得可以，干吧',
        status: 'queued',
      }),
    ])
    await vi.waitFor(() => {
      expect(state.messages.value).toEqual([
        expect.objectContaining({
          role: 'user',
          text: '我觉得可以，干吧',
          messageType: 'userMessage.optimistic',
        }),
      ])
    })

    turnStart.resolve('turn-1')
    await sendPromise

    expect(state.selectedQueuedMessages.value.some((message) => message.text === '我觉得可以，干吧')).toBe(false)
    expect(state.messages.value).toEqual([
      expect.objectContaining({
        id: 'server-user',
        role: 'user',
        text: '我觉得可以，干吧',
        messageType: 'userMessage',
      }),
    ])
  })

  it('keeps queued outgoing messages when selected thread turn start fails', async () => {
    installBrowserGlobals('thread-a')
    codexApiMock.startThreadTurn.mockRejectedValue(new Error('turn start failed'))

    const state = useDesktopState()
    state.projectGroups.value = [
      {
        projectName: 'repo',
        cwd: '/workspace/repo',
        threads: [
          {
            id: 'thread-a',
            title: 'Thread A',
            projectName: 'repo',
            cwd: '/workspace/repo',
            createdAtIso: '2026-07-07T00:00:00.000Z',
            updatedAtIso: '2026-07-07T00:01:00.000Z',
            preview: '',
            unread: false,
            inProgress: false,
          },
        ],
      },
    ]

    await expect(state.sendMessageToSelectedThread({
      text: '这条应该失败后撤回',
      images: [],
      skills: [],
    })).resolves.toBeUndefined()

    expect(state.messages.value).toEqual([])
    expect(state.selectedQueuedMessages.value).toEqual([
      expect.objectContaining({
        text: '这条应该失败后撤回',
        status: 'failed',
        lastError: 'turn start failed',
      }),
    ])
    expect(state.error.value).toBe('turn start failed')
    expect(state.isSendingMessage.value).toBe(false)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).not.toBe(true)
  })

  it('keeps an accepted send durable until the formal user item arrives', async () => {
    installBrowserGlobals('thread-a')
    const stalledCatalogRefresh = deferred<never>()
    codexApiMock.startThreadTurn.mockResolvedValue('turn-accepted')
    codexApiMock.fetchCatalog.mockReturnValueOnce(stalledCatalogRefresh.promise)

    const state = useDesktopState()
    state.projectGroups.value = [{
      projectName: 'repo', cwd: '/workspace/repo', threads: [{
        id: 'thread-a', title: 'Thread A', projectName: 'repo', cwd: '/workspace/repo',
        createdAtIso: '2026-07-07T00:00:00.000Z', updatedAtIso: '2026-07-07T00:01:00.000Z',
        preview: '', unread: false, inProgress: false,
      }],
    }]

    await state.sendMessageToSelectedThread({
      text: '不要被后台刷新卡住',
      images: [],
      skills: [],
    })

    expect(state.isSendingMessage.value).toBe(false)
    expect(state.selectedQueuedMessages.value).toEqual([
      expect.objectContaining({
        text: '不要被后台刷新卡住',
        status: 'sending',
      }),
    ])
    expect(await loadLocalMessageOutboxItems()).toEqual([
      expect.objectContaining({ turnId: 'turn-accepted', status: 'sending' }),
    ])
  })

  it('restores an accepted send during hydration until a formal user item reconciles it', async () => {
    installBrowserGlobals('thread-a')
    const item = buildLocalMessageOutboxItem({
      threadId: 'thread-a',
      payload: { text: '已经被服务端接收', images: [], skills: [] },
    })
    await saveLocalMessageOutboxItem({ ...item, status: 'sending', turnId: 'turn-accepted' })
    codexApiMock.getThreadGroups.mockResolvedValueOnce([{
      projectName: 'repo', cwd: '/workspace/repo', threads: [{
        id: 'thread-a', title: 'Thread A', projectName: 'repo', cwd: '/workspace/repo',
        createdAtIso: '2026-07-07T00:00:00.000Z', updatedAtIso: '2026-07-07T00:01:00.000Z',
        preview: '', unread: false, inProgress: false,
      }],
    }])

    const state = useDesktopState()
    await state.refreshAll({ loadSelectedMessages: false })

    expect(state.selectedQueuedMessages.value).toEqual([
      expect.objectContaining({
        id: item.id,
        status: 'sending',
        text: '已经被服务端接收',
      }),
    ])
    expect(state.messages.value).toEqual([
      expect.objectContaining({
        id: `optimistic-user:${item.id}`,
        role: 'user',
        text: '已经被服务端接收',
        messageType: 'userMessage.optimistic',
      }),
    ])
    expect(await loadLocalMessageOutboxItems()).toEqual([
      expect.objectContaining({ id: item.id, turnId: 'turn-accepted', status: 'sending' }),
    ])

    state.startRealtimeSync()
    codexApiMock.getNotificationListener()?.({
      method: 'item/completed',
      atIso: '2026-07-07T00:00:01.000Z',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-accepted',
        item: {
          id: 'formal-user',
          type: 'userMessage',
          content: [{ type: 'text', text: '已经被服务端接收', text_elements: [] }],
        },
      },
    })
    await vi.waitFor(async () => {
      expect(await loadLocalMessageOutboxItems()).toEqual([])
    })
    expect(state.messages.value).toEqual([
      expect.objectContaining({ id: 'formal-user', role: 'user', text: '已经被服务端接收' }),
    ])
    state.stopRealtimeSync()
  })

  it('queues selected thread messages while a turn is already in progress', async () => {
    installBrowserGlobals('thread-a')
    const state = useDesktopState()
    state.startRealtimeSync()
    codexApiMock.getNotificationListener()?.({
      method: 'turn/started',
      params: {
        threadId: 'thread-a',
        turn: {
          id: 'turn-active',
          startedAt: '2026-07-07T00:00:00.000Z',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })

    await state.sendMessageToSelectedThread({
      text: '下一条排队处理',
      images: [],
      skills: [],
    })

    expect(codexApiMock.steerThreadTurn).not.toHaveBeenCalled()
    expect(codexApiMock.startThreadTurn).not.toHaveBeenCalled()
    expect(state.messages.value).toEqual([
      expect.objectContaining({
        role: 'user',
        text: '下一条排队处理',
        messageType: 'userMessage.optimistic',
      }),
    ])
    expect(state.selectedQueuedMessages.value).toEqual([
      expect.objectContaining({
        text: '下一条排队处理',
        status: 'queued',
      }),
    ])
    codexApiMock.getNotificationListener()?.({
      method: 'item/completed',
      atIso: '2026-07-07T00:00:01.000Z',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-active',
        item: {
          id: 'current-turn-user',
          type: 'userMessage',
          content: [{ type: 'text', text: '当前这一轮', text_elements: [] }],
        },
      },
    })
    expect(state.messages.value.some((message) => (
      message.text === '下一条排队处理' && message.messageType === 'userMessage.optimistic'
    ))).toBe(true)
    state.stopRealtimeSync()
  })

  it('sends a queued selected-thread message as guidance when requested during an active turn', async () => {
    installBrowserGlobals('thread-a')
    const state = useDesktopState()
    state.startRealtimeSync()
    codexApiMock.getNotificationListener()?.({
      method: 'turn/started',
      params: {
        threadId: 'thread-a',
        turn: {
          id: 'turn-active',
          startedAt: '2026-07-07T00:00:00.000Z',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })

    await state.sendMessageToSelectedThread({
      text: '马上插进去',
      images: [],
      skills: [],
    })
    const queuedMessage = state.selectedQueuedMessages.value[0]
    expect(queuedMessage).toMatchObject({ text: '马上插进去', status: 'queued' })

    await state.sendQueuedMessageNow('thread-a', queuedMessage.id)

    expect(codexApiMock.steerThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'turn-active',
      '马上插进去',
      [],
      [],
    )
    expect(state.selectedQueuedMessages.value).toEqual([])
    state.stopRealtimeSync()
  })

  it('steers the active turn when submit mode is steer', async () => {
    installBrowserGlobals('thread-a')
    const state = useDesktopState()
    state.setSelectedSubmitMode('steer')
    state.startRealtimeSync()
    codexApiMock.getNotificationListener()?.({
      method: 'turn/started',
      params: {
        threadId: 'thread-a',
        turn: {
          id: 'turn-active',
          startedAt: '2026-07-07T00:00:00.000Z',
        },
      },
      atIso: '2026-07-07T00:00:00.000Z',
    })

    await state.sendMessageToSelectedThread({
      text: '继续按这个方向做',
      images: [],
      skills: [],
    })

    expect(codexApiMock.steerThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      'turn-active',
      '继续按这个方向做',
      [],
      [],
    )
    expect(codexApiMock.startThreadTurn).not.toHaveBeenCalled()
    expect(state.messages.value.some((message) => message.messageType?.startsWith('userMessage.outbox.'))).toBe(false)
    state.stopRealtimeSync()
  })

  it('replaces a turn-linked optimistic skill message even when the item event arrives before turn/start returns', async () => {
    installBrowserGlobals('thread-a')
    const turnStart = deferred<string>()
    codexApiMock.startThreadTurn.mockImplementation(async () => turnStart.promise)
    codexApiMock.getThreadMessages.mockResolvedValue([])
    const state = useDesktopState()
    state.projectGroups.value = [{
      projectName: 'repo', cwd: '/workspace/repo', threads: [{
        id: 'thread-a', title: 'Thread A', projectName: 'repo', cwd: '/workspace/repo',
        createdAtIso: '2026-07-07T00:00:00.000Z', updatedAtIso: '2026-07-07T00:01:00.000Z',
        preview: '', unread: false, inProgress: false,
      }],
    }]
    state.startRealtimeSync()
    const send = state.sendMessageToSelectedThread({
      text: 'Review this', images: [],
      skills: [{ name: 'review', path: '/skills/review', displayName: 'Code Review', description: 'Detailed review' }],
    })
    const listener = codexApiMock.getNotificationListener()
    listener?.({
      method: 'item/completed', atIso: '2026-07-07T00:00:01.000Z',
      params: { threadId: 'thread-a', turnId: 'turn-1', item: {
        id: 'user-1', type: 'userMessage', content: [
          { type: 'skill', name: 'review', path: '/skills/review' },
          { type: 'text', text: 'Review this', text_elements: [] },
        ],
      } },
    })
    listener?.({
      method: 'item/completed', atIso: '2026-07-07T00:00:02.000Z',
      params: { threadId: 'thread-a', turnId: 'turn-1', item: { id: 'agent-1', type: 'agentMessage', text: 'Done' } },
    })
    turnStart.resolve('turn-1')
    await send
    expect(state.messages.value.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(state.messages.value.map((message) => message.id)).toEqual(['user-1', 'agent-1'])
  })

  it('keeps the turn mapping until a late formal user item arrives after turn completion', async () => {
    installBrowserGlobals('thread-a')
    codexApiMock.startThreadTurn.mockResolvedValue('turn-late')
    codexApiMock.getThreadMessages.mockResolvedValue([])
    const state = useDesktopState()
    state.projectGroups.value = [{
      projectName: 'repo', cwd: '/workspace/repo', threads: [{
        id: 'thread-a', title: 'Thread A', projectName: 'repo', cwd: '/workspace/repo',
        createdAtIso: '2026-07-07T00:00:00.000Z', updatedAtIso: '2026-07-07T00:01:00.000Z', preview: '', unread: false, inProgress: false,
      }],
    }]
    state.startRealtimeSync()
    await state.sendMessageToSelectedThread({ text: 'Late item', images: [], skills: [] })
    const listener = codexApiMock.getNotificationListener()
    listener?.({ method: 'turn/completed', atIso: '2026-07-07T00:00:02.000Z', params: { threadId: 'thread-a', turn: { id: 'turn-late' } } })
    listener?.({
      method: 'item/completed', atIso: '2026-07-07T00:00:03.000Z',
      params: { threadId: 'thread-a', turnId: 'turn-late', item: {
        id: 'user-late', type: 'userMessage', content: [{ type: 'text', text: 'Late item', text_elements: [] }],
      } },
    })
    expect(state.messages.value.filter((message) => message.role === 'user').map((message) => message.id)).toEqual(['user-late'])
  })

  it('sends explicit default collaboration mode after switching back from plan', async () => {
    installBrowserGlobals('thread-a')
    codexApiMock.startThreadTurn.mockResolvedValue('turn-1')

    const state = useDesktopState()
    state.setSelectedCollaborationModeName('plan')
    expect(state.selectedCollaborationModeName.value).toBe('plan')

    state.setSelectedCollaborationModeName('default')
    expect(state.selectedCollaborationModeName.value).toBe('default')

    await state.sendMessageToSelectedThread({
      text: '现在应该是 default 模式',
      images: [],
      skills: [],
    })

    expect(codexApiMock.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      '现在应该是 default 模式',
      [],
      [],
      undefined,
      'medium',
      {
        mode: 'default',
        settings: {
          model: '',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    )
  })

  it('preserves built-in Plan instructions while applying YOLO permission overrides', async () => {
    installBrowserGlobals('thread-a')
    codexApiMock.startThreadTurn.mockResolvedValue('turn-1')

    const state = useDesktopState()
    state.setSelectedCollaborationModeName('plan')
    state.setSelectedPermissionMode('yolo')

    await state.sendMessageToSelectedThread({
      text: '先规划并允许无审批探索',
      images: [],
      skills: [],
    })

    expect(codexApiMock.startThreadTurn).toHaveBeenCalledWith(
      'thread-a',
      '先规划并允许无审批探索',
      [],
      [],
      undefined,
      'medium',
      {
        mode: 'plan',
        settings: {
          model: '',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    )
  })

  it('returns new thread ids before the first turn finishes starting', async () => {
    installBrowserGlobals()
    const turnStart = deferred<string>()
    codexApiMock.startThread.mockResolvedValue('thread-new')
    codexApiMock.startThreadTurn.mockImplementation(async () => turnStart.promise)

    const state = useDesktopState()
    const createdThreadId = await state.sendMessageToNewThread({
      text: 'stream this response',
      images: [],
      skills: [],
    }, '/repo')

    expect(createdThreadId).toBe('thread-new')
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.selectedThread?.value?.inProgress).toBe(true)
    expect(state.isSendingMessage.value).toBe(false)
    expect(codexApiMock.startThreadTurn).toHaveBeenCalledWith(
      'thread-new',
      'stream this response',
      [],
      [],
      undefined,
      'medium',
      {
        mode: 'default',
        settings: {
          model: '',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    )
  })

  it('keeps newly created threads visible while server thread lists lag behind', async () => {
    installBrowserGlobals()
    const threadListRefresh = deferred<never[]>()
    const turnStart = deferred<string>()
    codexApiMock.startThread.mockResolvedValue('thread-new')
    codexApiMock.getThreadGroups.mockImplementation(async () => threadListRefresh.promise)
    codexApiMock.startThreadTurn.mockImplementation(async () => turnStart.promise)

    const state = useDesktopState()
    const createdThreadId = await state.sendMessageToNewThread({
      text: 'create and stream',
      images: [],
      skills: [],
    }, '/repo')

    expect(createdThreadId).toBe('thread-new')
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.selectedThread.value).toMatchObject({
      id: 'thread-new',
      title: 'Untitled thread',
      cwd: '/repo',
      preview: 'create and stream',
      inProgress: true,
    })
    expect(state.projectGroups.value.flatMap((group) => group.threads).map((thread) => thread.id)).toContain('thread-new')

    threadListRefresh.resolve([])
    await flushPromises()

    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.selectedThread.value?.id).toBe('thread-new')
    expect(state.projectGroups.value.flatMap((group) => group.threads).map((thread) => thread.id)).toEqual(['thread-new'])
  })

  it('keeps a new thread readable from optimistic send through live stream and final refresh', async () => {
    vi.useFakeTimers()
    installBrowserGlobals()
    const turnStart = deferred<string>()
    codexApiMock.startThread.mockResolvedValue('thread-new')
    codexApiMock.startThreadTurn.mockImplementation(async () => turnStart.promise)
    codexApiMock.getThreadGroups.mockResolvedValue([])
    codexApiMock.getThreadMessages.mockResolvedValue([])

    const state = useDesktopState()
    state.startRealtimeSync()
    const listener = codexApiMock.getNotificationListener()
    expect(listener).not.toBeNull()

    const createdThreadId = await state.sendMessageToNewThread({
      text: '帮我检查实时输出',
      images: [],
      skills: [],
    }, '/repo')

    expect(createdThreadId).toBe('thread-new')
    expect(state.selectedThreadId.value).toBe('thread-new')
    expect(state.selectedThread.value).toMatchObject({
      id: 'thread-new',
      cwd: '/repo',
      inProgress: true,
    })
    expect(state.messages.value).toEqual([
      expect.objectContaining({
        role: 'user',
        text: '帮我检查实时输出',
        messageType: 'userMessage.optimistic',
      }),
    ])

    turnStart.resolve('turn-1')
    await flushPromises()

    listener?.({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        itemId: 'agent-1',
        delta: '正在检查',
      },
      atIso: '2026-07-07T00:00:01.000Z',
    })

    expect(state.messages.value.map((message) => message.text)).toEqual([
      '帮我检查实时输出',
      '正在检查',
    ])

    codexApiMock.getThreadMessages.mockResolvedValue([
      {
        id: 'user-1',
        role: 'user',
        text: '帮我检查实时输出',
        messageType: 'userMessage',
      },
      {
        id: 'agent-1',
        role: 'assistant',
        text: '正在检查，已经完成。',
        messageType: 'agentMessage',
      },
    ])
    listener?.({
      method: 'item/completed',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        item: {
          id: 'user-1',
          type: 'userMessage',
          content: [
            { type: 'text', text: '帮我检查实时输出', text_elements: [] },
          ],
        },
      },
      atIso: '2026-07-07T00:00:02.000Z',
    })
    listener?.({
      method: 'item/completed',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        item: {
          id: 'agent-1',
          type: 'agentMessage',
          text: '正在检查，已经完成。',
        },
      },
      atIso: '2026-07-07T00:00:03.000Z',
    })
    listener?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: {
          id: 'turn-1',
          completedAt: '2026-07-07T00:00:04.000Z',
        },
      },
      atIso: '2026-07-07T00:00:04.000Z',
    })
    await vi.advanceTimersByTimeAsync(220)
    await flushPromises()

    expect(state.messages.value).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        text: '帮我检查实时输出',
        messageType: 'userMessage',
      }),
      expect.objectContaining({
        id: 'agent-1',
        role: 'assistant',
        text: '正在检查，已经完成。',
        messageType: 'agentMessage',
      }),
      expect.objectContaining({
        role: 'system',
        messageType: 'worked',
      }),
    ])
    expect(state.messages.value.filter((message) => message.text === '帮我检查实时输出')).toHaveLength(1)
    expect(state.messages.value.filter((message) => message.id === 'agent-1')).toHaveLength(1)

    state.stopRealtimeSync()
  })

  it('surfaces and clears new thread creation failures', async () => {
    installBrowserGlobals()
    codexApiMock.startThread.mockRejectedValue(new Error('start failed'))

    const state = useDesktopState()

    await expect(state.sendMessageToNewThread({
      text: 'create this thread',
      images: [],
      skills: [],
    }, '/repo')).rejects.toThrow('start failed')

    expect(state.error.value).toBe('start failed')

    state.clearError()

    expect(state.error.value).toBe('')
  })
})

describe('buildRollbackAuditMessage', () => {
  it('creates an auditable tool message for successful file rollbacks', () => {
    const message = buildRollbackAuditMessage(buildRollbackResult())

    expect(message).toMatchObject({
      id: 'tooling.rollback:checkpoint-1:src/app.ts',
      role: 'system',
      messageType: 'tool.rollback',
      tool: {
        kind: 'rollback',
        title: 'File rollback',
        status: 'completed',
        summary: 'Rolled back src/app.ts',
        outputLabel: 'Checkpoint patch',
      },
    })
    expect(message.tool?.details).toContain('checkpoint: checkpoint-1')
    expect(message.tool?.details).toContain('remaining status: clean')
    expect(buildThreadActivityEntries([message])[0]).toMatchObject({
      kind: 'rollback',
      messageId: message.id,
    })
  })

  it('records no-op rollback attempts without marking them as failures', () => {
    const message = buildRollbackAuditMessage(buildRollbackResult({ rollbackApplied: false }))

    expect(message.tool?.status).toBe('no changes')
    expect(message.tool?.summary).toBe('No local changes found for src/app.ts')
  })
})
