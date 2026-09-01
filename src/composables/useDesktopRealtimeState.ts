export function useDesktopRealtimeState(input: {
  hydratePreferences: () => Promise<void>
  loadPendingApprovals: () => Promise<void>
  refreshRateLimits: () => Promise<unknown>
  resetDomainState: () => void
}) {
  function startRealtimeSync(): void {
    if (typeof window === 'undefined') return
    // Conversation transport is owned by Core. Product bootstrap is deliberately
    // one-shot: forwarding every raw App Server RPC to every browser tab made a
    // slow tab a backpressure source and created reconnect churn.
    void input.hydratePreferences()
    void input.loadPendingApprovals()
    void input.refreshRateLimits()
  }

  function stopRealtimeSync(): void {
    input.resetDomainState()
  }

  return { startRealtimeSync, stopRealtimeSync }
}
