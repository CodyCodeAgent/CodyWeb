import { CodexApiError } from './codexErrors'
import {
  asRecord,
  fetchCodexResultRecord,
  jsonPostInit,
  queryPath,
} from './codexHttpClient'

export type FeishuBotStatus = 'connected' | 'connecting' | 'disconnected' | 'error'
export type FeishuGroupMentionMode = 'always' | 'topic' | 'bound'
export type FeishuP2pMode = 'topic' | 'chat'

export type FeishuBot = {
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
  allowedChatIds: string[]
  groupMentionMode: FeishuGroupMentionMode
  p2pMode?: FeishuP2pMode
  status: FeishuBotStatus
  lastConnectedAtIso: string | null
  lastHeartbeatAtIso: string | null
  lastError: string | null
  createdAtIso: string
  updatedAtIso: string
}

export type FeishuBotInput = {
  name: string
  appId: string
  appSecret?: string
  platform: 'feishu' | 'lark'
  enabled: boolean
  allowAllUsers?: boolean
  allowedOpenIds: string[]
  allowedChatIds?: string[]
  groupMentionMode: FeishuGroupMentionMode
  p2pMode?: FeishuP2pMode
}

export type FeishuQrSetupStatus = 'starting' | 'awaiting_scan' | 'authorizing' | 'confirming_identity' | 'creating_app' | 'configuring' | 'connecting' | 'completed' | 'failed' | 'expired' | 'cancelled'

export type FeishuSetupChecks = {
  credentialsSaved: boolean
  accountVerified: boolean
  botAbilityVerified: boolean
  scopesVerified: boolean
  messageEventVerified: boolean
  cardCallbackVerified: boolean
  eventLongConnectionVerified: boolean
  callbackLongConnectionVerified: boolean
  versionPublishedVerified: boolean
  visibilityVerified: boolean
  appEnabledVerified: boolean
  sdkConnectionVerified: boolean
  botIdentityVerified: boolean
  liveProbeVerified: boolean
}

export type FeishuQrSetupJob = {
  id: string
  name: string
  status: FeishuQrSetupStatus
  statusMessage: string
  qrDataUrl: string | null
  qrExpiresAtIso: string | null
  account: { userName: string; email: string | null; tenantName: string } | null
  bot: FeishuBot | null
  warnings: string[]
  error: string | null
  canRetry: boolean
  canCancel: boolean
  canConfirmIdentity: boolean
  checks: FeishuSetupChecks
  createdAtIso: string
  updatedAtIso: string
}

export type FeishuOpenPlatformSession = {
  configured: boolean
  valid: boolean
  account: { userName: string; email: string | null; tenantName: string } | null
  error: string | null
}

export type FeishuOpenPlatformApp = { appId: string; name: string; description: string | null }
export type FeishuAvailabilityInput = {
  mode: 'creator' | 'members' | 'groups' | 'all'
  memberIds: string[]
  groupIds: string[]
}

