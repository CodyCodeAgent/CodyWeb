import { asRecord, readJsonBody, readString, setJson, type DomainRoute } from './httpRoute.js'
import type { FeishuQrSetupJobDto } from '../feishuQrSetup.js'

export type FeishuBotStatusDto = 'connected' | 'connecting' | 'disconnected' | 'error'
export type FeishuGroupMentionModeDto = 'always' | 'topic' | 'bound'
export type FeishuP2pModeDto = 'topic' | 'chat'

export type FeishuBotDto = {
  id: string
  name: string
  appId: string
  platform: 'feishu' | 'lark'
  tenantId: string
  tenantName: string
  secretConfigured: boolean
  enabled: boolean
  allowAllUsers: boolean
  allowedOpenIds: string[]
  allowedChatIds?: string[]
  groupMentionMode: FeishuGroupMentionModeDto
  p2pMode?: FeishuP2pModeDto
  status: FeishuBotStatusDto
  lastConnectedAtIso: string | null
  lastHeartbeatAtIso: string | null
  lastError: string | null
  createdAtIso: string
  updatedAtIso: string
}

export type FeishuBindingDto = {
  id: string
  botId: string
  botName: string
  scopeType: 'private' | 'group' | 'topic'
  chatId: string
  threadId: string | null
  projectCwd: string
  projectName: string
  sessionId: string | null
  sessionTitle: string | null
  collaborationMode: 'default' | 'plan'
  permissionMode: 'normal' | 'yolo'
  userOpenId: string | null
  createdAtIso: string
  updatedAtIso: string
  lastMessageAtIso: string | null
}

export type FeishuAutoRouteDto = {
  id: string
  botId: string
  chatId: string
  name: string
  enabled: boolean
  sourceSenderId: string
  sourceSenderType: 'app' | 'bot'
  cardTitle: string
  requiredKeywords: string[]
  instruction: string
  projectCwd: string
  projectName: string
  sessionId: string
  sessionTitle: string
  createdAtIso: string
  updatedAtIso: string
  lastMatchedAtIso: string | null
  matchCount: number
}

export type FeishuBotWriteInput = {
  name?: string
  appId?: string
  appSecret?: string
  platform?: 'feishu' | 'lark'
  /** Internal onboarding metadata; HTTP body readers intentionally ignore it. */
  tenantId?: string
  /** Internal onboarding metadata; HTTP body readers intentionally ignore it. */
  tenantName?: string
  enabled?: boolean
  allowAllUsers?: boolean
  allowedOpenIds?: string[]
  allowedChatIds?: string[]
  groupMentionMode?: FeishuGroupMentionModeDto
  p2pMode?: FeishuP2pModeDto
}

export type FeishuOpenPlatformSessionDto = {
  configured: boolean
  valid: boolean
  account: { userName: string; email: string | null; tenantName: string } | null
  error: string | null
}

export type FeishuOpenPlatformAppDto = { appId: string; name: string; description: string | null }
export type FeishuAvailabilityInputDto = {
  mode: 'creator' | 'members' | 'groups' | 'all'
  memberIds: string[]
  groupIds: string[]
}

export type FeishuDiagnosticsDto = {
  botId: string | null
  generatedAtIso: string
  counts: {
    outbox: Record<'pending' | 'sending' | 'sent' | 'failed' | 'deadLettered', number>
    turns: Record<'queued' | 'running' | 'completed' | 'failed' | 'cancelled', number>
    cards: Record<'creating' | 'streaming' | 'completed' | 'failed' | 'cancelled', number>
    audit: { success: number; failed: number }
  }
  recentFailedDeliveries: Array<{
    id: string
    kind: string
    attempts: number
    error: string
    updatedAtIso: string
    deadLetteredAtIso: string | null
  }>
  recentTurns: Array<{
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    error: string
    updatedAtIso: string
  }>
  recentCards: Array<{
    purpose: string
    status: 'creating' | 'streaming' | 'completed' | 'failed' | 'cancelled'
    version: number
    updatedAtIso: string
  }>
  recentAuditLogs: Array<{
    action: string
    success: boolean
    error: string
    createdAtIso: string
  }>
}

