import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApiError } from './codexErrors'
import {
  fetchAuthSessionSnapshot,
  fetchGatewayDiagnostics,
  fetchTrustedDevices,
  reloadMcpServers,
  trustCurrentDevice,
} from './codexGatewayStatusClient'

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

describe('codex gateway status client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads validated gateway diagnostics responses', async () => {
    mockFetch(new Response(JSON.stringify({
      result: {
        generatedAtIso: '2026-07-07T00:00:00.000Z',
        appServer: {
          mcpServers: [],
        },
        methodCatalog: {
          methods: ['thread/list'],
          notifications: ['turn/started'],
        },
      },
    }), { status: 200 }))

    await expect(fetchGatewayDiagnostics()).resolves.toMatchObject({
      generatedAtIso: '2026-07-07T00:00:00.000Z',
      methodCatalog: {
        methods: ['thread/list'],
      },
    })
  })

  it('rejects malformed gateway diagnostics responses', async () => {
    mockFetch(new Response(JSON.stringify({
      result: {
        generatedAtIso: '2026-07-07T00:00:00.000Z',
        appServer: {},
        methodCatalog: {
          methods: [],
          notifications: [],
        },
      },
    }), { status: 200 }))

    await expect(fetchGatewayDiagnostics()).rejects.toBeInstanceOf(CodexApiError)
  })

  it('treats unauthenticated auth session responses as valid state', async () => {
    mockFetch(new Response(JSON.stringify({ authenticated: false }), { status: 401 }))

    await expect(fetchAuthSessionSnapshot()).resolves.toEqual({ authenticated: false })
  })

  it('reads trusted devices and device trust actions', async () => {
    mockFetch(new Response(JSON.stringify({
      devices: [
        {
          id: 'device-1',
          trusted: true,
        },
      ],
    }), { status: 200 }))

    await expect(fetchTrustedDevices()).resolves.toMatchObject({
      devices: [
        {
          id: 'device-1',
        },
      ],
    })

    mockFetch(new Response(JSON.stringify({
      ok: true,
      deviceId: 'device-1',
    }), { status: 200 }))

    await expect(trustCurrentDevice()).resolves.toEqual({
      ok: true,
      deviceId: 'device-1',
    })
  })

  it('reloads MCP servers through the explicit runtime endpoint', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(reloadMcpServers()).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledWith('/codex-api/runtime/mcp/reload', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }))
  })
})
