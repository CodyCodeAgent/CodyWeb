// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcNotification } from '../api/codexRealtimeClient'
import { useDesktopRealtimeState } from './useDesktopRealtimeState'

const notificationListeners = new Set<(notification: RpcNotification) => void>()

vi.mock('../api/codexRealtimeClient', () => ({
  subscribeRpcNotifications: vi.fn((listener: (notification: RpcNotification) => void) => {
    notificationListeners.add(listener)
    return () => notificationListeners.delete(listener)
  }),
}))

function buildInput() {
  return {
    hydratePreferences: vi.fn(async () => undefined),
    loadPendingApprovals: vi.fn(async () => undefined),
    refreshRateLimits: vi.fn(async () => undefined),
    applyNotification: vi.fn(),
    queueNotificationSync: vi.fn(),
    syncThreadStatus: vi.fn(async () => undefined),
    resetDomainState: vi.fn(),
  }
}

describe('useDesktopRealtimeState', () => {
  beforeEach(() => {
    notificationListeners.clear()
    vi.restoreAllMocks()
  })

  it('uses push notifications without starting an automatic polling timer', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const input = buildInput()
    const state = useDesktopRealtimeState(input)

    state.startRealtimeSync()

    const notification: RpcNotification = {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1' } },
      atIso: '2026-09-01T08:00:00.000Z',
    }
    for (const listener of notificationListeners) listener(notification)

    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(input.syncThreadStatus).not.toHaveBeenCalled()
    expect(input.hydratePreferences).toHaveBeenCalledTimes(1)
    expect(input.loadPendingApprovals).toHaveBeenCalledTimes(1)
    expect(input.refreshRateLimits).toHaveBeenCalledTimes(1)
    expect(input.applyNotification).toHaveBeenCalledWith(notification)
    expect(input.queueNotificationSync).toHaveBeenCalledWith(notification)
  })

  it('keeps independent subscribers isolated like separate browser tabs', () => {
    const firstInput = buildInput()
    const secondInput = buildInput()
    const first = useDesktopRealtimeState(firstInput)
    const second = useDesktopRealtimeState(secondInput)

    first.startRealtimeSync()
    second.startRealtimeSync()
    first.stopRealtimeSync()

    const notification: RpcNotification = {
      method: 'thread/status/changed',
      params: { threadId: 'thread-2' },
      atIso: '2026-09-01T08:01:00.000Z',
    }
    for (const listener of notificationListeners) listener(notification)

    expect(firstInput.applyNotification).not.toHaveBeenCalled()
    expect(firstInput.resetDomainState).toHaveBeenCalledTimes(1)
    expect(secondInput.applyNotification).toHaveBeenCalledWith(notification)
  })
})