export type FeishuBinding = {
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

export type FeishuAutoRoute = {
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
  scenarioPackageId: string
  projectCwd: string
  projectName: string
  sessionId: string
  sessionTitle: string
  createdAtIso: string
  updatedAtIso: string
  lastMatchedAtIso: string | null
  matchCount: number
}

export type FeishuDiagnostics = {
  botId: string | null
  generatedAtIso: string
  counts: {
    outbox: Record<'pending' | 'sending' | 'sent' | 'failed' | 'deadLettered', number>
    turns: Record<'queued' | 'running' | 'completed' | 'failed' | 'cancelled', number>
    cards: Record<'creating' | 'streaming' | 'completed' | 'failed' | 'cancelled', number>
    audit: { success: number; failed: number }
  }
  recentFailedDeliveries: Array<{ id: string; kind: string; attempts: number; error: string; updatedAtIso: string; deadLetteredAtIso: string | null }>
  recentTurns: Array<{ status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error: string; updatedAtIso: string }>
  recentCards: Array<{ purpose: string; status: 'creating' | 'streaming' | 'completed' | 'failed' | 'cancelled'; version: number; updatedAtIso: string }>
  recentAuditLogs: Array<{ action: string; success: boolean; error: string; createdAtIso: string }>
}

export type FeishuConnectivityReport = {
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

const TURN_STATUSES = new Set<FeishuDiagnostics['recentTurns'][number]['status']>(['queued', 'running', 'completed', 'failed', 'cancelled'])
const CARD_STATUSES = new Set<FeishuDiagnostics['recentCards'][number]['status']>(['creating', 'streaming', 'completed', 'failed', 'cancelled'])
const QR_SETUP_STATUSES = new Set<FeishuQrSetupStatus>(['starting', 'awaiting_scan', 'authorizing', 'confirming_identity', 'creating_app', 'configuring', 'connecting', 'completed', 'failed', 'expired', 'cancelled'])
const CONNECTIVITY_CHECK_IDS = new Set<FeishuConnectivityReport['checks'][number]['id']>(['configuration', 'enabled', 'runtime', 'long_connection', 'credential_api', 'bot_identity'])

const EMPTY_SETUP_CHECKS: FeishuSetupChecks = {
  credentialsSaved: false, accountVerified: false, botAbilityVerified: false, scopesVerified: false,
  messageEventVerified: false, cardCallbackVerified: false, eventLongConnectionVerified: false,
  callbackLongConnectionVerified: false, versionPublishedVerified: false, visibilityVerified: false,
  appEnabledVerified: false, sdkConnectionVerified: false, botIdentityVerified: false, liveProbeVerified: false,
}

function count(row: Record<string, unknown> | null, key: string): number {
  const value = row?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readableError(value: unknown, depth = 0): string | null {
  const direct = optionalString(value)
  if (direct) return direct === '[object Object]' ? 'Unknown Feishu setup error' : direct
  if (depth >= 3) return null
  const row = asRecord(value)
  if (!row) return null
  for (const candidate of [row.message, row.msg, row.error_msg, row.error, row.reason]) {
    const message = readableError(candidate, depth + 1)
    if (message) return message
  }
  return null
}

function normalizeBot(value: unknown): FeishuBot | null {
  const row = asRecord(value)
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.appId !== 'string') return null
  const rawStatus = row.status
  const status: FeishuBotStatus = rawStatus === 'connected' || rawStatus === 'connecting' || rawStatus === 'error'
    ? rawStatus
    : 'disconnected'
  return {
    id: row.id,
    name: row.name,
    appId: row.appId,
    platform: row.platform === 'lark' ? 'lark' : 'feishu',
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : '',
    tenantName: typeof row.tenantName === 'string' ? row.tenantName : '',
    secretConfigured: row.secretConfigured === true,
    enabled: row.enabled === true,
    allowAllUsers: row.allowAllUsers === true,
    allowedOpenIds: Array.isArray(row.allowedOpenIds)
      ? row.allowedOpenIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [],
    allowedChatIds: Array.isArray(row.allowedChatIds)
      ? row.allowedChatIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [],
    groupMentionMode: row.groupMentionMode === 'topic' || row.groupMentionMode === 'bound' ? row.groupMentionMode : 'always',
    p2pMode: row.p2pMode === 'chat' ? 'chat' : 'topic',
    status,
    lastConnectedAtIso: optionalString(row.lastConnectedAtIso),
    lastHeartbeatAtIso: optionalString(row.lastHeartbeatAtIso),
    lastError: optionalString(row.lastError),
    createdAtIso: typeof row.createdAtIso === 'string' ? row.createdAtIso : '',
    updatedAtIso: typeof row.updatedAtIso === 'string' ? row.updatedAtIso : '',
  }
}

function normalizeBinding(value: unknown): FeishuBinding | null {
  const row = asRecord(value)
  if (!row || typeof row.id !== 'string' || typeof row.botId !== 'string' || typeof row.chatId !== 'string') return null
  const scopeType = row.scopeType === 'group' || row.scopeType === 'topic' ? row.scopeType : 'private'
  return {
    id: row.id,
    botId: row.botId,
    botName: typeof row.botName === 'string' ? row.botName : '',
    scopeType,
    chatId: row.chatId,
    threadId: optionalString(row.threadId),
    projectCwd: typeof row.projectCwd === 'string' ? row.projectCwd : '',
    projectName: typeof row.projectName === 'string' ? row.projectName : '',
    sessionId: optionalString(row.sessionId),
    sessionTitle: optionalString(row.sessionTitle),
    collaborationMode: row.collaborationMode === 'plan' ? 'plan' : 'default',
    permissionMode: row.permissionMode === 'normal' ? 'normal' : 'yolo',
    userOpenId: optionalString(row.userOpenId),
    createdAtIso: typeof row.createdAtIso === 'string' ? row.createdAtIso : '',
    updatedAtIso: typeof row.updatedAtIso === 'string' ? row.updatedAtIso : '',
    lastMessageAtIso: optionalString(row.lastMessageAtIso),
  }
}

function normalizeAutoRoute(value: unknown): FeishuAutoRoute | null {
  const row = asRecord(value)
  if (!row || typeof row.id !== 'string' || typeof row.botId !== 'string' || typeof row.chatId !== 'string') return null
  if (typeof row.cardTitle !== 'string' || typeof row.instruction !== 'string' || typeof row.sessionId !== 'string') return null
  return {
    id: row.id,
    botId: row.botId,
    chatId: row.chatId,
    name: typeof row.name === 'string' ? row.name : row.cardTitle,
    enabled: row.enabled === true,
    sourceSenderId: typeof row.sourceSenderId === 'string' ? row.sourceSenderId : '',
    sourceSenderType: row.sourceSenderType === 'bot' ? 'bot' : 'app',
    cardTitle: row.cardTitle,
    requiredKeywords: Array.isArray(row.requiredKeywords)
      ? row.requiredKeywords.filter((item): item is string => typeof item === 'string')
      : [],
    instruction: row.instruction,
    scenarioPackageId: typeof row.scenarioPackageId === 'string' ? row.scenarioPackageId : '',
    projectCwd: typeof row.projectCwd === 'string' ? row.projectCwd : '',
    projectName: typeof row.projectName === 'string' ? row.projectName : '',
    sessionId: row.sessionId,
    sessionTitle: typeof row.sessionTitle === 'string' ? row.sessionTitle : '',
    createdAtIso: typeof row.createdAtIso === 'string' ? row.createdAtIso : '',
    updatedAtIso: typeof row.updatedAtIso === 'string' ? row.updatedAtIso : '',
    lastMatchedAtIso: optionalString(row.lastMatchedAtIso),
    matchCount: typeof row.matchCount === 'number' && Number.isFinite(row.matchCount) ? row.matchCount : 0,
  }
}

function normalizeQrSetupJob(value: unknown): FeishuQrSetupJob | null {
  const row = asRecord(value)
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.status !== 'string' || !QR_SETUP_STATUSES.has(row.status as FeishuQrSetupStatus)) return null
  const account = asRecord(row.account)
  const normalizedAccount = account && typeof account.userName === 'string' && typeof account.tenantName === 'string'
    ? { userName: account.userName, email: optionalString(account.email), tenantName: account.tenantName }
    : null
  const rawChecks = asRecord(row.checks)
  const checks = Object.fromEntries(Object.keys(EMPTY_SETUP_CHECKS).map((key) => [key, rawChecks?.[key] === true])) as FeishuSetupChecks
  return {
    id: row.id,
    name: row.name,
    status: row.status as FeishuQrSetupStatus,
    statusMessage: typeof row.statusMessage === 'string' ? row.statusMessage : '',
    qrDataUrl: optionalString(row.qrDataUrl),
    qrExpiresAtIso: optionalString(row.qrExpiresAtIso),
    account: normalizedAccount,
    bot: normalizeBot(row.bot),
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((item): item is string => typeof item === 'string') : [],
    error: readableError(row.error),
    canRetry: row.canRetry === true,
    canCancel: row.canCancel === true,
    canConfirmIdentity: row.canConfirmIdentity === true,
    checks,
    createdAtIso: typeof row.createdAtIso === 'string' ? row.createdAtIso : '',
    updatedAtIso: typeof row.updatedAtIso === 'string' ? row.updatedAtIso : '',
  }
}

function normalizeDiagnostics(value: unknown): FeishuDiagnostics | null {
  const row = asRecord(value)
  const counts = asRecord(row?.counts)
  const outbox = asRecord(counts?.outbox)
  const turns = asRecord(counts?.turns)
  const cards = asRecord(counts?.cards)
  const audit = asRecord(counts?.audit)
  if (!row || !counts || typeof row.generatedAtIso !== 'string') return null
  return {
    botId: optionalString(row.botId),
    generatedAtIso: row.generatedAtIso,
    counts: {
      outbox: {
        pending: count(outbox, 'pending'), sending: count(outbox, 'sending'), sent: count(outbox, 'sent'),
        failed: count(outbox, 'failed'), deadLettered: count(outbox, 'deadLettered'),
      },
      turns: { queued: count(turns, 'queued'), running: count(turns, 'running'), completed: count(turns, 'completed'), failed: count(turns, 'failed'), cancelled: count(turns, 'cancelled') },
      cards: { creating: count(cards, 'creating'), streaming: count(cards, 'streaming'), completed: count(cards, 'completed'), failed: count(cards, 'failed'), cancelled: count(cards, 'cancelled') },
      audit: { success: count(audit, 'success'), failed: count(audit, 'failed') },
    },
    recentFailedDeliveries: (Array.isArray(row.recentFailedDeliveries) ? row.recentFailedDeliveries : []).flatMap((value) => {
      const item = asRecord(value)
      return item && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.updatedAtIso === 'string'
        ? [{
            id: item.id, kind: item.kind, attempts: count(item, 'attempts'), error: typeof item.error === 'string' ? item.error : '',
            updatedAtIso: item.updatedAtIso, deadLetteredAtIso: optionalString(item.deadLetteredAtIso),
          }]
        : []
    }),
    recentTurns: (Array.isArray(row.recentTurns) ? row.recentTurns : []).flatMap((value) => {
      const item = asRecord(value)
      const status = item?.status
      return item && typeof status === 'string' && TURN_STATUSES.has(status as FeishuDiagnostics['recentTurns'][number]['status']) && typeof item.updatedAtIso === 'string'
        ? [{ status: status as FeishuDiagnostics['recentTurns'][number]['status'], error: typeof item.error === 'string' ? item.error : '', updatedAtIso: item.updatedAtIso }]
        : []
    }),
    recentCards: (Array.isArray(row.recentCards) ? row.recentCards : []).flatMap((value) => {
      const item = asRecord(value)
      const status = item?.status
      return item && typeof item.purpose === 'string' && typeof status === 'string' && CARD_STATUSES.has(status as FeishuDiagnostics['recentCards'][number]['status']) && typeof item.updatedAtIso === 'string'
        ? [{ purpose: item.purpose, status: status as FeishuDiagnostics['recentCards'][number]['status'], version: count(item, 'version'), updatedAtIso: item.updatedAtIso }]
        : []
    }),
    recentAuditLogs: (Array.isArray(row.recentAuditLogs) ? row.recentAuditLogs : []).flatMap((value) => {
      const item = asRecord(value)
      return item && typeof item.action === 'string' && typeof item.success === 'boolean' && typeof item.createdAtIso === 'string'
        ? [{ action: item.action, success: item.success, error: typeof item.error === 'string' ? item.error : '', createdAtIso: item.createdAtIso }]
        : []
    }),
  }
}

function normalizeConnectivityReport(value: unknown): FeishuConnectivityReport | null {
  const row = asRecord(value)
  if (!row || typeof row.botId !== 'string' || typeof row.ok !== 'boolean' || typeof row.generatedAtIso !== 'string') return null
  const checks = (Array.isArray(row.checks) ? row.checks : []).flatMap((value) => {
    const check = asRecord(value)
    const id = check?.id
    const status = check?.status
    return check && typeof id === 'string' && CONNECTIVITY_CHECK_IDS.has(id as FeishuConnectivityReport['checks'][number]['id'])
      && (status === 'pass' || status === 'fail') && typeof check.message === 'string'
      ? [{
          id: id as FeishuConnectivityReport['checks'][number]['id'],
          status: status as FeishuConnectivityReport['checks'][number]['status'],
          message: check.message,
        }]
      : []
  })
  if (checks.length !== CONNECTIVITY_CHECK_IDS.size) return null
  return {
    botId: row.botId,
    ok: row.ok,
    generatedAtIso: row.generatedAtIso,
    latencyMs: count(row, 'latencyMs'),
    checks,
  }
}

function invalidResponse(message: string, method: string, status: number): never {
  throw new CodexApiError(message, { code: 'invalid_response', method, status })
}

function readBot(value: unknown, method: string, status: number): FeishuBot {
  return normalizeBot(value) ?? invalidResponse('Feishu bot returned malformed response', method, status)
}

function jsonPatchInit(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function fetchFeishuBots(): Promise<FeishuBot[]> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/bots', {
    method: 'feishu/bots/list',
    networkErrorMessage: 'Feishu bots request failed before it was sent',
    httpErrorMessage: 'Feishu bots request failed',
    malformedMessage: 'Feishu bots returned malformed response',
  })
  if (!Array.isArray(result.bots)) invalidResponse('Feishu bots returned malformed response', 'feishu/bots/list', status)
  return result.bots.map(normalizeBot).filter((bot): bot is FeishuBot => bot !== null)
}