export type FeishuConnectivityReportDto = {
  botId: string
  ok: boolean
  generatedAtIso: string
  latencyMs: number
  checks: Array<{
    id: 'configuration' | 'enabled' | 'runtime' | 'long_connection' | 'credential_api' | 'bot_identity'
    status: 'pass' | 'fail'
    message: string
  }>
}

export type FeishuRoutesDependencies = {
  listBots: () => Promise<FeishuBotDto[]>
  createBot: (input: Required<Pick<FeishuBotWriteInput, 'name' | 'appId' | 'platform' | 'enabled' | 'allowAllUsers' | 'allowedOpenIds' | 'groupMentionMode'>> & Pick<FeishuBotWriteInput, 'tenantId' | 'tenantName' | 'allowedChatIds' | 'p2pMode'> & { appSecret: string }) => Promise<FeishuBotDto>
  updateBot: (botId: string, input: FeishuBotWriteInput) => Promise<FeishuBotDto>
  deleteBot: (botId: string, remoteAction: 'keep' | 'disable') => Promise<{ removed: boolean; remoteDisabled: boolean }>
  reconnectBot: (botId: string) => Promise<FeishuBotDto>
  diagnoseBot: (botId: string) => Promise<FeishuConnectivityReportDto>
  listBindings: (botId?: string) => Promise<FeishuBindingDto[]>
  removeBinding: (bindingId: string) => Promise<boolean>
  listAutoRoutes: (botId?: string) => Promise<FeishuAutoRouteDto[]>
  setAutoRouteEnabled: (routeId: string, enabled: boolean) => Promise<FeishuAutoRouteDto | null>
  removeAutoRoute: (routeId: string) => Promise<boolean>
  getDiagnostics: (botId?: string) => Promise<FeishuDiagnosticsDto>
  retryDelivery: (botId: string, outboxId: string) => Promise<boolean>
  startQrSetup: (input: { name: string; allowAllUsers: boolean; allowedOpenIds: string[]; groupMentionMode: FeishuGroupMentionModeDto; p2pMode: FeishuP2pModeDto; availability: FeishuAvailabilityInputDto }) => Promise<FeishuQrSetupJobDto>
  listQrSetups: () => FeishuQrSetupJobDto[]
  getQrSetup: (jobId: string) => FeishuQrSetupJobDto | null
  cancelQrSetup: (jobId: string) => Promise<FeishuQrSetupJobDto | null>
  confirmQrSetupIdentity: (jobId: string) => Promise<FeishuQrSetupJobDto | null>
  retryQrSetup: (jobId: string) => Promise<FeishuQrSetupJobDto | null>
  inspectOpenPlatformSession: () => Promise<FeishuOpenPlatformSessionDto>
  clearOpenPlatformSession: () => Promise<boolean>
  listOpenPlatformApps: () => Promise<FeishuOpenPlatformAppDto[]>
  adoptOpenPlatformApp: (appId: string, input: { name: string; allowAllUsers: boolean; allowedOpenIds: string[]; groupMentionMode: FeishuGroupMentionModeDto; p2pMode: FeishuP2pModeDto; availability: FeishuAvailabilityInputDto }) => Promise<FeishuQrSetupJobDto>
}

function readAllowedOpenIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
}

function readAllowedChatIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
}

function readGroupMentionMode(value: unknown): FeishuGroupMentionModeDto | null {
  return value === 'always' || value === 'topic' || value === 'bound' ? value : null
}

function readP2pMode(value: unknown): FeishuP2pModeDto | null {
  return value === 'topic' || value === 'chat' ? value : null
}

function readPlatform(value: unknown): 'feishu' | 'lark' | null {
  return value === 'feishu' || value === 'lark' ? value : null
}

