import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createFeishuRoutes, type FeishuAutoRouteDto, type FeishuBotDto, type FeishuConnectivityReportDto, type FeishuDiagnosticsDto, type FeishuRoutesDependencies } from './feishuRoutes'
import type { FeishuQrSetupJobDto } from '../feishuQrSetup'
import { emptyFeishuSetupChecks } from '../feishuQrSetupStore'

const bot: FeishuBotDto = {
  id: 'bot-1',
  name: 'Cody',
  appId: 'cli_a',
  platform: 'feishu',
  tenantId: 't_1',
  tenantName: 'Example',
  secretConfigured: true,
  enabled: true,
  allowAllUsers: false,
  allowedOpenIds: ['ou_a'],
  groupMentionMode: 'always',
  p2pMode: 'topic',
  status: 'connected',
  lastConnectedAtIso: '2026-07-18T00:00:00.000Z',
  lastHeartbeatAtIso: '2026-07-18T00:01:00.000Z',
  lastError: null,
  createdAtIso: '2026-07-18T00:00:00.000Z',
  updatedAtIso: '2026-07-18T00:00:00.000Z',
}

const qrJob: FeishuQrSetupJobDto = {
  id: 'job-1', name: 'Cody', status: 'awaiting_scan', statusMessage: 'scan',
  qrDataUrl: 'data:image/png;base64,qr', qrExpiresAtIso: '2026-07-18T00:03:00.000Z',
  account: null, bot: null, warnings: [], error: null, canRetry: false, canCancel: true, canConfirmIdentity: false,
  checks: emptyFeishuSetupChecks(),
  createdAtIso: '2026-07-18T00:00:00.000Z', updatedAtIso: '2026-07-18T00:00:00.000Z',
}

const autoRoute: FeishuAutoRouteDto = {
  id: 'route-1', botId: 'bot-1', chatId: 'oc_alerts', name: '差异播报', enabled: true,
  sourceSenderId: 'on_alert_bot', sourceSenderType: 'app', cardTitle: '【平台】差异播报',
  requiredKeywords: ['任务ID', '校验结果'], instruction: '分析根因', projectCwd: '/repo',
  projectName: 'Repo', sessionId: 'thread-1', sessionTitle: 'Alert triage',
  createdAtIso: '', updatedAtIso: '', lastMatchedAtIso: null, matchCount: 0,
}

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

function dependencies(): FeishuRoutesDependencies {
  return {
    listBots: vi.fn(async () => [bot]),
    createBot: vi.fn(async () => bot),
    updateBot: vi.fn(async () => bot),
    deleteBot: vi.fn(async () => ({ removed: true, remoteDisabled: false })),
    reconnectBot: vi.fn(async () => bot),
    diagnoseBot: vi.fn(async (botId): Promise<FeishuConnectivityReportDto> => ({
      botId, ok: true, generatedAtIso: '2026-07-18T01:02:00.000Z', latencyMs: 12,
      checks: [
        { id: 'configuration', status: 'pass', message: 'configured' },
        { id: 'enabled', status: 'pass', message: 'enabled' },
        { id: 'runtime', status: 'pass', message: 'running' },
        { id: 'long_connection', status: 'pass', message: 'connected' },
        { id: 'credential_api', status: 'pass', message: 'authenticated' },
        { id: 'bot_identity', status: 'pass', message: 'matched' },
      ],
    })),
    listBindings: vi.fn(async () => []),
    removeBinding: vi.fn(async () => true),
    listAutoRoutes: vi.fn(async () => []),
    setAutoRouteEnabled: vi.fn(async () => null),
    removeAutoRoute: vi.fn(async () => true),
    getDiagnostics: vi.fn(async (botId): Promise<FeishuDiagnosticsDto> => ({
      botId: botId ?? null,
      generatedAtIso: '2026-07-18T01:00:00.000Z',
      counts: {
        outbox: { pending: 1, sending: 0, sent: 3, failed: 1, deadLettered: 1 },
        turns: { queued: 0, running: 1, completed: 2, failed: 0, cancelled: 0 },
        cards: { creating: 0, streaming: 1, completed: 2, failed: 0, cancelled: 0 },
        audit: { success: 4, failed: 1 },
      },
      recentFailedDeliveries: [{
        id: 'outbox-1', kind: 'card.update', attempts: 3, error: 'rate limited', updatedAtIso: '2026-07-18T00:59:00.000Z',
        deadLetteredAtIso: '2026-07-18T00:59:00.000Z',
      }],
      recentTurns: [{ status: 'running', error: '', updatedAtIso: '2026-07-18T00:58:00.000Z' }],
      recentCards: [{ purpose: 'answer', status: 'streaming', version: 2, updatedAtIso: '2026-07-18T00:58:00.000Z' }],
      recentAuditLogs: [{ action: 'binding.create', success: true, error: '', createdAtIso: '2026-07-18T00:57:00.000Z' }],
    })),
    retryDelivery: vi.fn(async () => true),
    startQrSetup: vi.fn(() => { throw new Error('not configured') }),
    listQrSetups: vi.fn(() => []),
    getQrSetup: vi.fn(() => null),
    cancelQrSetup: vi.fn(async () => null),
    confirmQrSetupIdentity: vi.fn(async () => null),
    retryQrSetup: vi.fn(async () => null),
    inspectOpenPlatformSession: vi.fn(async () => ({ configured: false, valid: false, account: null, error: null })),
    clearOpenPlatformSession: vi.fn(async () => false),
    listOpenPlatformApps: vi.fn(async () => []),
    adoptOpenPlatformApp: vi.fn(async () => qrJob),
  }
}