export async function createFeishuBot(input: FeishuBotInput): Promise<FeishuBot> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/bots', {
    init: jsonPostInit(input),
    method: 'feishu/bots/create',
    networkErrorMessage: 'Feishu bot create failed before it was sent',
    httpErrorMessage: 'Feishu bot create failed',
    malformedMessage: 'Feishu bot create returned malformed response',
  })
  return readBot(result.bot, 'feishu/bots/create', status)
}

function readQrSetupJob(value: unknown, method: string, status: number): FeishuQrSetupJob {
  return normalizeQrSetupJob(value) ?? invalidResponse('Feishu QR setup returned malformed response', method, status)
}

export async function startFeishuQrSetup(input: Pick<FeishuBotInput, 'name' | 'allowAllUsers' | 'allowedOpenIds' | 'groupMentionMode' | 'p2pMode'> & { availability?: FeishuAvailabilityInput }): Promise<FeishuQrSetupJob> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/qr-setup', {
    init: jsonPostInit(input),
    method: 'feishu/qr-setup/start',
    networkErrorMessage: 'Feishu QR setup failed before it was sent',
    httpErrorMessage: 'Feishu QR setup failed',
    malformedMessage: 'Feishu QR setup returned malformed response',
  })
  return readQrSetupJob(result.job, 'feishu/qr-setup/start', status)
}

