import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => ({
  bridgeDispose: vi.fn(),
  websocketDispose: vi.fn(),
  attachCodexBridgeWebSocketServer: vi.fn(() => bridgeMock.websocketDispose),
  createCodexBridgeMiddleware: vi.fn(() => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) => next()
    return Object.assign(middleware, {
      dispose: bridgeMock.bridgeDispose,
    })
  }),
}))

vi.mock('./codexAppServerBridge.js', () => ({
  attachCodexBridgeWebSocketServer: bridgeMock.attachCodexBridgeWebSocketServer,
  createCodexBridgeMiddleware: bridgeMock.createCodexBridgeMiddleware,
}))

const tempDirs: string[] = []

async function createDistFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-http-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>CodyWeb</title><main>app shell</main>', 'utf8')
  await writeFile(join(dir, 'asset.txt'), 'static asset', 'utf8')
  return dir
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not bind a TCP port'))
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

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })))
})

describe('httpServer', () => {
  it('serves meta API, static assets, and SPA fallback without starting the real bridge', async () => {
    const { createServer } = await import('./httpServer.js')
    const distDir = await createDistFixture()
    const instance = createServer({
      distDir,
      host: '127.0.0.1',
      port: null,
    })
    const server = createHttpServer(instance.app)

    try {
      const port = await listen(server)
      const baseUrl = `http://127.0.0.1:${String(port)}`

      const versionResponse = await fetch(`${baseUrl}/codex-api/meta/version`)
      await expect(versionResponse.json()).resolves.toMatchObject({
        result: {
          version: '0.1.0',
          gitSha: expect.stringMatching(/^(?:[0-9a-f]{7,12}|unknown)$/),
          gitDirty: expect.any(Boolean),
          sourceFingerprint: expect.stringMatching(/^(?:[0-9a-f]{16}|unknown)$/),
          buildId: expect.stringMatching(/^(?:[0-9a-f]{7,12}|unknown)(?:-dirty)?\.(?:[0-9a-f]{16}|unknown)$/),
          builtAt: expect.any(String),
          label: expect.stringContaining('v0.1.0'),
        },
      })
      expect(versionResponse.headers.get('cache-control')).toBe('no-store')

      await expect(fetch(`${baseUrl}/codex-api/meta/access-security`).then((response) => response.json())).resolves.toMatchObject({
        result: {
          auth: {
            enabled: false,
          },
          network: {
            listenHost: '127.0.0.1',
            listenPort: null,
            listenExposure: 'loopback',
          },
        },
      })

      for (const forwardedProto of ['http', 'https']) {
        const feishuResponse = await fetch(`${baseUrl}/codex-api/feishu/bots`, {
          headers: { 'x-forwarded-proto': forwardedProto },
        })
        expect(feishuResponse.status).toBe(200)
        await expect(feishuResponse.text()).resolves.toContain('app shell')
      }

      await expect(fetch(`${baseUrl}/asset.txt`).then((response) => response.text())).resolves.toBe('static asset')
      await expect(fetch(`${baseUrl}/thread/example`).then((response) => response.text())).resolves.toContain('app shell')
    } finally {
      instance.dispose()
      await closeServer(server)
    }

    expect(bridgeMock.createCodexBridgeMiddleware).toHaveBeenCalledTimes(1)
    expect(bridgeMock.bridgeDispose).toHaveBeenCalledTimes(1)
  })

  it('keeps Feishu management behind the normal CodyWeb login on plain HTTP', async () => {
    const { createServer } = await import('./httpServer.js')
    const distDir = await createDistFixture()
    const instance = createServer({
      distDir,
      host: '0.0.0.0',
      port: null,
      password: 'test-password',
      authDatabasePath: join(distDir, 'settings.sqlite3'),
    })
    const server = createHttpServer(instance.app)

    try {
      const port = await listen(server)
      const baseUrl = `http://127.0.0.1:${String(port)}`
      const beforeLogin = await fetch(`${baseUrl}/codex-api/feishu/bots`)
      expect(beforeLogin.status).toBe(200)
      await expect(beforeLogin.text()).resolves.toContain('Password')

      const login = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-password' }),
      })
      const rows = (login.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
        ?? [login.headers.get('set-cookie') ?? '']
      const cookie = rows.flatMap(row => row.split(/,(?=\s*cody_web_ui_)/u))
        .map(row => row.split(';')[0]?.trim() ?? '').filter(Boolean).join('; ')
      const afterLogin = await fetch(`${baseUrl}/codex-api/feishu/bots`, { headers: { cookie } })
      expect(afterLogin.status).toBe(200)
      await expect(afterLogin.text()).resolves.toContain('app shell')
    } finally {
      instance.dispose()
      await closeServer(server)
    }
  })

  it('serves token-scoped conversation shares without login while protecting share management', async () => {
    const { createServer } = await import('./httpServer.js')
    const distDir = await createDistFixture()
    const instance = createServer({
      distDir,
      host: '0.0.0.0',
      port: null,
      password: 'test-password',
      authDatabasePath: join(distDir, 'settings.sqlite3'),
    })
    const server = createHttpServer(instance.app)

    try {
      const port = await listen(server)
      const baseUrl = `http://127.0.0.1:${String(port)}`
      const blockedCreate = await fetch(`${baseUrl}/codex-api/conversation-shares`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(blockedCreate.status).toBe(200)
      await expect(blockedCreate.text()).resolves.toContain('Password')

      const login = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-password' }),
      })
      const rows = (login.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
        ?? [login.headers.get('set-cookie') ?? '']
      const cookie = rows.flatMap(row => row.split(/,(?=\s*cody_web_ui_)/u))
        .map(row => row.split(';')[0]?.trim() ?? '').filter(Boolean).join('; ')
      const create = await fetch(`${baseUrl}/codex-api/conversation-shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          threadId: 'thread-public',
          expiresInDays: 30,
          snapshot: {
            version: 1, locale: 'en', title: 'Public debugging notes', threadTitle: 'Debug', projectName: 'project',
            createdAtIso: '', selectedTurnIds: ['turn-1'],
            options: { includeToolDetails: false, redactLocalPaths: true },
            messages: [
              { id: 'u1', turnId: 'turn-1', role: 'user', text: 'What changed?', messageType: 'userMessage', imageCount: 0, tool: null },
              { id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'The parser was fixed.', messageType: 'agentMessage', imageCount: 0, tool: null },
            ],
          },
        }),
      })
      expect(create.status).toBe(201)
      const createPayload = await create.json() as { result: { share: { id: string; publicPath: string } } }

      const publicPage = await fetch(`${baseUrl}${createPayload.result.share.publicPath}`)
      expect(publicPage.status).toBe(200)
      expect(publicPage.headers.get('x-robots-tag')).toContain('noindex')
      const publicHtml = await publicPage.text()
      expect(publicHtml).toContain('Public debugging notes')
      expect(publicHtml).toContain('Read-only share')
      expect(publicHtml).toContain(`${createPayload.result.share.publicPath}/image.svg`)

      const publicImage = await fetch(`${baseUrl}${createPayload.result.share.publicPath}/image.svg`)
      expect(publicImage.status).toBe(200)
      expect(publicImage.headers.get('content-type')).toContain('image/svg+xml')
      const publicImageSvg = await publicImage.text()
      expect(publicImageSvg).toContain('READ-ONLY SNAPSHOT')
      expect(publicImageSvg).toContain('Public debugging notes')

      const list = await fetch(`${baseUrl}/codex-api/conversation-shares?threadId=thread-public`, { headers: { cookie } })
      await expect(list.json()).resolves.toMatchObject({ result: { shares: [{ title: 'Public debugging notes' }] } })

      const revoke = await fetch(`${baseUrl}/codex-api/conversation-shares/${createPayload.result.share.id}`, {
        method: 'DELETE', headers: { cookie },
      })
      expect(revoke.status).toBe(200)
      expect((await fetch(`${baseUrl}${createPayload.result.share.publicPath}`)).status).toBe(410)
      expect((await fetch(`${baseUrl}${createPayload.result.share.publicPath}/image.svg`)).status).toBe(410)
      const missing = await fetch(`${baseUrl}/share/not-a-valid-token`, { headers: { 'accept-language': 'en-US' } })
      expect(missing.status).toBe(404)
      await expect(missing.text()).resolves.toContain('Share not found')
    } finally {
      instance.dispose()
      await closeServer(server)
    }
  })
})
