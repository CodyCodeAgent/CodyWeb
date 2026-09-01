import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_SERVER_DIAGNOSTICS_RPC_TIMEOUT_MS,
  APP_SERVER_RPC_TIMEOUT_MS,
  attachCodexBridgeWebSocketServer,
  CODEX_BRIDGE_WEBSOCKET_MAX_BUFFERED_BYTES,
  CODEX_APP_SERVER_ARGS,
  appServerRpcTimeoutMessage,
  createAutomaticTurnCheckpoint,
  createCodexBridgeMiddleware,
  isAppServerAlreadyInitializedError,
  mergeMcpServerDiagnostics,
  normalizeApprovalDecisionScope,
  normalizeConversationThreadSubscriptions,
  normalizeMcpServerInventory,
  readApprovalDecisionFromReply,
} from './codexAppServerBridge'
import { listToolingCheckpoints } from './toolingService'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

describe('app-server launch contract', () => {
  it('uses stdio transport explicitly for JSON-RPC bridge traffic', () => {
    expect(CODEX_APP_SERVER_ARGS).toEqual(['app-server', '--listen', 'stdio://'])
  })

  it('uses bounded RPC timeouts for stuck bridge requests', () => {
    expect(APP_SERVER_RPC_TIMEOUT_MS).toBeGreaterThan(APP_SERVER_DIAGNOSTICS_RPC_TIMEOUT_MS)
    expect(APP_SERVER_DIAGNOSTICS_RPC_TIMEOUT_MS).toBeGreaterThan(0)
    expect(appServerRpcTimeoutMessage('thread/list', 1234))
      .toBe('codex app-server RPC thread/list timed out after 1234ms')
  })

  it('treats duplicate app-server initialization as reusable state', () => {
    expect(isAppServerAlreadyInitializedError(new Error('Already initialized'))).toBe(true)
    expect(isAppServerAlreadyInitializedError({ error: { message: 'already initialized' } })).toBe(true)
    expect(isAppServerAlreadyInitializedError(new Error('initialize failed'))).toBe(false)
  })
})