export async function fetchFeishuQrSetup(jobId: string): Promise<FeishuQrSetupJob> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/qr-setup/${encodeURIComponent(jobId)}`, {
    method: 'feishu/qr-setup/read',
    networkErrorMessage: 'Feishu QR setup status failed before it was sent',
    httpErrorMessage: 'Feishu QR setup status failed',
    malformedMessage: 'Feishu QR setup status returned malformed response',
  })
  return readQrSetupJob(result.job, 'feishu/qr-setup/read', status)
}

export async function fetchFeishuQrSetups(): Promise<FeishuQrSetupJob[]> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/qr-setup', {
    method: 'feishu/qr-setup/list',
    networkErrorMessage: 'Feishu QR setup history failed before it was sent',
    httpErrorMessage: 'Feishu QR setup history failed',
    malformedMessage: 'Feishu QR setup history returned malformed response',
  })
  if (!Array.isArray(result.jobs)) invalidResponse('Feishu QR setup history returned malformed response', 'feishu/qr-setup/list', status)
  return result.jobs.map(normalizeQrSetupJob).filter((job): job is FeishuQrSetupJob => job !== null)
}

async function mutateFeishuQrSetup(jobId: string, action: 'cancel' | 'confirm' | 'retry'): Promise<FeishuQrSetupJob> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/qr-setup/${encodeURIComponent(jobId)}/${action}`, {
    init: jsonPostInit({}),
    method: `feishu/qr-setup/${action}`,
    networkErrorMessage: `Feishu QR setup ${action} failed before it was sent`,
    httpErrorMessage: `Feishu QR setup ${action} failed`,
    malformedMessage: `Feishu QR setup ${action} returned malformed response`,
  })
  return readQrSetupJob(result.job, `feishu/qr-setup/${action}`, status)
}

