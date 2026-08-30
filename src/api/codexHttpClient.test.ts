import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApiError } from './codexErrors'
import {
  fetchCodexJson,
  fetchCodexResultRecord,
  jsonPostInit,
  queryPath,
  readEnvelopeResultRecord,
  readRpcResult,
} from './codexHttpClient'

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

describe('codex http client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds JSON POST requests', () => {
    expect(jsonPostInit({ ok: true })).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{"ok":true}',
    })
  })

  it('builds query paths while omitting nullish params', () => {
    expect(queryPath('/codex-api/test', {
      cwd: '/repo path',
      limit: 20,
      includeArchived: false,
      empty: '',
      missing: undefined,
      nil: null,
    })).toBe('/codex-api/test?cwd=%2Frepo+path&limit=20&includeArchived=false&empty=')
  })

  it('reads successful JSON responses', async () => {
    mockFetch(new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }))

    await expect(fetchCodexJson('/codex-api/test', {
      method: 'test/method',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'request failed',
    })).resolves.toEqual({
      payload: { result: { ok: true } },
      status: 200,
    })
  })

  it('converts HTTP failures to CodexApiError with backend messages', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'backend says no' } }), { status: 503 }))

    await expect(fetchCodexJson('/codex-api/test', {
      method: 'test/method',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'request failed',
    })).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'http_error',
      method: 'test/method',
      status: 503,
      message: 'backend says no',
    })
  })

  it('returns accepted non-2xx statuses without throwing', async () => {
    mockFetch(new Response(JSON.stringify({ authenticated: false }), { status: 401 }))

    await expect(fetchCodexJson('/auth/session', {
      acceptedStatuses: [401],
      method: 'auth/session',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'auth failed',
    })).resolves.toEqual({
      payload: { authenticated: false },
      status: 401,
    })
  })

  it('converts network failures to CodexApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket closed')
    }))

    await expect(fetchCodexJson('/codex-api/test', {
      method: 'test/method',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'request failed',
    })).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'network_error',
      method: 'test/method',
      message: 'socket closed',
    })
  })

  it('aborts a stalled request at the caller deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))

    const request = fetchCodexJson('/codex-api/test', {
      method: 'turn/start',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'request failed',
      timeoutMs: 25,
    })
    const expectation = expect(request).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'timeout_error',
      method: 'turn/start',
      message: 'turn/start timed out after 25ms',
    })
    await vi.advanceTimersByTimeAsync(25)
    await expectation
    vi.useRealTimers()
  })

  it('reads RPC result envelopes and rejects malformed responses', () => {
    expect(readRpcResult<{ ok: boolean }>({ result: { ok: true } }, 200, 'rpc/method', 'bad envelope')).toEqual({
      ok: true,
    })

    expect(() => readRpcResult({}, 200, 'rpc/method', 'bad envelope')).toThrow(CodexApiError)
  })

  it('reads record results from standard envelopes', () => {
    expect(readEnvelopeResultRecord({ result: { ok: true } }, 200, 'meta/test', 'bad response')).toEqual({
      ok: true,
    })

    expect(() => readEnvelopeResultRecord({ result: null }, 200, 'meta/test', 'bad response')).toThrow(CodexApiError)
  })

  it('fetches record results with response status', async () => {
    mockFetch(new Response(JSON.stringify({ result: { ok: true } }), { status: 201 }))

    await expect(fetchCodexResultRecord('/codex-api/test', {
      method: 'test/method',
      networkErrorMessage: 'network failed',
      httpErrorMessage: 'request failed',
      malformedMessage: 'bad response',
    })).resolves.toEqual({
      result: { ok: true },
      status: 201,
    })
  })
})
