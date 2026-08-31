import { subscribeRpcNotifications, type RpcNotification } from '../api/codexRealtimeClient'

export function useDesktopRealtimeState(input: {
  hydratePreferences: () => Promise<void>
  loadPendingApprovals: () => Promise<void>
  refreshRateLimits: () => Promise<unknown>
  applyNotification: (notification: RpcNotification) => void
  queueNotificationSync: (notification: RpcNotification) => void
  resetDomainState: () => void
}) {
  let stopNotificationStream: (() => void) | null = null

  function startRealtimeSync(): void {
    if (typeof window === 'undefined' || stopNotificationStream) return
    stopNotificationStream = subscribeRpcNotifications((notification) => {
      input.applyNotification(notification)
      input.queueNotificationSync(notification)
    })
    void input.hydratePreferences()
    void input.loadPendingApprovals()
    void input.refreshRateLimits()
  }

  function stopRealtimeSync(): void {
    stopNotificationStream?.()
    stopNotificationStream = null
    input.resetDomainState()
  }

  return { startRealtimeSync, stopRealtimeSync }
}