export const cancelFeishuQrSetup = (jobId: string) => mutateFeishuQrSetup(jobId, 'cancel')
export const confirmFeishuQrSetupIdentity = (jobId: string) => mutateFeishuQrSetup(jobId, 'confirm')
export const retryFeishuQrSetup = (jobId: string) => mutateFeishuQrSetup(jobId, 'retry')

export async function fetchFeishuOpenPlatformSession(): Promise<FeishuOpenPlatformSession> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/open-platform-session', {
    method: 'feishu/open-platform-session/read',
    networkErrorMessage: 'Feishu Open Platform session check failed before it was sent',
    httpErrorMessage: 'Feishu Open Platform session check failed',
    malformedMessage: 'Feishu Open Platform session returned malformed response',
  })
  const row = asRecord(result.session)
  const account = asRecord(row?.account)
  if (!row || typeof row.configured !== 'boolean' || typeof row.valid !== 'boolean') {
    invalidResponse('Feishu Open Platform session returned malformed response', 'feishu/open-platform-session/read', status)
  }
  return {
    configured: row.configured,
    valid: row.valid,
    account: account && typeof account.userName === 'string' && typeof account.tenantName === 'string'
      ? { userName: account.userName, email: optionalString(account.email), tenantName: account.tenantName }
      : null,
    error: optionalString(row.error),
  }
}