async function invoke(route: ReturnType<typeof createFeishuRoutes>, method: string, path: string, body?: unknown) {
  const output = response()
  const handled = await route({ req: request(method, body), res: output.res, url: new URL(path, 'http://localhost') })
  return { handled, ...output.read() }
}

describe('createFeishuRoutes', () => {
  it('lists bots without exposing secrets', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'GET', '/codex-api/feishu/bots')
    expect(result).toMatchObject({ handled: true, statusCode: 200, body: { result: { bots: [bot] } } })
    expect(JSON.stringify(result.body)).not.toContain('appSecret')
  })

  it('lists, pauses, and removes fixed-session card routes', async () => {
    const deps = dependencies()
    deps.listAutoRoutes = vi.fn(async () => [autoRoute])
    deps.setAutoRouteEnabled = vi.fn(async (_id, enabled) => ({ ...autoRoute, enabled }))
    const route = createFeishuRoutes(deps)
    const listed = await invoke(route, 'GET', '/codex-api/feishu/auto-routes?botId=bot-1')
    expect(listed).toMatchObject({ statusCode: 200, body: { result: { routes: [autoRoute] } } })
    expect(deps.listAutoRoutes).toHaveBeenCalledWith('bot-1')
    const paused = await invoke(route, 'PATCH', '/codex-api/feishu/auto-routes/route-1', { enabled: false })
    expect(paused).toMatchObject({ statusCode: 200, body: { result: { route: { enabled: false } } } })
    expect(deps.setAutoRouteEnabled).toHaveBeenCalledWith('route-1', false)
    expect((await invoke(route, 'DELETE', '/codex-api/feishu/auto-routes/route-1')).statusCode).toBe(200)
    expect(deps.removeAutoRoute).toHaveBeenCalledWith('route-1')
  })

  it('validates and creates a bot', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'POST', '/codex-api/feishu/bots', {
      name: ' Cody ', appId: ' cli_a ', appSecret: ' secret ', platform: 'lark', enabled: true, allowedOpenIds: [' ou_a ', 'ou_a'],
    })
    expect(result.statusCode).toBe(201)
    expect(deps.createBot).toHaveBeenCalledWith({
      name: 'Cody', appId: 'cli_a', appSecret: 'secret', platform: 'lark', enabled: true, allowAllUsers: false, allowedOpenIds: ['ou_a'], groupMentionMode: 'always', p2pMode: 'topic',
    })
  })

  it('rejects missing or unknown manual credential platforms', async () => {
    const route = createFeishuRoutes(dependencies())
    const base = { name: 'Cody', appId: 'cli_a', appSecret: 'secret', enabled: false, allowedOpenIds: [] }
    expect((await invoke(route, 'POST', '/codex-api/feishu/bots', base)).statusCode).toBe(400)
    expect((await invoke(route, 'POST', '/codex-api/feishu/bots', { ...base, platform: 'auto' })).statusCode).toBe(400)
    expect((await invoke(route, 'PATCH', '/codex-api/feishu/bots/bot-1', { platform: 'auto' })).statusCode).toBe(400)
  })

  it('requires an explicit allowAllUsers flag for broad access', async () => {
    const deps = dependencies()
    const route = createFeishuRoutes(deps)
    await invoke(route, 'POST', '/codex-api/feishu/bots', {
      name: 'Closed', appId: 'cli_closed', appSecret: 'secret', platform: 'feishu', enabled: true, allowedOpenIds: [],
    })
    expect(deps.createBot).toHaveBeenLastCalledWith(expect.objectContaining({ allowAllUsers: false, allowedOpenIds: [] }))
    await invoke(route, 'POST', '/codex-api/feishu/bots', {
      name: 'Open', appId: 'cli_open', appSecret: 'secret', platform: 'feishu', enabled: true,
      allowAllUsers: true, allowedOpenIds: [],
    })
    expect(deps.createBot).toHaveBeenLastCalledWith(expect.objectContaining({ allowAllUsers: true, allowedOpenIds: [] }))
  })

  it('accepts only supported group mention modes', async () => {
    const deps = dependencies()
    const updated = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { groupMentionMode: 'topic' })
    expect(updated.statusCode).toBe(200)
    expect(deps.updateBot).toHaveBeenCalledWith('bot-1', { groupMentionMode: 'topic' })
    const platform = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { platform: 'lark' })
    expect(platform.statusCode).toBe(200)
    expect(deps.updateBot).toHaveBeenCalledWith('bot-1', { platform: 'lark' })
    const invalid = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { groupMentionMode: 'never' })
    expect(invalid.statusCode).toBe(400)
  })

  it('accepts only supported private-chat session modes', async () => {
    const deps = dependencies()
    const updated = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { p2pMode: 'chat' })
    expect(updated.statusCode).toBe(200)
    expect(deps.updateBot).toHaveBeenCalledWith('bot-1', { p2pMode: 'chat' })
    const invalid = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { p2pMode: 'forever' })
    expect(invalid.statusCode).toBe(400)
  })

  it('starts, reads, confirms identity, cancels, and retries QR setup jobs', async () => {
    const deps = dependencies()
    deps.startQrSetup = vi.fn(async () => qrJob)
    deps.getQrSetup = vi.fn(() => qrJob)
    deps.cancelQrSetup = vi.fn(async (): Promise<FeishuQrSetupJobDto> => ({ ...qrJob, status: 'cancelled', canCancel: false }))
    deps.confirmQrSetupIdentity = vi.fn(async (): Promise<FeishuQrSetupJobDto> => ({ ...qrJob, status: 'creating_app', canCancel: false }))
    deps.retryQrSetup = vi.fn(async (): Promise<FeishuQrSetupJobDto> => ({ ...qrJob, status: 'configuring', canCancel: false }))
    const route = createFeishuRoutes(deps)

    const started = await invoke(route, 'POST', '/codex-api/feishu/qr-setup', { name: 'Cody' })
    expect(started.statusCode).toBe(202)
    expect(deps.startQrSetup).toHaveBeenCalledWith({
      name: 'Cody', allowAllUsers: false, allowedOpenIds: [], groupMentionMode: 'always', p2pMode: 'topic',
      availability: { mode: 'creator', memberIds: [], groupIds: [] },
    })
    expect((started.body as any).result.job.qrDataUrl).toContain('data:image/png')
    expect((await invoke(route, 'GET', '/codex-api/feishu/qr-setup/job-1')).statusCode).toBe(200)
    deps.listQrSetups = vi.fn(() => [qrJob])
    const listed = await invoke(route, 'GET', '/codex-api/feishu/qr-setup')
    expect((listed.body as any).result.jobs).toHaveLength(1)
    expect((await invoke(route, 'POST', '/codex-api/feishu/qr-setup/job-1/confirm')).statusCode).toBe(200)
    expect(deps.confirmQrSetupIdentity).toHaveBeenCalledWith('job-1')
    expect((await invoke(route, 'POST', '/codex-api/feishu/qr-setup/job-1/cancel')).statusCode).toBe(200)
    expect((await invoke(route, 'POST', '/codex-api/feishu/qr-setup/job-1/retry')).statusCode).toBe(200)
  })

  it('validates explicit member and group availability selections', async () => {
    const deps = dependencies()
    deps.startQrSetup = vi.fn(async () => qrJob)
    const route = createFeishuRoutes(deps)
    const valid = await invoke(route, 'POST', '/codex-api/feishu/qr-setup', {
      name: 'Members',
      availability: { mode: 'members', memberIds: [' u_1 ', 'u_1', 'u_2'], groupIds: [] },
    })
    expect(valid.statusCode).toBe(202)
    expect(deps.startQrSetup).toHaveBeenCalledWith(expect.objectContaining({
      availability: { mode: 'members', memberIds: ['u_1', 'u_2'], groupIds: [] },
    }))
    const invalid = await invoke(route, 'POST', '/codex-api/feishu/qr-setup', {
      name: 'No groups', availability: { mode: 'groups', memberIds: [], groupIds: [] },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('inspects and clears the cached Open Platform authorization', async () => {
    const deps = dependencies()
    deps.inspectOpenPlatformSession = vi.fn(async () => ({
      configured: true, valid: true,
      account: { userName: 'Alice', email: null, tenantName: 'Example' }, error: null,
    }))
    deps.clearOpenPlatformSession = vi.fn(async () => true)
    const route = createFeishuRoutes(deps)
    const inspected = await invoke(route, 'GET', '/codex-api/feishu/open-platform-session')
    expect(inspected).toMatchObject({ statusCode: 200, body: { result: { session: { valid: true } } } })
    const cleared = await invoke(route, 'DELETE', '/codex-api/feishu/open-platform-session')
    expect(cleared).toMatchObject({ statusCode: 200, body: { result: { cleared: true } } })
  })

  it('lists and adopts an existing Open Platform application', async () => {
    const deps = dependencies()
    deps.listOpenPlatformApps = vi.fn(async () => [{ appId: 'cli_existing', name: 'Existing', description: null }])
    const route = createFeishuRoutes(deps)
    const listed = await invoke(route, 'GET', '/codex-api/feishu/open-platform-apps')
    expect(listed).toMatchObject({ statusCode: 200, body: { result: { apps: [{ appId: 'cli_existing' }] } } })
    const adopted = await invoke(route, 'POST', '/codex-api/feishu/qr-setup/adopt', { appId: 'cli_existing', name: 'Recovered' })
    expect(adopted.statusCode).toBe(202)
    expect(deps.adoptOpenPlatformApp).toHaveBeenCalledWith('cli_existing', {
      name: 'Recovered', allowAllUsers: false, allowedOpenIds: [], groupMentionMode: 'always', p2pMode: 'topic',
      availability: { mode: 'creator', memberIds: [], groupIds: [] },
    })
  })

  it('preserves an existing secret when PATCH omits appSecret', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'PATCH', '/codex-api/feishu/bots/bot-1', { enabled: false })
    expect(result.statusCode).toBe(200)
    expect(deps.updateBot).toHaveBeenCalledWith('bot-1', { enabled: false })
  })

  it('deletes a bot through its dedicated destructive route', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'DELETE', '/codex-api/feishu/bots/bot-1')
    expect(result).toMatchObject({ handled: true, statusCode: 200, body: { result: { removed: true } } })
    expect(deps.deleteBot).toHaveBeenCalledWith('bot-1', 'keep')

    await invoke(createFeishuRoutes(deps), 'DELETE', '/codex-api/feishu/bots/bot-1?remoteAction=disable')
    expect(deps.deleteBot).toHaveBeenLastCalledWith('bot-1', 'disable')
  })

  it('runs a live connectivity diagnostic through a dedicated action route', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'POST', '/codex-api/feishu/bots/bot%2F1/diagnose', {})
    expect(result).toMatchObject({ handled: true, statusCode: 200, body: { result: { report: { botId: 'bot/1', ok: true } } } })
    expect(deps.diagnoseBot).toHaveBeenCalledWith('bot/1')
  })

  it('filters bindings and removes one', async () => {
    const deps = dependencies()
    await invoke(createFeishuRoutes(deps), 'GET', '/codex-api/feishu/bindings?botId=bot-1')
    expect(deps.listBindings).toHaveBeenCalledWith('bot-1')
    const removed = await invoke(createFeishuRoutes(deps), 'DELETE', '/codex-api/feishu/bindings/binding%3A1')
    expect(removed.statusCode).toBe(200)
    expect(deps.removeBinding).toHaveBeenCalledWith('binding:1')
  })

  it('returns a bot-filtered safe diagnostic summary', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'GET', '/codex-api/feishu/diagnostics?botId=bot-1')
    expect(result).toMatchObject({
      handled: true,
      statusCode: 200,
      body: { result: { diagnostics: { botId: 'bot-1', counts: { outbox: { failed: 1 } } } } },
    })
    expect(deps.getDiagnostics).toHaveBeenCalledWith('bot-1')
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toMatch(/payload|prompt|appSecret|approval/i)
    expect(serialized).toContain('rate limited')
  })

  it('requeues only the requested bot delivery', async () => {
    const deps = dependencies()
    const result = await invoke(createFeishuRoutes(deps), 'POST', '/codex-api/feishu/bots/bot%2F1/outbox/outbox%3A1/retry', {})
    expect(result).toMatchObject({ handled: true, statusCode: 200, body: { result: { requeued: true } } })
    expect(deps.retryDelivery).toHaveBeenCalledWith('bot/1', 'outbox:1')
  })

  it('does not claim unrelated routes', async () => {
    const result = await invoke(createFeishuRoutes(dependencies()), 'GET', '/codex-api/catalog')
    expect(result.handled).toBe(false)
  })
})
