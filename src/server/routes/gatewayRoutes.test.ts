import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createGatewayRoutes } from './gatewayRoutes'

function request(method: string, body?: unknown): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage
  Object.assign(emitter, {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  })
  return emitter
}

function response(): { res: ServerResponse; read: () => { statusCode: number; body: unknown } } {
  let raw = ''
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { raw = value ?? '' }),
  } as unknown as ServerResponse
  return { res, read: () => ({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) as unknown : null }) }
}

function gateway() {
  return {
    listConversationThreads: vi.fn(async () => [{ threadId: 'thread-1' }]),
    listConversationModels: vi.fn(async () => [{ id: 'gpt-5' }]),
    listConversationCollaborationModes: vi.fn(async () => [{ mode: 'default' }]),
    readRuntimeConfig: vi.fn(async () => ({ config: {} })),
    reloadMcpServers: vi.fn(async () => ({ reloaded: true })),
    readAccountRateLimits: vi.fn(async () => ({ rateLimits: null })),
    listConversationSkills: vi.fn(async () => [{ name: 'docs' }]),
    listConversationSkillCatalog: vi.fn(async () => [{ cwd: '/repo', skills: [] }]),
    setConversationSkillEnabled: vi.fn(async () => undefined),
    startConversationThread: vi.fn(async () => ({ threadId: 'thread-1' })),
    renameConversationThread: vi.fn(async () => undefined),
    forkConversationThread: vi.fn(async () => ({ threadId: 'thread-2' })),
    compactConversationThread: vi.fn(async () => undefined),
    archiveConversationThread: vi.fn(async () => undefined),
    attachConversation: vi.fn(async () => ({ events: [] })),
    snapshotConversation: vi.fn(async () => ({ events: [], watermark: 0 })),
    submitConversation: vi.fn(async () => ({ clientCommandId: 'command-1' })),
    interruptConversation: vi.fn(async () => false),
    respond: vi.fn(async () => undefined),
    listPending: vi.fn(() => []),
    listMethods: vi.fn(async () => []),
    listNotifications: vi.fn(async () => []),
    diagnostics: vi.fn(async () => ({})),
    accessSecurity: vi.fn(() => ({})),
  }
}

async function invoke(route: ReturnType<typeof createGatewayRoutes>, method: string, path: string, body?: unknown) {
  const output = response()
  const handled = await route({ req: request(method, body), res: output.res, url: new URL(path, 'http://localhost') })
  return { handled, ...output.read() }
}

describe('createGatewayRoutes conversation owner boundary', () => {
  it('does not expose a generic native RPC tunnel', async () => {
    const deps = gateway()
    const result = await invoke(createGatewayRoutes(deps), 'POST', '/codex-api/rpc', { method: 'turn/start', params: {} })
    expect(result).toMatchObject({ handled: true, statusCode: 410 })
  })

  it('serves runtime maintenance through explicit owner operations', async () => {
    const deps = gateway()
    const route = createGatewayRoutes(deps)
    await expect(invoke(route, 'GET', '/codex-api/runtime/config')).resolves.toMatchObject({ statusCode: 200, body: { result: { config: {} } } })
    await expect(invoke(route, 'POST', '/codex-api/runtime/mcp/reload', {})).resolves.toMatchObject({ statusCode: 200, body: { result: { reloaded: true } } })
    await expect(invoke(route, 'GET', '/codex-api/account/rate-limits')).resolves.toMatchObject({ statusCode: 200, body: { result: { rateLimits: null } } })
  })

  it('serves catalog and thread creation from the Core owner', async () => {
    const deps = gateway()
    const route = createGatewayRoutes(deps)
    await expect(invoke(route, 'GET', '/codex-api/conversations/threads?archived=true')).resolves.toMatchObject({
      statusCode: 200, body: { result: [{ threadId: 'thread-1' }] },
    })
    expect(deps.listConversationThreads).toHaveBeenCalledWith({ archived: true })

    await expect(invoke(route, 'POST', '/codex-api/conversations/threads/start', { context: { thread: { cwd: '/repo' } } })).resolves.toMatchObject({
      statusCode: 201, body: { result: { threadId: 'thread-1' } },
    })
    expect(deps.startConversationThread).toHaveBeenCalledWith({ thread: { cwd: '/repo' } })
  })

  it('serves composer model and skill state from the Core owner', async () => {
    const deps = gateway()
    const route = createGatewayRoutes(deps)
    await expect(invoke(route, 'GET', '/codex-api/conversations/models')).resolves.toMatchObject({
      statusCode: 200, body: { result: [{ id: 'gpt-5' }] },
    })
    await expect(invoke(route, 'GET', '/codex-api/conversations/skills?cwd=%2Frepo&cwd=%2Frepo')).resolves.toMatchObject({
      statusCode: 200, body: { result: [{ name: 'docs' }] },
    })
    expect(deps.listConversationSkills).toHaveBeenCalledWith(['/repo'])
    await expect(invoke(route, 'POST', '/codex-api/conversations/skills/enabled', { path: '/repo/.agents/docs/SKILL.md', enabled: false })).resolves.toMatchObject({
      statusCode: 200, body: { result: { ok: true } },
    })
    expect(deps.setConversationSkillEnabled).toHaveBeenCalledWith('/repo/.agents/docs/SKILL.md', false)
  })
})