export async function clearFeishuOpenPlatformSession(): Promise<boolean> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/open-platform-session', {
    init: { method: 'DELETE' },
    method: 'feishu/open-platform-session/clear',
    networkErrorMessage: 'Feishu Open Platform session clear failed before it was sent',
    httpErrorMessage: 'Feishu Open Platform session clear failed',
    malformedMessage: 'Feishu Open Platform session clear returned malformed response',
  })
  if (typeof result.cleared !== 'boolean') invalidResponse('Feishu Open Platform session clear returned malformed response', 'feishu/open-platform-session/clear', status)
  return result.cleared
}

export async function fetchFeishuOpenPlatformApps(): Promise<FeishuOpenPlatformApp[]> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/open-platform-apps', {
    method: 'feishu/open-platform-apps/list',
    networkErrorMessage: 'Feishu Open Platform app list failed before it was sent',
    httpErrorMessage: 'Feishu Open Platform app list failed',
    malformedMessage: 'Feishu Open Platform app list returned malformed response',
  })
  if (!Array.isArray(result.apps)) invalidResponse('Feishu Open Platform app list returned malformed response', 'feishu/open-platform-apps/list', status)
  return result.apps.flatMap((value) => {
    const row = asRecord(value)
    return row && typeof row.appId === 'string' && typeof row.name === 'string'
      ? [{ appId: row.appId, name: row.name, description: optionalString(row.description) }]
      : []
  })
}