function readAvailability(value: unknown): FeishuAvailabilityInputDto | null {
  if (value === undefined) return { mode: 'creator', memberIds: [], groupIds: [] }
  const row = asRecord(value)
  if (!row) return null
  const mode = row.mode === 'members' || row.mode === 'groups' || row.mode === 'all' ? row.mode : row.mode === 'creator' ? 'creator' : null
  const memberIds = readAllowedOpenIds(row.memberIds)
  const groupIds = readAllowedOpenIds(row.groupIds)
  if (!mode || !memberIds || !groupIds) return null
  if (mode === 'members' && memberIds.length === 0) return null
  if (mode === 'groups' && groupIds.length === 0) return null
  return { mode, memberIds, groupIds }
}

function readCreateInput(body: Record<string, unknown> | null): Parameters<FeishuRoutesDependencies['createBot']>[0] | null {
  const name = readString(body?.name)
  const appId = readString(body?.appId)
  const appSecret = readString(body?.appSecret)
  const platform = readPlatform(body?.platform)
  const allowedOpenIds = readAllowedOpenIds(body?.allowedOpenIds)
  const allowedChatIds = body && 'allowedChatIds' in body ? readAllowedChatIds(body.allowedChatIds) : undefined
  const allowAllUsers = body?.allowAllUsers === true
  const groupMentionMode = body && 'groupMentionMode' in body ? readGroupMentionMode(body.groupMentionMode) : 'always'
  const p2pMode = body && 'p2pMode' in body ? readP2pMode(body.p2pMode) : 'topic'
  if (!name || !appId || !appSecret || !platform || typeof body?.enabled !== 'boolean' || !allowedOpenIds || allowedChatIds === null || !groupMentionMode || !p2pMode) return null
  return {
    name, appId, appSecret, platform, enabled: body.enabled, allowAllUsers, allowedOpenIds, groupMentionMode, p2pMode,
    ...(allowedChatIds ? { allowedChatIds } : {}),
  }
}

function readQrSetupInput(body: Record<string, unknown> | null): Parameters<FeishuRoutesDependencies['startQrSetup']>[0] | null {
  const name = readString(body?.name)
  const allowedOpenIds = body && 'allowedOpenIds' in body ? readAllowedOpenIds(body.allowedOpenIds) : []
  const allowAllUsers = body?.allowAllUsers === true
  const groupMentionMode = body && 'groupMentionMode' in body ? readGroupMentionMode(body.groupMentionMode) : 'always'
  const p2pMode = body && 'p2pMode' in body ? readP2pMode(body.p2pMode) : 'topic'
  const availability = readAvailability(body?.availability)
  if (!name || !allowedOpenIds || !groupMentionMode || !p2pMode || !availability) return null
  return { name, allowAllUsers, allowedOpenIds, groupMentionMode, p2pMode, availability }
}

function readUpdateInput(body: Record<string, unknown> | null): FeishuBotWriteInput | null {
  if (!body) return null
  const input: FeishuBotWriteInput = {}
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) return null
    input.name = body.name.trim()
  }
  if ('appId' in body) {
    if (typeof body.appId !== 'string' || !body.appId.trim()) return null
    input.appId = body.appId.trim()
  }
  if ('appSecret' in body) {
    if (typeof body.appSecret !== 'string' || !body.appSecret.trim()) return null
    input.appSecret = body.appSecret.trim()
  }
  if ('platform' in body) {
    const platform = readPlatform(body.platform)
    if (!platform) return null
    input.platform = platform
  }
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return null
    input.enabled = body.enabled
  }
  if ('allowAllUsers' in body) {
    if (typeof body.allowAllUsers !== 'boolean') return null
    input.allowAllUsers = body.allowAllUsers
  }
  if ('allowedOpenIds' in body) {
    const allowedOpenIds = readAllowedOpenIds(body.allowedOpenIds)
    if (!allowedOpenIds) return null
    input.allowedOpenIds = allowedOpenIds
  }
  if ('allowedChatIds' in body) {
    const allowedChatIds = readAllowedChatIds(body.allowedChatIds)
    if (!allowedChatIds) return null
    input.allowedChatIds = allowedChatIds
  }
  if ('groupMentionMode' in body) {
    const groupMentionMode = readGroupMentionMode(body.groupMentionMode)
    if (!groupMentionMode) return null
    input.groupMentionMode = groupMentionMode
  }
  if ('p2pMode' in body) {
    const p2pMode = readP2pMode(body.p2pMode)
    if (!p2pMode) return null
    input.p2pMode = p2pMode
  }
  return Object.keys(input).length > 0 ? input : null
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value).trim()
  } catch {
    return ''
  }
}

