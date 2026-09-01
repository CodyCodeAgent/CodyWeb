// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopRealtimeState } from './useDesktopRealtimeState'

function buildInput() {
  return {
    hydratePreferences: vi.fn(async () => undefined),
    loadPendingApprovals: vi.fn(async () => undefined),
    refreshRateLimits: vi.fn(async () => undefined),
    resetDomainState: vi.fn(),
  }
}

describe('useDesktopRealtimeState', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('bootstraps product state without raw RPC forwarding or polling', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const input = buildInput()
    const state = useDesktopRealtimeState(input)

    state.startRealtimeSync()

    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(input.hydratePreferences).toHaveBeenCalledTimes(1)
    expect(input.loadPendingApprovals).toHaveBeenCalledTimes(1)
    expect(input.refreshRateLimits).toHaveBeenCalledTimes(1)
  })

  it('resets only its own product state when a tab stops', () => {
    const firstInput = buildInput()
    const secondInput = buildInput()
    const first = useDesktopRealtimeState(firstInput)
    const second = useDesktopRealtimeState(secondInput)

    first.startRealtimeSync(); second.startRealtimeSync(); first.stopRealtimeSync()
    expect(firstInput.resetDomainState).toHaveBeenCalledTimes(1)
    expect(secondInput.resetDomainState).not.toHaveBeenCalled()
  })
})