export async function adoptFeishuOpenPlatformApp(input: Pick<FeishuBotInput, 'name' | 'allowAllUsers' | 'allowedOpenIds' | 'groupMentionMode' | 'p2pMode'> & { appId: string; availability?: FeishuAvailabilityInput }): Promise<FeishuQrSetupJob> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/feishu/qr-setup/adopt', {
    init: jsonPostInit(input),
    method: 'feishu/qr-setup/adopt',
    networkErrorMessage: 'Feishu existing app adoption failed before it was sent',
    httpErrorMessage: 'Feishu existing app adoption failed',
    malformedMessage: 'Feishu existing app adoption returned malformed response',
  })
  return readQrSetupJob(result.job, 'feishu/qr-setup/adopt', status)
}

export async function updateFeishuBot(botId: string, input: Partial<FeishuBotInput>): Promise<FeishuBot> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/bots/${encodeURIComponent(botId)}`, {
    init: jsonPatchInit(input),
    method: 'feishu/bots/update',
    networkErrorMessage: 'Feishu bot update failed before it was sent',
    httpErrorMessage: 'Feishu bot update failed',
    malformedMessage: 'Feishu bot update returned malformed response',
  })
  return readBot(result.bot, 'feishu/bots/update', status)
}

export async function deleteFeishuBot(botId: string, remoteAction: 'keep' | 'disable' = 'keep'): Promise<{ remoteDisabled: boolean }> {
  const path = queryPath(`/codex-api/feishu/bots/${encodeURIComponent(botId)}`, { remoteAction })
  const { result, status } = await fetchCodexResultRecord(path, {
    init: { method: 'DELETE' },
    method: 'feishu/bots/delete',
    networkErrorMessage: 'Feishu bot delete failed before it was sent',
    httpErrorMessage: 'Feishu bot delete failed',
    malformedMessage: 'Feishu bot delete returned malformed response',
  })
  if (result.removed !== true) invalidResponse('Feishu bot delete returned malformed response', 'feishu/bots/delete', status)
  return { remoteDisabled: result.remoteDisabled === true }
}

export async function reconnectFeishuBot(botId: string): Promise<FeishuBot> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/bots/${encodeURIComponent(botId)}/reconnect`, {
    init: jsonPostInit({}),
    method: 'feishu/bots/reconnect',
    networkErrorMessage: 'Feishu bot reconnect failed before it was sent',
    httpErrorMessage: 'Feishu bot reconnect failed',
    malformedMessage: 'Feishu bot reconnect returned malformed response',
  })
  return readBot(result.bot, 'feishu/bots/reconnect', status)
}

export async function diagnoseFeishuBot(botId: string): Promise<FeishuConnectivityReport> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/bots/${encodeURIComponent(botId)}/diagnose`, {
    init: jsonPostInit({}),
    method: 'feishu/bots/diagnose',
    networkErrorMessage: 'Feishu connectivity diagnostic failed before it was sent',
    httpErrorMessage: 'Feishu connectivity diagnostic failed',
    malformedMessage: 'Feishu connectivity diagnostic returned malformed response',
  })
  return normalizeConnectivityReport(result.report)
    ?? invalidResponse('Feishu connectivity diagnostic returned malformed response', 'feishu/bots/diagnose', status)
}

export async function fetchFeishuBindings(botId?: string): Promise<FeishuBinding[]> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/feishu/bindings', { botId }), {
    method: 'feishu/bindings/list',
    networkErrorMessage: 'Feishu bindings request failed before it was sent',
    httpErrorMessage: 'Feishu bindings request failed',
    malformedMessage: 'Feishu bindings returned malformed response',
  })
  if (!Array.isArray(result.bindings)) invalidResponse('Feishu bindings returned malformed response', 'feishu/bindings/list', status)
  return result.bindings.map(normalizeBinding).filter((binding): binding is FeishuBinding => binding !== null)
}

export async function removeFeishuBinding(bindingId: string): Promise<void> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/bindings/${encodeURIComponent(bindingId)}`, {
    init: { method: 'DELETE' },
    method: 'feishu/bindings/remove',
    networkErrorMessage: 'Feishu binding remove failed before it was sent',
    httpErrorMessage: 'Feishu binding remove failed',
    malformedMessage: 'Feishu binding remove returned malformed response',
  })
  if (result.removed !== true) invalidResponse('Feishu binding remove returned malformed response', 'feishu/bindings/remove', status)
}