export function createFeishuRoutes(dependencies: FeishuRoutesDependencies): DomainRoute {
  return async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/codex-api/feishu/')) return false

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/bots') {
      setJson(res, 200, { result: { bots: await dependencies.listBots() } })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/feishu/bots') {
      const input = readCreateInput(asRecord(await readJsonBody(req)))
      if (!input) {
        setJson(res, 400, { error: 'Invalid body: expected { name, appId, appSecret, platform, enabled, allowedOpenIds, groupMentionMode? }' })
        return true
      }
      setJson(res, 201, { result: { bot: await dependencies.createBot(input) } })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/feishu/qr-setup') {
      const input = readQrSetupInput(asRecord(await readJsonBody(req)))
      if (!input) {
        setJson(res, 400, { error: 'Invalid body: expected { name, allowedOpenIds?, groupMentionMode? }' })
        return true
      }
      setJson(res, 202, { result: { job: await dependencies.startQrSetup(input) } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/qr-setup') {
      setJson(res, 200, { result: { jobs: dependencies.listQrSetups() } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/open-platform-session') {
      setJson(res, 200, { result: { session: await dependencies.inspectOpenPlatformSession() } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/open-platform-apps') {
      setJson(res, 200, { result: { apps: await dependencies.listOpenPlatformApps() } })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/feishu/qr-setup/adopt') {
      const body = asRecord(await readJsonBody(req))
      const appId = readString(body?.appId)
      const input = readQrSetupInput(body)
      if (!appId || !input) {
        setJson(res, 400, { error: 'Invalid body: expected { appId, name, allowedOpenIds?, groupMentionMode? }' })
        return true
      }
      setJson(res, 202, { result: { job: await dependencies.adoptOpenPlatformApp(appId, input) } })
      return true
    }

    if (req.method === 'DELETE' && url.pathname === '/codex-api/feishu/open-platform-session') {
      setJson(res, 200, { result: { cleared: await dependencies.clearOpenPlatformSession() } })
      return true
    }

    let setupMatch = url.pathname.match(/^\/codex-api\/feishu\/qr-setup\/([^/]+)$/u)
    if (req.method === 'GET' && setupMatch) {
      const jobId = decodePathPart(setupMatch[1] ?? '')
      const job = jobId ? dependencies.getQrSetup(jobId) : null
      setJson(res, job ? 200 : 404, job ? { result: { job } } : { error: 'Feishu QR setup job not found' })
      return true
    }

    setupMatch = url.pathname.match(/^\/codex-api\/feishu\/qr-setup\/([^/]+)\/(cancel|confirm|retry)$/u)
    if (req.method === 'POST' && setupMatch) {
      const jobId = decodePathPart(setupMatch[1] ?? '')
      const action = setupMatch[2]
      const job = jobId
        ? await (action === 'cancel'
            ? dependencies.cancelQrSetup(jobId)
            : action === 'confirm'
              ? dependencies.confirmQrSetupIdentity(jobId)
              : dependencies.retryQrSetup(jobId))
        : null
      setJson(res, job ? 200 : 404, job ? { result: { job } } : { error: 'Feishu QR setup job not found' })
      return true
    }

    let match = url.pathname.match(/^\/codex-api\/feishu\/bots\/([^/]+)$/u)
    if (req.method === 'PATCH' && match) {
      const botId = decodePathPart(match[1] ?? '')
      const input = readUpdateInput(asRecord(await readJsonBody(req)))
      if (!botId || !input) {
        setJson(res, 400, { error: 'Invalid bot id or update body' })
        return true
      }
      setJson(res, 200, { result: { bot: await dependencies.updateBot(botId, input) } })
      return true
    }

    if (req.method === 'DELETE' && match) {
      const botId = decodePathPart(match[1] ?? '')
      const remoteAction = url.searchParams.get('remoteAction') ?? 'keep'
      if (!botId || (remoteAction !== 'keep' && remoteAction !== 'disable')) {
        setJson(res, 400, { error: 'Invalid bot id or remoteAction' })
        return true
      }
      const result = await dependencies.deleteBot(botId, remoteAction)
      setJson(res, result.removed ? 200 : 404, result.removed ? { result } : { error: 'Feishu bot not found' })
      return true
    }

    match = url.pathname.match(/^\/codex-api\/feishu\/bots\/([^/]+)\/reconnect$/u)
    if (req.method === 'POST' && match) {
      const botId = decodePathPart(match[1] ?? '')
      if (!botId) {
        setJson(res, 400, { error: 'Invalid bot id' })
        return true
      }
      setJson(res, 200, { result: { bot: await dependencies.reconnectBot(botId) } })
      return true
    }

    match = url.pathname.match(/^\/codex-api\/feishu\/bots\/([^/]+)\/diagnose$/u)
    if (req.method === 'POST' && match) {
      const botId = decodePathPart(match[1] ?? '')
      if (!botId) {
        setJson(res, 400, { error: 'Invalid bot id' })
        return true
      }
      setJson(res, 200, { result: { report: await dependencies.diagnoseBot(botId) } })
      return true
    }

    match = url.pathname.match(/^\/codex-api\/feishu\/bots\/([^/]+)\/outbox\/([^/]+)\/retry$/u)
    if (req.method === 'POST' && match) {
      const botId = decodePathPart(match[1] ?? '')
      const outboxId = decodePathPart(match[2] ?? '')
      if (!botId || !outboxId) {
        setJson(res, 400, { error: 'Invalid bot or outbox id' })
        return true
      }
      const requeued = await dependencies.retryDelivery(botId, outboxId)
      setJson(res, requeued ? 200 : 404, requeued ? { result: { requeued: true } } : { error: 'Failed Feishu delivery not found' })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/bindings') {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      setJson(res, 200, { result: { bindings: await dependencies.listBindings(botId) } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/auto-routes') {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      setJson(res, 200, { result: { routes: await dependencies.listAutoRoutes(botId) } })
      return true
    }

    if (req.method === 'GET' && url.pathname === '/codex-api/feishu/diagnostics') {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      setJson(res, 200, { result: { diagnostics: await dependencies.getDiagnostics(botId) } })
      return true
    }

    match = url.pathname.match(/^\/codex-api\/feishu\/bindings\/([^/]+)$/u)
    if (req.method === 'DELETE' && match) {
      const bindingId = decodePathPart(match[1] ?? '')
      if (!bindingId) {
        setJson(res, 400, { error: 'Invalid binding id' })
        return true
      }
      const removed = await dependencies.removeBinding(bindingId)
      setJson(res, removed ? 200 : 404, removed ? { result: { removed: true } } : { error: 'Binding not found' })
      return true
    }

    match = url.pathname.match(/^\/codex-api\/feishu\/auto-routes\/([^/]+)$/u)
    if (req.method === 'PATCH' && match) {
      const routeId = decodePathPart(match[1] ?? '')
      const body = asRecord(await readJsonBody(req))
      if (!routeId || !body || typeof body.enabled !== 'boolean') {
        setJson(res, 400, { error: 'Invalid body: expected { enabled: boolean }' })
        return true
      }
      const route = await dependencies.setAutoRouteEnabled(routeId, body.enabled)
      setJson(res, route ? 200 : 404, route ? { result: { route } } : { error: 'Auto route not found' })
      return true
    }
    if (req.method === 'DELETE' && match) {
      const routeId = decodePathPart(match[1] ?? '')
      if (!routeId) {
        setJson(res, 400, { error: 'Invalid auto route id' })
        return true
      }
      const removed = await dependencies.removeAutoRoute(routeId)
      setJson(res, removed ? 200 : 404, removed ? { result: { removed: true } } : { error: 'Auto route not found' })
      return true
    }

    return false
  }
}
