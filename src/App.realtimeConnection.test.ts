import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.vue', import.meta.url), 'utf8')

describe('App realtime connection architecture', () => {
  it('derives connection state from WebSocket events without HTTP health polling', () => {
    expect(appSource).toContain('subscribeRealtimeConnection(handleRealtimeConnection)')
    expect(appSource).toContain('reconnectCodexRealtime()')
    expect(appSource).not.toContain('/codex-api/meta/version')
    expect(appSource).not.toContain('setInterval(')
  })

  it('exposes manual shell refresh without auto-refresh UI wiring', () => {
    expect(appSource).toContain('@refresh="onRefreshShell"')
    expect(appSource).not.toContain('toggle-auto-refresh')
    expect(appSource).not.toContain('autoRefreshButtonLabel')
  })
})