export async function fetchFeishuAutoRoutes(botId?: string): Promise<FeishuAutoRoute[]> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/feishu/auto-routes', { botId }), {
    method: 'feishu/auto-routes/list',
    networkErrorMessage: 'Feishu auto routes request failed before it was sent',
    httpErrorMessage: 'Feishu auto routes request failed',
    malformedMessage: 'Feishu auto routes returned malformed response',
  })
  if (!Array.isArray(result.routes)) invalidResponse('Feishu auto routes returned malformed response', 'feishu/auto-routes/list', status)
  return result.routes.map(normalizeAutoRoute).filter((route): route is FeishuAutoRoute => route !== null)
}

export async function setFeishuAutoRouteEnabled(routeId: string, enabled: boolean): Promise<FeishuAutoRoute> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/auto-routes/${encodeURIComponent(routeId)}`, {
    init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) },
    method: 'feishu/auto-routes/update',
    networkErrorMessage: 'Feishu auto route update failed before it was sent',
    httpErrorMessage: 'Feishu auto route update failed',
    malformedMessage: 'Feishu auto route update returned malformed response',
  })
  return normalizeAutoRoute(result.route)
    ?? invalidResponse('Feishu auto route update returned malformed response', 'feishu/auto-routes/update', status)
}

export async function setFeishuAutoRouteScenarioPackage(routeId: string, scenarioPackageId: string): Promise<FeishuAutoRoute> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/auto-routes/${encodeURIComponent(routeId)}`, {
    init: jsonPatchInit({ scenarioPackageId }),
    method: 'feishu/auto-routes/scenario-package',
    networkErrorMessage: 'Feishu auto route update failed before it was sent',
    httpErrorMessage: 'Feishu auto route update failed',
    malformedMessage: 'Feishu auto route update returned malformed response',
  })
  return normalizeAutoRoute(result.route)
    ?? invalidResponse('Feishu auto route update returned malformed response', 'feishu/auto-routes/scenario-package', status)
}

export async function removeFeishuAutoRoute(routeId: string): Promise<void> {
  const { result, status } = await fetchCodexResultRecord(`/codex-api/feishu/auto-routes/${encodeURIComponent(routeId)}`, {
    init: { method: 'DELETE' },
    method: 'feishu/auto-routes/remove',
    networkErrorMessage: 'Feishu auto route remove failed before it was sent',
    httpErrorMessage: 'Feishu auto route remove failed',
    malformedMessage: 'Feishu auto route remove returned malformed response',
  })
  if (result.removed !== true) invalidResponse('Feishu auto route remove returned malformed response', 'feishu/auto-routes/remove', status)
}

export async function fetchFeishuDiagnostics(botId?: string): Promise<FeishuDiagnostics> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/feishu/diagnostics', { botId }), {
    method: 'feishu/diagnostics/read',
    networkErrorMessage: 'Feishu diagnostics request failed before it was sent',
    httpErrorMessage: 'Feishu diagnostics request failed',
    malformedMessage: 'Feishu diagnostics returned malformed response',
  })
  return normalizeDiagnostics(result.diagnostics)
    ?? invalidResponse('Feishu diagnostics returned malformed response', 'feishu/diagnostics/read', status)
}

export async function retryFeishuDelivery(botId: string, outboxId: string): Promise<void> {
  const { result, status } = await fetchCodexResultRecord(
    `/codex-api/feishu/bots/${encodeURIComponent(botId)}/outbox/${encodeURIComponent(outboxId)}/retry`,
    {
      init: jsonPostInit({}),
      method: 'feishu/outbox/retry',
      networkErrorMessage: 'Feishu delivery retry failed before it was sent',
      httpErrorMessage: 'Feishu delivery retry failed',
      malformedMessage: 'Feishu delivery retry returned malformed response',
    },
  )
  if (result.requeued !== true) invalidResponse('Feishu delivery retry returned malformed response', 'feishu/outbox/retry', status)
}