describe('browser conversation projections', () => {
  it('accepts only a small deduplicated thread subscription set', () => {
    expect(normalizeConversationThreadSubscriptions([' thread-a ', 'thread-a', '', 7, 'thread-b']))
      .toEqual(['thread-a', 'thread-b'])
    expect(normalizeConversationThreadSubscriptions(Array.from({ length: 40 }, (_, index) => `thread-${String(index)}`)))
      .toHaveLength(32)
    expect(normalizeConversationThreadSubscriptions({ threadIds: ['thread-a'] })).toEqual([])
  })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-bridge-'))
  tempDirs.push(dir)
  await git(dir, ['init'])
  await git(dir, ['config', 'user.email', 'cody-web-ui@example.test'])
  await git(dir, ['config', 'user.name', 'CodyWeb'])
  await writeFile(join(dir, 'example.txt'), 'one\n', 'utf8')
  await git(dir, ['add', 'example.txt'])
  await git(dir, ['commit', '-m', 'initial'])
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })))
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind test server to a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function readFirstWebSocketMessage(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for websocket message'))
    }, 3000)

    socket.once('message', (data) => {
      clearTimeout(timeout)
      socket.close()
      try {
        resolve(JSON.parse(String(data)))
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function openReadyWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for websocket ready frame'))
    }, 3000)
    socket.once('message', (data) => {
      clearTimeout(timeout)
      try {
        const message = JSON.parse(String(data)) as { type?: string }
        if (message.type !== 'ready') throw new Error('Expected websocket ready frame')
        resolve(socket)
      } catch (error) {
        socket.close()
        reject(error)
      }
    })
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function waitForWebSocketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket message')), 3000)
    socket.once('message', (data) => {
      clearTimeout(timeout)
      try {
        resolve(JSON.parse(String(data)))
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const body = await response.json() as unknown
  expect(response.ok).toBe(true)
  return body
}

async function readJsonResponse(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init)
  return {
    status: response.status,
    body: await response.json() as unknown,
  }
}

describe('bridge server request endpoints', () => {
  it('lists pending approvals and routes replies through the Core conversation owner', async () => {
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const replies: unknown[] = []
    const fakeAppServer = {
      listPendingServerRequests: () => [
        {
          id: 42,
          method: 'item/commandExecution/requestApproval',
          threadId: 'thread-approval',
          turnId: 'turn-approval',
          itemId: 'item-approval',
          receivedAtIso: '2026-07-09T10:00:00.000Z',
          params: {
            command: 'npm test',
            cwd: '/repo',
          },
        },
      ],
      respondToServerRequest: async (payload: unknown) => {
        replies.push(payload)
      },
      noteConversationApprovalScope: () => {},
      dispose: () => {},
      getDiagnostics: () => ({
        status: 'running',
        pid: null,
        initialized: true,
        startedAtIso: '2026-07-09T10:00:00.000Z',
        exitedAtIso: null,
        exitCode: null,
        exitSignal: null,
        pendingClientRequestCount: 0,
        pendingServerRequestCount: 1,
        sentClientRequestCount: 0,
        completedClientRequestCount: 0,
        failedClientRequestCount: 0,
        notificationCount: 0,
        serverRequestCount: 1,
        notificationCountsByMethod: {},
        pendingServerRequests: [],
        mcpServers: [],
        mcpInventoryError: '',
        recentLogs: [],
      }),
      rpc: async () => ({}),
      onNotification: () => () => {},
    }
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    globalScope[sharedBridgeKey] = {
      appServer: fakeAppServer,
      conversations: {
        submit: async () => ({ clientCommandId: 'test-command' }),
        attach: async () => {},
        interrupt: async () => false,
        respondServerRequest: async (payload: unknown) => { replies.push(payload) },
        subscribe: () => () => {},
        dispose: async () => {},
      },
      catalogSync: {
        start: () => {},
        stop: () => {},
        syncNow: async () => {},
        refreshForRead: async () => {},
        onNotification: () => {},
        getStatus: () => ({ successCount: 1 }),
      },
      methodCatalog: {
        listMethods: async () => [],
        listNotificationMethods: async () => [],
      },
      stopNotificationDispatch: () => {},
      productEventHub: {
        clear: () => {},
        subscribe: () => () => {},
        emit: () => {},
      },
    }
    const middleware = createCodexBridgeMiddleware()
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.writeHead(404)
        res.end()
      })
    })

    try {
      const port = await listen(server)
      const baseUrl = `http://127.0.0.1:${String(port)}`
      await expect(readJson(`${baseUrl}/codex-api/server-requests/pending`)).resolves.toEqual({
        data: [
          expect.objectContaining({
            id: 42,
            method: 'item/commandExecution/requestApproval',
            threadId: 'thread-approval',
          }),
        ],
      })

      await expect(readJson(`${baseUrl}/codex-api/server-requests/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 42,
          approvalScope: 'workspace',
          result: { decision: 'accept' },
        }),
      })).resolves.toEqual({ ok: true })
      expect(replies).toEqual([
        {
          id: 42,
          approvalScope: 'workspace',
          result: { decision: 'accept' },
        },
      ])
      await expect(readJsonResponse(`${baseUrl}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'thread/resume', params: { threadId: 'thread-restored' } }),
      })).resolves.toMatchObject({
        status: 410,
      })
    } finally {
      middleware.dispose()
      await closeServer(server)
      delete globalScope[sharedBridgeKey]
    }
  })

  it('keeps smoke-only hooks disabled unless explicitly enabled', async () => {
    const previousSmokeHooks = process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const injectedPayloads: unknown[] = []
    const fakeAppServer = {
      listPendingServerRequests: () => [],
      respondToServerRequest: async () => {},
      injectSmokeServerRequest: (payload: unknown) => {
        injectedPayloads.push(payload)
        return {
          id: 900000,
          method: 'item/commandExecution/requestApproval',
          params: payload,
          receivedAtIso: '2026-07-09T10:00:00.000Z',
          commandPolicy: null,
          fileChangePolicy: null,
          isSmokeInjected: true,
        }
      },
      dispose: () => {},
      getDiagnostics: () => ({
        status: 'running',
        pid: null,
        initialized: true,
        startedAtIso: '2026-07-09T10:00:00.000Z',
        exitedAtIso: null,
        exitCode: null,
        exitSignal: null,
        pendingClientRequestCount: 0,
        pendingServerRequestCount: 0,
        sentClientRequestCount: 0,
        completedClientRequestCount: 0,
        failedClientRequestCount: 0,
        notificationCount: 0,
        serverRequestCount: 0,
        notificationCountsByMethod: {},
        pendingServerRequests: [],
        mcpServers: [],
        mcpInventoryError: '',
        recentLogs: [],
      }),
      rpc: async () => ({}),
      onNotification: () => () => {},
    }
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    globalScope[sharedBridgeKey] = {
      appServer: fakeAppServer,
      conversations: {
        submit: async () => ({ clientCommandId: 'test-command' }),
        attach: async () => {},
        interrupt: async () => false,
        subscribe: () => () => {},
        dispose: async () => {},
      },
      catalogSync: {
        start: () => {},
        stop: () => {},
        syncNow: async () => {},
        refreshForRead: async () => {},
        onNotification: () => {},
        getStatus: () => ({ successCount: 1 }),
      },
      methodCatalog: {
        listMethods: async () => [],
        listNotificationMethods: async () => [],
      },
      stopNotificationDispatch: () => {},
      productEventHub: {
        clear: () => {},
        subscribe: () => () => {},
        emit: () => {},
      },
    }
    const middleware = createCodexBridgeMiddleware()
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.writeHead(404)
        res.end()
      })
    })

    try {
      const port = await listen(server)
      const baseUrl = `http://127.0.0.1:${String(port)}`
      const body = {
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      }

      delete process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS
      await expect(readJsonResponse(`${baseUrl}/codex-api/smoke/server-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).resolves.toEqual({
        status: 404,
        body: { error: 'Not found' },
      })
      expect(injectedPayloads).toEqual([])
      await expect(readJsonResponse(`${baseUrl}/codex-api/smoke/controlled-process-epipe`, {
        method: 'POST',
      })).resolves.toEqual({
        status: 404,
        body: { error: 'Not found' },
      })

      process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS = '1'
      await expect(readJson(`${baseUrl}/codex-api/smoke/server-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).resolves.toEqual({
        result: expect.objectContaining({
          id: 900000,
          isSmokeInjected: true,
        }),
      })
      expect(injectedPayloads).toEqual([body])
      await expect(readJson(`${baseUrl}/codex-api/smoke/controlled-process-epipe`, {
        method: 'POST',
      })).resolves.toMatchObject({ result: { exitCode: 0 } })
    } finally {
      if (previousSmokeHooks === undefined) {
        delete process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS
      } else {
        process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS = previousSmokeHooks
      }
      middleware.dispose()
      await closeServer(server)
      delete globalScope[sharedBridgeKey]
    }
  })
})

describe('bridge websocket server', () => {
  it('bounds each client send buffer independently', () => {
    expect(CODEX_BRIDGE_WEBSOCKET_MAX_BUFFERED_BYTES).toBeGreaterThan(0)
    expect(CODEX_BRIDGE_WEBSOCKET_MAX_BUFFERED_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('accepts websocket upgrades and sends a ready frame', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const disposeWebSocketServer = attachCodexBridgeWebSocketServer(server)

    try {
      const port = await listen(server)
      await expect(readFirstWebSocketMessage(`ws://127.0.0.1:${String(port)}/codex-api/ws`)).resolves.toMatchObject({
        type: 'ready',
      })
    } finally {
      disposeWebSocketServer()
      await closeServer(server)
    }
  })

  it('keeps a second browser client alive when the first client closes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const disposeWebSocketServer = attachCodexBridgeWebSocketServer(server)
    let first: WebSocket | undefined
    let second: WebSocket | undefined

    try {
      const port = await listen(server)
      const url = `ws://127.0.0.1:${String(port)}/codex-api/ws`
      ;[first, second] = await Promise.all([openReadyWebSocket(url), openReadyWebSocket(url)])
      await new Promise<void>((resolve) => {
        first?.once('close', () => resolve())
        first?.close()
      })

      const pong = waitForWebSocketMessage(second)
      second.send(JSON.stringify({ type: 'ping' }))
      await expect(pong).resolves.toMatchObject({ type: 'pong' })
    } finally {
      first?.close()
      second?.close()
      disposeWebSocketServer()
      await closeServer(server)
    }
  })
})

describe('shared bridge ownership', () => {
  it('disposes the app-server only after the last middleware owner releases it', () => {
    const sharedBridgeKey = '__codexRemoteSharedBridge__'
    const disposeAppServer = vi.fn()
    const disposeConversations = vi.fn(async () => {})
    const stopCatalog = vi.fn()
    const stopNotifications = vi.fn()
    const clearProductEvents = vi.fn()
    const stopFeishu = vi.fn(async () => {})
    const globalScope = globalThis as typeof globalThis & Record<string, unknown>
    globalScope[sharedBridgeKey] = {
      ownerCount: 0,
      appServer: {
        dispose: disposeAppServer,
        rpc: async () => ({}),
        respondToServerRequest: async () => {},
        listPendingServerRequests: () => [],
        isServerRequestPending: () => false,
        onNotification: () => () => {},
      },
      conversations: {
        submit: async () => ({ clientCommandId: 'test-command' }),
        attach: async () => ({ events: [] }),
        interrupt: async () => false,
        subscribe: () => () => {},
        dispose: disposeConversations,
      },
      catalogSync: {
        stop: stopCatalog,
        syncNow: async () => {},
        refreshForRead: async () => {},
        onNotification: () => {},
        getStatus: () => ({ successCount: 1 }),
      },
      methodCatalog: {
        listMethods: async () => [],
        listNotificationMethods: async () => [],
      },
      stopNotificationDispatch: stopNotifications,
      productEventHub: {
        clear: clearProductEvents,
        subscribe: () => () => {},
        emit: () => {},
      },
      feishuIntegration: {
        routes: [],
        start: async () => {},
        stop: stopFeishu,
        draftScenarioPackage: async () => ({}),
      },
    }

    const first = createCodexBridgeMiddleware()
    const second = createCodexBridgeMiddleware()
    first.dispose()
    expect(disposeAppServer).not.toHaveBeenCalled()
    expect(stopCatalog).not.toHaveBeenCalled()

    second.dispose()
    expect(disposeAppServer).toHaveBeenCalledTimes(1)
    expect(disposeConversations).toHaveBeenCalledTimes(1)
    expect(stopCatalog).toHaveBeenCalledTimes(1)
    expect(stopNotifications).toHaveBeenCalledTimes(1)
    expect(clearProductEvents).toHaveBeenCalledTimes(1)
    expect(stopFeishu).toHaveBeenCalledTimes(1)
    delete globalScope[sharedBridgeKey]
  })
})

describe('MCP diagnostics helpers', () => {
  it('normalizes mcpServerStatus/list responses into safe inventory summaries', () => {
    const rows = normalizeMcpServerInventory({
      data: [
        {
          name: 'github',
          authStatus: 'oAuth',
          serverInfo: {
            title: 'GitHub',
            version: '1.2.3',
            websiteUrl: 'https://github.com',
          },
          tools: {
            listIssues: {},
            createPullRequest: {},
          },
          resources: [{ name: 'repo', uri: 'repo://current' }],
          resourceTemplates: [{ name: 'issue', uriTemplate: 'issue://{id}' }],
        },
      ],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'github',
      status: 'unknown',
      authStatus: 'oAuth',
      title: 'GitHub',
      version: '1.2.3',
      websiteUrl: 'https://github.com',
      toolCount: 2,
      resourceCount: 1,
      resourceTemplateCount: 1,
      error: '',
      threadId: '',
    })
  })

  it('merges startup failures with inventory metadata without losing failure evidence', () => {
    const startup = normalizeMcpServerInventory({
      data: [
        {
          name: 'github',
          authStatus: 'oAuth',
          serverInfo: { title: 'GitHub', version: '1.0.0' },
          tools: {},
          resources: [],
          resourceTemplates: [],
        },
      ],
    }).map((row) => ({
      ...row,
      status: 'failed' as const,
      error: 'token expired',
      threadId: 'thread-1',
      updatedAtIso: '2026-07-05T10:00:00.000Z',
    }))

    const inventory = normalizeMcpServerInventory({
      data: [
        {
          name: 'github',
          authStatus: 'notLoggedIn',
          serverInfo: { title: 'GitHub MCP', version: '2.0.0' },
          tools: { read: {}, write: {} },
          resources: [],
          resourceTemplates: [],
        },
      ],
    })

    expect(mergeMcpServerDiagnostics(startup, inventory)).toEqual([
      expect.objectContaining({
        name: 'github',
        status: 'failed',
        authStatus: 'notLoggedIn',
        title: 'GitHub MCP',
        version: '2.0.0',
        toolCount: 2,
        error: 'token expired',
        threadId: 'thread-1',
        updatedAtIso: '2026-07-05T10:00:00.000Z',
      }),
    ])
  })
})

describe('approval audit helpers', () => {
  it('normalizes explicit and legacy approval scopes', () => {
    expect(normalizeApprovalDecisionScope('workspace')).toBe('workspace')
    expect(normalizeApprovalDecisionScope('permanent')).toBe('permanent')
    expect(normalizeApprovalDecisionScope(undefined, 'acceptForSession')).toBe('session')
    expect(normalizeApprovalDecisionScope(undefined, 'accept')).toBe('single')
    expect(normalizeApprovalDecisionScope('unknown', 'acceptForSession')).toBe('session')
  })

  it('reads approval decisions from server request replies', () => {
    expect(readApprovalDecisionFromReply({ result: { decision: 'acceptForSession' } })).toBe('acceptForSession')
    expect(readApprovalDecisionFromReply({ result: {} })).toBe('responded')
    expect(readApprovalDecisionFromReply({ error: { code: -32000, message: 'nope' } })).toBe('rejected')
  })
})

describe('automatic turn checkpoints', () => {
  it('backs off repeated attempts after a workspace checkpoint failure', async () => {
    const missingWorkspace = join(tmpdir(), `cody-web-ui-missing-${String(Date.now())}`)
    const notification = {
      method: 'turn/started',
      params: { turn: { id: 'turn-failure', threadId: 'thread-failure' } },
    }

    await expect(createAutomaticTurnCheckpoint(missingWorkspace, notification)).rejects.toThrow()
    await expect(createAutomaticTurnCheckpoint(missingWorkspace, notification)).resolves.toMatchObject({
      beforeCheckpointSkipped: true,
      beforeCheckpointReason: 'checkpoint-failure-backoff',
      beforeCheckpointFailureCount: 1,
      beforeCheckpointRetryAtIso: expect.any(String),
    })
  })

  it('deduplicates an unchanged after-turn checkpoint', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')

    const before = await createAutomaticTurnCheckpoint(repo, {
      method: 'turn/started',
      params: {
        turn: {
          id: 'turn-123456789',
          threadId: 'thread-abcdef',
        },
      },
    })
    const after = await createAutomaticTurnCheckpoint(repo, {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-123456789',
          threadId: 'thread-abcdef',
        },
      },
    })
    const ignored = await createAutomaticTurnCheckpoint(repo, {
      method: 'item/completed',
      params: {},
    })

    expect(before).toMatchObject({
      beforeCheckpointHasPatch: true,
    })
    expect(typeof before.beforeCheckpointId).toBe('string')
    expect(after).toEqual({
      afterCheckpointSkipped: true,
      afterCheckpointReason: 'workspace-unchanged',
    })
    expect(ignored).toEqual({})

    const checkpoints = await listToolingCheckpoints({ cwd: repo, limit: 10 })
    const createdCheckpointIds = new Set([
      before.beforeCheckpointId,
    ])
    const createdCheckpoints = checkpoints.filter((checkpoint) => createdCheckpointIds.has(checkpoint.id))
    expect(createdCheckpoints).toHaveLength(1)
    expect(createdCheckpoints[0]?.label).toBe('Before turn turn-123 (thread-a)')
  }, 20_000)

  it('creates an after-turn checkpoint when the workspace changed during the turn', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'before\n', 'utf8')
    await createAutomaticTurnCheckpoint(repo, {
      method: 'turn/started',
      params: { turn: { id: 'turn-changed', threadId: 'thread-changed' } },
    })
    await writeFile(join(repo, 'example.txt'), 'after\n', 'utf8')
    const result = await createAutomaticTurnCheckpoint(repo, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-changed', threadId: 'thread-changed' } },
    })
    expect(result).toMatchObject({ afterCheckpointHasPatch: true })
    expect(typeof result.afterCheckpointId).toBe('string')
  }, 20_000)

  it('does not recursively copy untracked directories for automatic checkpoints', async () => {
    const repo = await createRepo()
    await mkdir(join(repo, '.tmp-go-cache', 'nested'), { recursive: true })
    await writeFile(join(repo, '.tmp-go-cache', 'nested', 'cache.bin'), 'large-cache-placeholder')
    await writeFile(join(repo, 'draft.txt'), 'source draft\n')

    const result = await createAutomaticTurnCheckpoint(repo, {
      method: 'turn/started',
      params: { turn: { id: 'turn-safe', threadId: 'thread-safe' } },
    })
    const checkpointId = String(result.beforeCheckpointId)
    const checkpointRoot = join(repo, '.git/cody-web-ui-checkpoints', checkpointId)
    const metadata = JSON.parse(await readFile(join(checkpointRoot, 'metadata.json'), 'utf8')) as {
      untrackedBytes: number
      skippedUntrackedPaths: string[]
      partial: boolean
    }

    expect(await readFile(join(checkpointRoot, 'untracked/draft.txt'), 'utf8')).toBe('source draft\n')
    await expect(readFile(join(checkpointRoot, 'untracked/.tmp-go-cache/nested/cache.bin'), 'utf8')).rejects.toThrow()
    expect(metadata.untrackedBytes).toBe(Buffer.byteLength('source draft\n'))
    expect(metadata.skippedUntrackedPaths).toContain('.tmp-go-cache/')
    expect(metadata.partial).toBe(true)
  })
})
