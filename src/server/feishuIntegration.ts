import { randomUUID } from 'node:crypto'
import { listCatalog } from './catalogStore.js'
import type { CatalogSyncService } from './catalogSyncService.js'
import {
  FeishuBotService,
  LarkSdkTransport,
  type FeishuAppServerNotification,
  type FeishuBotStorePort,
  type FeishuConnectivityReport,
  type FeishuPendingInbound,
  type FeishuSessionBinding,
} from './feishuBotService.js'
import { FeishuReliableTransport } from './feishuReliableTransport.js'
import { FeishuCodexGateway, type ScenarioPackageDraft } from './feishuCodexGateway.js'
import { findPromptTemplate, listPromptTemplates } from './promptLibraryStore.js'
import { resolveFeishuOwnerOpenId } from './feishuOwnerResolver.js'
import { FeishuQrSetupManager } from './feishuQrSetup.js'
import {
  clearStoredFeishuOpenPlatformSession,
  configureOfficialFeishuOpenPlatformApp,
  disableFeishuOpenPlatformAppWithCredentials,
  disableCachedFeishuOpenPlatformApp,
  hasStoredFeishuOpenPlatformSession,
  inspectCachedFeishuOpenPlatformSession,
  listCachedFeishuOpenPlatformApps,
  resolveOfficialFeishuRegistrationIdentity,
} from './feishuOpenPlatform.js'
import {
  deleteExpiredFeishuQrSetupJobs,
  listFeishuQrSetupJobs,
  upsertFeishuQrSetupJob,
} from './feishuQrSetupStore.js'
import {
  deleteFeishuBinding,
  deletePendingFeishuMessage,
  deleteFeishuBot,
  findFeishuBot,
  grantFeishuBotUserAccess,
  findFeishuBinding,
  listFeishuBindings,
  listFeishuBots,
  listFeishuOutbox,
  listFeishuTurns,
  listFeishuCards,
  listFeishuAuditLogs,
  listFeishuAutoRoutes,
  appendFeishuAuditLog,
  upsertFeishuAutoRoute,
  touchFeishuAutoRoute,
  updateFeishuAutoRouteDefinition,
  setFeishuAutoRouteEnabled,
  setFeishuAutoRouteScenarioPackage,
  deleteFeishuAutoRoute,
  createFeishuTurn,
  updateFeishuTurn,
  upsertFeishuCard,
  findFeishuCard,
  cleanupFeishuOperationalData,
  publicFeishuBotConfig,
  savePendingFeishuMessage,
  peekPendingFeishuMessage,
  touchFeishuBinding,
  updateFeishuBotRuntime,
  upsertFeishuBinding,
  upsertFeishuBot,
  claimFeishuInboundEvent,
  claimPendingFeishuMessage,
  completeFeishuInboundEvent,
  failFeishuInboundEvent,
  releasePendingFeishuMessageClaim,
  requeueFailedFeishuOutbox,
  type FeishuBotConfig,
  type FeishuConversationBinding,
  type FeishuAutoRoute,
} from './feishuBotStore.js'
import type {
  FeishuBindingDto,
  FeishuAutoRouteDto,
  FeishuBotDto,
  FeishuBotWriteInput,
  FeishuDiagnosticsDto,
  FeishuGroupMentionModeDto,
  FeishuRoutesDependencies,
} from './routes/feishuRoutes.js'

type Rpc = (method: string, params: unknown) => Promise<unknown>
type Respond = (payload: unknown) => Promise<void>
type Subscribe = (listener: (notification: FeishuAppServerNotification) => void) => () => void

function runtimeBinding(binding: FeishuConversationBinding): FeishuSessionBinding {
  return {
    botId: binding.botId,
    bindingKey: binding.bindingKey,
    chatId: binding.chatId,
    rootId: binding.rootId,
    chatType: binding.chatType,
    senderOpenId: binding.senderOpenId,
    projectKey: binding.projectKey,
    projectLabel: binding.projectName || binding.projectKey || binding.projectCwd,
    cwd: binding.projectCwd,
    threadId: binding.sessionId,
    threadTitle: binding.sessionTitle,
    collaborationMode: binding.collaborationMode,
    permissionMode: binding.permissionMode,
  }
}

function pendingFromPayload(payload: unknown): FeishuPendingInbound | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = payload as Record<string, unknown>
  const string = (key: string): string => typeof row[key] === 'string' ? row[key] : ''
  const chatType = row.chatType === 'p2p' ? 'p2p' : row.chatType === 'group' ? 'group' : null
  if (!chatType) return null
  const resourceTypes = new Set(['image', 'file', 'audio', 'media', 'sticker'])
  const resources = Array.isArray(row.resources) ? row.resources.flatMap((resource) => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return []
    const candidate = resource as Record<string, unknown>
    const type = typeof candidate.type === 'string' ? candidate.type : ''
    const key = typeof candidate.key === 'string' ? candidate.key : ''
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    if (!resourceTypes.has(type) || !key || !name) return []
    const messageId = typeof candidate.messageId === 'string' && candidate.messageId ? candidate.messageId : undefined
    const downloadUnsupportedReason = typeof candidate.downloadUnsupportedReason === 'string' && candidate.downloadUnsupportedReason
      ? candidate.downloadUnsupportedReason
      : undefined
    return [{
      type: type as 'image' | 'file' | 'audio' | 'media' | 'sticker', key, name,
      ...(messageId ? { messageId } : {}),
      ...(downloadUnsupportedReason ? { downloadUnsupportedReason } : {}),
    }]
  }) : []
  const rawSelection = row.sessionSelection && typeof row.sessionSelection === 'object' && !Array.isArray(row.sessionSelection)
    ? row.sessionSelection as Record<string, unknown>
    : null
  const selectionAction: 'new_session' | 'select_session' | null = rawSelection?.action === 'new_session'
    ? 'new_session'
    : rawSelection?.action === 'select_session' ? 'select_session' : null
  const sessionSelection = rawSelection && selectionAction
    && typeof rawSelection.projectKey === 'string'
    && typeof rawSelection.startedAtIso === 'string'
    && Array.isArray(rawSelection.knownThreadIds)
    ? {
        action: selectionAction,
        projectKey: rawSelection.projectKey,
        knownThreadIds: rawSelection.knownThreadIds.filter((value): value is string => typeof value === 'string'),
        startedAtIso: rawSelection.startedAtIso,
        ...(typeof rawSelection.createdThreadId === 'string' ? { createdThreadId: rawSelection.createdThreadId } : {}),
        ...(typeof rawSelection.createdThreadTitle === 'string' ? { createdThreadTitle: rawSelection.createdThreadTitle } : {}),
      }
    : undefined
  const rawAutoRoute = row.autoRouteDraft && typeof row.autoRouteDraft === 'object' && !Array.isArray(row.autoRouteDraft)
    ? row.autoRouteDraft as Record<string, unknown>
    : null
  const autoRouteDraft = rawAutoRoute
    && (rawAutoRoute.sourceSenderType === 'app' || rawAutoRoute.sourceSenderType === 'bot')
    && rawAutoRoute.messageType === 'interactive'
    && typeof rawAutoRoute.sourceSenderId === 'string'
    && typeof rawAutoRoute.cardTitle === 'string'
    && Array.isArray(rawAutoRoute.requiredKeywords)
    && typeof rawAutoRoute.instruction === 'string'
    && typeof rawAutoRoute.fingerprintKey === 'string'
    && typeof rawAutoRoute.preview === 'string'
    ? {
        sourceSenderId: rawAutoRoute.sourceSenderId,
        sourceSenderType: rawAutoRoute.sourceSenderType as 'app' | 'bot',
        messageType: 'interactive' as const,
        cardTitle: rawAutoRoute.cardTitle,
        requiredKeywords: rawAutoRoute.requiredKeywords.filter((value): value is string => typeof value === 'string'),
        instruction: rawAutoRoute.instruction,
        fingerprintKey: rawAutoRoute.fingerprintKey,
        preview: rawAutoRoute.preview,
      }
    : undefined
  const value: FeishuPendingInbound = {
    botId: string('botId'),
    bindingKey: string('bindingKey'),
    chatId: string('chatId'),
    rootId: string('rootId'),
    chatType,
    senderOpenId: string('senderOpenId'),
    messageId: string('messageId'),
    prompt: string('prompt'),
    resources,
    createdAtIso: string('createdAtIso'),
    ...(sessionSelection ? { sessionSelection } : {}),
    ...(autoRouteDraft ? { autoRouteDraft } : {}),
    ...(typeof row.scenarioPackageId === 'string' && row.scenarioPackageId.trim() ? { scenarioPackageId: row.scenarioPackageId.trim() } : {}),
  }
  return value.botId && value.bindingKey && value.chatId && value.messageId ? value : null
}

function createStorePort(): FeishuBotStorePort {
  return {
    findScenarioPackage: (id) => findPromptTemplate(id),
    listScenarioPackages: async (cwd) => (await listPromptTemplates()).filter((item) =>
      item.scope === 'global' || item.workspaceCwd === cwd.trim()),
    listBots: async () => (await listFeishuBots()).map((bot) => ({
      botId: bot.id,
      appId: bot.appId,
      appSecret: bot.appSecret,
      platform: bot.platform,
      enabled: bot.enabled,
      allowAllUsers: bot.allowAllUsers,
      allowedOpenIds: bot.allowedOpenIds,
      allowedChatIds: bot.allowedChatIds,
      groupMentionMode: bot.groupMentionMode,
      p2pMode: bot.p2pMode,
      botOpenId: bot.botOpenId,
      botName: bot.botName || bot.name,
    })),
    updateRuntime: async (botId, update) => {
      await updateFeishuBotRuntime({
        botId,
        status: update.state,
        connectionState: update.connectionState === 'idle' ? 'disabled' : update.connectionState,
        lastError: update.lastError,
        botOpenId: update.botOpenId,
        botName: update.botName,
        connectedAtIso: update.connectedAtIso,
        lastHeartbeatAtIso: update.state === 'connected' ? new Date().toISOString() : undefined,
      })
    },
    // A durable outbound retry may legitimately keep the inbound handler open
    // for several exponential-backoff attempts. Keep its event lease longer
    // than the outbox's maximum delay so Feishu redelivery cannot execute the
    // same command concurrently while the original handler is still alive.
    claimEvent: async (botId, eventKey) => Boolean(await claimFeishuInboundEvent({
      botId,
      eventKey,
      leaseMs: 15 * 60_000,
    })),
    completeEvent: async (botId, eventKey) => { await completeFeishuInboundEvent(eventKey, botId) },
    failEvent: async (botId, eventKey, error) => { await failFeishuInboundEvent(eventKey, error, botId) },
    findBinding: async (botId, bindingKey) => {
      const binding = await findFeishuBinding(bindingKey, botId)
      return binding ? runtimeBinding(binding) : null
    },
    listBindings: async (botId) => (await listFeishuBindings({ botId })).map(runtimeBinding),
    upsertBinding: async (binding) => { await upsertFeishuBinding({
      botId: binding.botId,
      bindingKey: binding.bindingKey,
      chatId: binding.chatId,
      rootId: binding.rootId,
      chatType: binding.chatType,
      senderOpenId: binding.senderOpenId,
      projectKey: binding.projectKey,
      projectCwd: binding.cwd,
      projectName: binding.projectLabel,
      sessionId: binding.threadId,
      sessionTitle: binding.threadTitle,
      collaborationMode: binding.collaborationMode,
      permissionMode: binding.permissionMode,
    }) },
    touchBinding: async (botId, bindingKey) => { await touchFeishuBinding(bindingKey, botId) },
    deleteBinding: async (botId, bindingKey) => { await deleteFeishuBinding(bindingKey, botId) },
    savePendingMessage: async (message) => { await savePendingFeishuMessage({ ...message, payload: message }) },
    peekPendingMessage: async (botId, bindingKey) => {
      const pending = await peekPendingFeishuMessage(bindingKey, botId)
      return pending ? pendingFromPayload(pending.payload) : null
    },
    deletePendingMessage: async (botId, messageId) => { await deletePendingFeishuMessage(messageId, botId) },
    claimPendingMessage: async (botId, bindingKey, claimToken) => {
      const pending = await claimPendingFeishuMessage(bindingKey, botId, claimToken)
      return pending ? pendingFromPayload(pending.payload) : null
    },
    releasePendingMessageClaim: async (botId, claimToken) => {
      await releasePendingFeishuMessageClaim(claimToken, botId)
    },
    listAutoRoutes: (input) => listFeishuAutoRoutes(input),
    upsertAutoRoute: (input) => upsertFeishuAutoRoute(input),
    touchAutoRoute: async (id) => { await touchFeishuAutoRoute(id) },
    updateAutoRouteDefinition: (input) => updateFeishuAutoRouteDefinition(input),
  }
}

function botDto(bot: FeishuBotConfig): FeishuBotDto {
  const safe = publicFeishuBotConfig(bot)
  const storedMode = (safe as typeof safe & { groupMentionMode?: unknown }).groupMentionMode
  const groupMentionMode: FeishuGroupMentionModeDto = storedMode === 'topic' || storedMode === 'bound' ? storedMode : 'always'
  const p2pMode = safe.p2pMode === 'chat' ? 'chat' : 'topic'
  return {
    id: safe.id,
    name: safe.name,
    appId: safe.appId,
    platform: safe.platform,
    tenantId: safe.tenantId,
    tenantName: safe.tenantName,
    secretConfigured: safe.secretConfigured,
    enabled: safe.enabled,
    allowAllUsers: safe.allowAllUsers,
    allowedOpenIds: safe.allowedOpenIds,
    allowedChatIds: safe.allowedChatIds,
    groupMentionMode,
    p2pMode,
    status: safe.status,
    lastConnectedAtIso: safe.lastConnectedAtIso,
    lastHeartbeatAtIso: safe.lastHeartbeatAtIso,
    lastError: safe.lastError || null,
    createdAtIso: safe.createdAtIso,
    updatedAtIso: safe.updatedAtIso,
  }
}

function bindingDto(binding: FeishuConversationBinding): FeishuBindingDto {
  return {
    id: binding.id,
    botId: binding.botId,
    botName: binding.botName,
    scopeType: binding.scopeType,
    chatId: binding.chatId,
    threadId: binding.rootId || null,
    projectCwd: binding.projectCwd,
    projectName: binding.projectName || binding.projectKey,
    sessionId: binding.sessionId || null,
    sessionTitle: binding.sessionTitle || null,
    collaborationMode: binding.collaborationMode,
    permissionMode: binding.permissionMode,
    userOpenId: binding.userOpenId || null,
    createdAtIso: binding.createdAtIso,
    updatedAtIso: binding.updatedAtIso,
    lastMessageAtIso: binding.lastMessageAtIso,
  }
}

function autoRouteDto(route: FeishuAutoRoute): FeishuAutoRouteDto {
  return {
    id: route.id,
    botId: route.botId,
    chatId: route.chatId,
    name: route.name,
    enabled: route.enabled,
    sourceSenderId: route.sourceSenderId,
    sourceSenderType: route.sourceSenderType,
    cardTitle: route.cardTitle,
    requiredKeywords: route.requiredKeywords,
    instruction: route.instruction,
    scenarioPackageId: route.scenarioPackageId,
    projectCwd: route.projectCwd,
    projectName: route.projectName,
    sessionId: route.sessionId,
    sessionTitle: route.sessionTitle,
    createdAtIso: route.createdAtIso,
    updatedAtIso: route.updatedAtIso,
    lastMatchedAtIso: route.lastMatchedAtIso,
    matchCount: route.matchCount,
  }
}

async function diagnosticsDto(botId?: string): Promise<FeishuDiagnosticsDto> {
  const [outbox, turns, cards, auditLogs] = await Promise.all([
    listFeishuOutbox({ botId, limit: 500 }),
    listFeishuTurns({ botId, limit: 500 }),
    listFeishuCards({ botId, limit: 500 }),
    listFeishuAuditLogs({ botId, limit: 500 }),
  ])
  const counts: FeishuDiagnosticsDto['counts'] = {
    outbox: { pending: 0, sending: 0, sent: 0, failed: 0, deadLettered: 0 },
    turns: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    cards: { creating: 0, streaming: 0, completed: 0, failed: 0, cancelled: 0 },
    audit: { success: 0, failed: 0 },
  }
  for (const item of outbox) {
    if (item.status === 'failed' && item.deadLetteredAtIso) counts.outbox.deadLettered += 1
    else counts.outbox[item.status] += 1
  }
  for (const turn of turns) counts.turns[turn.status] += 1
  for (const card of cards) counts.cards[card.status] += 1
  for (const audit of auditLogs) counts.audit[audit.success ? 'success' : 'failed'] += 1
  return {
    botId: botId ?? null,
    generatedAtIso: new Date().toISOString(),
    counts,
    recentFailedDeliveries: outbox.filter((item) => item.status === 'failed').slice(0, 10).map((item) => ({
      id: item.id,
      kind: item.kind,
      attempts: item.attempts,
      error: item.lastError,
      updatedAtIso: item.updatedAtIso,
      deadLetteredAtIso: item.deadLetteredAtIso,
    })),
    recentTurns: turns.slice(0, 10).map((turn) => ({
      status: turn.status,
      error: turn.lastError,
      updatedAtIso: turn.updatedAtIso,
    })),
    recentCards: cards.slice(0, 10).map((card) => ({
      purpose: card.purpose,
      status: card.status,
      version: card.version,
      updatedAtIso: card.updatedAtIso,
    })),
    recentAuditLogs: auditLogs.slice(0, 10).map((audit) => ({
      action: audit.action,
      success: audit.success,
      error: audit.error,
      createdAtIso: audit.createdAtIso,
    })),
  }
}

function publicThreadUrl(threadId: string): string {
  const base = process.env.CODY_PUBLIC_URL?.trim().replace(/\/$/u, '') ?? ''
  return base ? `${base}/thread/${encodeURIComponent(threadId)}` : ''
}

type FeishuManagementAuditInput = {
  action: 'bot.create' | 'bot.update' | 'bot.delete' | 'bot.reconnect' | 'bot.diagnose' | 'binding.remove' | 'delivery.manual_retry' | 'auto_route.enable' | 'auto_route.disable' | 'auto_route.remove' | 'auto_route.scenario_package'
  targetType: 'feishu_bot' | 'feishu_binding' | 'feishu_outbox' | 'feishu_auto_route'
  targetId: string
  success: boolean
  metadata?: Record<string, unknown>
}

/**
 * Management audit is deliberately best-effort and content-free. An audit
 * storage failure must not turn a successful configuration mutation into an
 * HTTP failure, and secrets / prompts must never be copied into this table.
 */
async function recordFeishuManagementAudit(input: FeishuManagementAuditInput): Promise<void> {
  try {
    await appendFeishuAuditLog({
      // Keep management history under the audit owner rather than the target
      // bot's FK row. Deleting a bot must neither erase its audit trail nor
      // recreate a placeholder bot while recording the deletion.
      actorOpenId: 'local-ui',
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      success: input.success,
      metadata: input.metadata ?? {},
      error: input.success ? '' : 'operation failed',
    })
  } catch (error) {
    console.warn(`Failed to record Feishu management audit: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function safeBotAuditMetadata(input: FeishuBotWriteInput): Record<string, unknown> {
  return {
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(typeof input.allowAllUsers === 'boolean' ? { allowAllUsers: input.allowAllUsers } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.groupMentionMode ? { groupMentionMode: input.groupMentionMode } : {}),
    ...(input.p2pMode ? { p2pMode: input.p2pMode } : {}),
    ...(input.allowedOpenIds ? { allowedOpenIdCount: input.allowedOpenIds.length } : {}),
    ...(input.allowedChatIds ? { allowedChatIdCount: input.allowedChatIds.length } : {}),
    credentialChanged: typeof input.appSecret === 'string' && input.appSecret.length > 0,
    appIdChanged: typeof input.appId === 'string' && input.appId.length > 0,
  }
}

export type FeishuIntegration = {
  service: FeishuBotService
  routes: FeishuRoutesDependencies
  draftScenarioPackage: (input: { cwd: string; brief: string }) => Promise<ScenarioPackageDraft>
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function createFeishuIntegration(input: {
  rpc: Rpc
  respondToServerRequest: Respond
  subscribe: Subscribe
  catalogSync: CatalogSyncService
  isServerRequestPending?: (id: number) => boolean
}): FeishuIntegration {
  let cleanupTimer: ReturnType<typeof setInterval> | null = null
  const gateway = new FeishuCodexGateway({
    rpc: input.rpc,
    respondToServerRequest: input.respondToServerRequest,
    subscribe: input.subscribe,
    refreshCatalog: () => input.catalogSync.refreshForRead().then(() => undefined),
    readCatalog: () => listCatalog('visible'),
  })
  const service = new FeishuBotService({
    store: createStorePort(),
    catalog: {
      listProjects: async () => {
        const projects = await gateway.listProjects()
        return Promise.all(projects.map(async (project) => ({
          projectKey: project.id,
          cwd: project.cwd,
          label: project.name,
          sessionCount: project.sessionCount,
          sessions: (await gateway.listSessions(project.id)).map((session) => ({
            threadId: session.id,
            title: session.title,
            preview: session.preview,
            updatedAtIso: session.updatedAtIso,
          })),
        })))
      },
      startSession: async ({ cwd }) => {
        const session = await gateway.startSession(cwd)
        return { threadId: session.id, title: session.title }
      },
      renameSession: ({ threadId, title }) => gateway.renameSession(threadId, title),
      archiveSession: ({ threadId }) => gateway.archiveSession(threadId),
    },
    turns: {
      startTurn: async ({ threadId, prompt, localImagePaths, collaborationMode, permissionMode, skills }) => {
        const result = await gateway.startTurn(threadId, prompt, localImagePaths, collaborationMode, permissionMode, skills)
        return { turnId: result.turnId }
      },
      stopTurn: async ({ threadId, turnId }) => {
        if (!turnId) throw new Error('The active Feishu turn has not started yet')
        await gateway.stopTurn(threadId, turnId)
      },
      isThreadBusy: (threadId) => gateway.isThreadBusy(threadId),
      findActiveTurnId: (threadId) => gateway.findActiveTurnId(threadId),
      readTurnState: (threadId, turnId) => gateway.readTurnState(threadId, turnId),
    },
    notifications: { subscribe: input.subscribe },
    transportFactory: (bot) => new FeishuReliableTransport(bot, new LarkSdkTransport(bot)),
    approvals: {
      resolve: async ({ requestId, decision }) => {
        const numericId = Number(requestId)
        if (!Number.isInteger(numericId)) throw new Error('Invalid approval request id')
        if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid approval decision')
        await gateway.resolveApproval(numericId, decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel')
      },
    },
    access: {
      grantUser: async ({ botId, openId }) => {
        const updated = await grantFeishuBotUserAccess(botId, openId)
        await appendFeishuAuditLog({
          botId,
          action: 'access.granted',
          targetType: 'feishu_bot',
          targetId: botId,
          success: true,
          metadata: { allowedOpenIdCount: updated.allowedOpenIds.length },
        })
      },
    },
    serverRequests: {
      isPending: async (requestId) => {
        const id = Number(requestId)
        return Number.isInteger(id) && Boolean(input.isServerRequestPending?.(id))
      },
      respond: async ({ requestId, result, approvalScope, error }) => {
        const numericId = Number(requestId)
        if (!Number.isInteger(numericId)) throw new Error('Invalid server request id')
        await input.respondToServerRequest({
          id: numericId,
          ...(approvalScope ? { approvalScope } : {}),
          ...(result === undefined ? {} : { result }),
          ...(error ? { error } : {}),
        })
      },
    },
    autoRouteAnalyzer: {
      analyze: (value) => gateway.analyzeAutoRoute(value),
    },
    lifecycle: {
      createTurn: (value) => createFeishuTurn(value),
      updateTurn: (id, value) => updateFeishuTurn(id, value),
      listTurns: (value) => listFeishuTurns(value),
      upsertCard: (value) => upsertFeishuCard(value),
      findCard: (id) => findFeishuCard(id),
      listCards: (value) => listFeishuCards(value),
    },
    webThreadUrl: publicThreadUrl,
    logger: console,
  })

  let qrSetupManager: FeishuQrSetupManager
  const routes: FeishuRoutesDependencies = {
    listBots: async () => (await listFeishuBots()).map(botDto),
    createBot: async (payload) => {
      const botId = randomUUID()
      try {
        const bot = await upsertFeishuBot({ id: botId, ...payload })
        await service.reconcile(bot.id)
        await recordFeishuManagementAudit({
          action: 'bot.create', targetType: 'feishu_bot', targetId: bot.id,
          success: true, metadata: safeBotAuditMetadata(payload),
        })
        return botDto(bot)
      } catch (error) {
        await recordFeishuManagementAudit({
          action: 'bot.create', targetType: 'feishu_bot', targetId: botId,
          success: false, metadata: safeBotAuditMetadata(payload),
        })
        throw error
      }
    },
    updateBot: async (botId: string, payload: FeishuBotWriteInput) => {
      try {
        const current = await findFeishuBot(botId)
        if (!current) throw new Error('Feishu bot not found')
        const storedMode = (current as FeishuBotConfig & { groupMentionMode?: unknown }).groupMentionMode
        const currentGroupMentionMode: FeishuGroupMentionModeDto = storedMode === 'topic' || storedMode === 'bound' ? storedMode : 'always'
        const currentP2pMode = current.p2pMode === 'chat' ? 'chat' : 'topic'
        const update = {
          id: current.id,
          name: payload.name ?? current.name,
          appId: payload.appId ?? current.appId,
          appSecret: payload.appSecret,
          platform: payload.platform ?? current.platform,
          tenantId: payload.tenantId ?? current.tenantId,
          tenantName: payload.tenantName ?? current.tenantName,
          enabled: payload.enabled ?? current.enabled,
          allowAllUsers: payload.allowAllUsers ?? current.allowAllUsers,
          allowedOpenIds: payload.allowedOpenIds ?? current.allowedOpenIds,
          allowedChatIds: payload.allowedChatIds ?? current.allowedChatIds,
          groupMentionMode: payload.groupMentionMode ?? currentGroupMentionMode,
          p2pMode: payload.p2pMode ?? currentP2pMode,
          defaultProjectKey: current.defaultProjectKey,
        } as Parameters<typeof upsertFeishuBot>[0] & { groupMentionMode: FeishuGroupMentionModeDto }
        const bot = await upsertFeishuBot(update)
        await service.reconcile(bot.id)
        await recordFeishuManagementAudit({
          action: 'bot.update', targetType: 'feishu_bot', targetId: bot.id,
          success: true, metadata: safeBotAuditMetadata(payload),
        })
        return botDto(bot)
      } catch (error) {
        await recordFeishuManagementAudit({
          action: 'bot.update', targetType: 'feishu_bot', targetId: botId,
          success: false, metadata: safeBotAuditMetadata(payload),
        })
        throw error
      }
    },
    deleteBot: async (botId, remoteAction) => {
      try {
        const current = await findFeishuBot(botId)
        if (!current) {
          await recordFeishuManagementAudit({ action: 'bot.delete', targetType: 'feishu_bot', targetId: botId, success: false })
          return { removed: false, remoteDisabled: false }
        }
        let remoteDisabled = false
        if (remoteAction === 'disable') {
          const publicResult = await disableFeishuOpenPlatformAppWithCredentials({
            appId: current.appId,
            appSecret: current.appSecret,
            brand: current.platform,
          })
          if (!publicResult.ok) {
            if (current.platform === 'lark') throw new Error(`远端停用失败：${publicResult.message}`)
            const legacyResult = await disableCachedFeishuOpenPlatformApp({ appId: current.appId })
            if (!legacyResult.ok) {
              throw new Error(`远端停用失败：公开 API ${publicResult.message}；兼容回退 ${legacyResult.message}`)
            }
          }
          remoteDisabled = true
        }
        await upsertFeishuBot({
          id: current.id,
          name: current.name,
          appId: current.appId,
          platform: current.platform,
          tenantId: current.tenantId,
          tenantName: current.tenantName,
          enabled: false,
          allowAllUsers: current.allowAllUsers,
          allowedOpenIds: current.allowedOpenIds,
          allowedChatIds: current.allowedChatIds,
          groupMentionMode: current.groupMentionMode,
          p2pMode: current.p2pMode,
          defaultProjectKey: current.defaultProjectKey,
        })
        await service.reconcile(botId)
        const removed = await deleteFeishuBot(botId)
        await service.reconcile(botId)
        await recordFeishuManagementAudit({
          action: 'bot.delete', targetType: 'feishu_bot', targetId: botId, success: removed,
          metadata: { remoteAction, remoteDisabled },
        })
        return { removed, remoteDisabled }
      } catch (error) {
        await recordFeishuManagementAudit({ action: 'bot.delete', targetType: 'feishu_bot', targetId: botId, success: false })
        throw error
      }
    },
    reconnectBot: async (botId) => {
      try {
        const bot = await findFeishuBot(botId)
        if (!bot) throw new Error('Feishu bot not found')
        if (!bot.enabled) throw new Error('Enable the Feishu bot before reconnecting')
        await service.reconnect(botId)
        const result = botDto((await findFeishuBot(botId)) ?? bot)
        await recordFeishuManagementAudit({ action: 'bot.reconnect', targetType: 'feishu_bot', targetId: botId, success: true })
        return result
      } catch (error) {
        await recordFeishuManagementAudit({ action: 'bot.reconnect', targetType: 'feishu_bot', targetId: botId, success: false })
        throw error
      }
    },
    diagnoseBot: async (botId) => {
      try {
        if (!await findFeishuBot(botId)) throw new Error('Feishu bot not found')
        const report: FeishuConnectivityReport = await service.diagnose(botId)
        await recordFeishuManagementAudit({
          action: 'bot.diagnose', targetType: 'feishu_bot', targetId: botId,
          success: report.ok, metadata: {
            latencyMs: report.latencyMs,
            failedChecks: report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
          },
        })
        return report
      } catch (error) {
        await recordFeishuManagementAudit({ action: 'bot.diagnose', targetType: 'feishu_bot', targetId: botId, success: false })
        throw error
      }
    },
    listBindings: async (botId) => (await listFeishuBindings({ botId })).map(bindingDto),
    removeBinding: async (bindingId) => {
      try {
        const binding = (await listFeishuBindings()).find((row) => row.id === bindingId)
        const removed = binding ? await deleteFeishuBinding(binding.bindingKey, binding.botId) : false
        await recordFeishuManagementAudit({
          action: 'binding.remove', targetType: 'feishu_binding', targetId: bindingId,
          success: removed, metadata: binding ? { botId: binding.botId, scopeType: binding.scopeType } : {},
        })
        return removed
      } catch (error) {
        await recordFeishuManagementAudit({ action: 'binding.remove', targetType: 'feishu_binding', targetId: bindingId, success: false })
        throw error
      }
    },
    listAutoRoutes: async (botId) => (await listFeishuAutoRoutes({ botId })).map(autoRouteDto),
    setAutoRouteEnabled: async (routeId, enabled) => {
      const route = await setFeishuAutoRouteEnabled(routeId, enabled)
      await recordFeishuManagementAudit({
        action: enabled ? 'auto_route.enable' : 'auto_route.disable',
        targetType: 'feishu_auto_route',
        targetId: routeId,
        success: Boolean(route),
      })
      return route ? autoRouteDto(route) : null
    },
    setAutoRouteScenarioPackage: async (routeId, scenarioPackageId) => {
      const current = (await listFeishuAutoRoutes()).find((item) => item.id === routeId)
      if (!current) return null
      if (scenarioPackageId.trim()) {
        const scenarioPackage = await findPromptTemplate(scenarioPackageId)
        if (!scenarioPackage || (scenarioPackage.scope === 'workspace' && scenarioPackage.workspaceCwd !== current.projectCwd)) {
          throw new Error('Scenario package does not exist or is not available in this route workspace')
        }
      }
      const route = await setFeishuAutoRouteScenarioPackage(routeId, scenarioPackageId)
      await recordFeishuManagementAudit({
        action: 'auto_route.scenario_package', targetType: 'feishu_auto_route', targetId: routeId,
        success: Boolean(route), metadata: { configured: Boolean(scenarioPackageId.trim()) },
      })
      return route ? autoRouteDto(route) : null
    },
    removeAutoRoute: async (routeId) => {
      const removed = await deleteFeishuAutoRoute(routeId)
      await recordFeishuManagementAudit({
        action: 'auto_route.remove', targetType: 'feishu_auto_route', targetId: routeId, success: removed,
      })
      return removed
    },
    getDiagnostics: diagnosticsDto,
    retryDelivery: async (botId, outboxId) => {
      try {
        const requeued = await requeueFailedFeishuOutbox(outboxId, botId)
        await recordFeishuManagementAudit({
          action: 'delivery.manual_retry', targetType: 'feishu_outbox', targetId: outboxId,
          success: requeued, metadata: { botId },
        })
        return requeued
      } catch (error) {
        await recordFeishuManagementAudit({
          action: 'delivery.manual_retry', targetType: 'feishu_outbox', targetId: outboxId,
          success: false, metadata: { botId },
        })
        throw error
      }
    },
    startQrSetup: (payload) => qrSetupManager.start(payload),
    listQrSetups: () => qrSetupManager.list(),
    getQrSetup: (jobId) => qrSetupManager.get(jobId),
    cancelQrSetup: (jobId) => qrSetupManager.cancel(jobId),
    confirmQrSetupIdentity: (jobId) => qrSetupManager.confirmIdentity(jobId),
    retryQrSetup: (jobId) => qrSetupManager.retry(jobId),
    inspectOpenPlatformSession: async () => {
      const inspected = await inspectCachedFeishuOpenPlatformSession()
      if (!inspected.ok) {
        return {
          configured: hasStoredFeishuOpenPlatformSession(),
          valid: false,
          account: null,
          error: inspected.reason === 'invalid_session' ? null : inspected.message,
        }
      }
      return {
        configured: true,
        valid: true,
        account: {
          userName: inspected.identity.userName,
          email: inspected.identity.email ?? null,
          tenantName: inspected.identity.tenantName,
        },
        error: null,
      }
    },
    clearOpenPlatformSession: async () => clearStoredFeishuOpenPlatformSession(),
    listOpenPlatformApps: async () => {
      const result = await listCachedFeishuOpenPlatformApps()
      if (!result.ok) throw new Error(result.message)
      return result.apps.map((app) => ({ appId: app.clientId, name: app.name, description: app.description ?? null }))
    },
    adoptOpenPlatformApp: (appId, input) => qrSetupManager.adoptOfficial(appId, input),
  }
  qrSetupManager = new FeishuQrSetupManager({
    createBot: routes.createBot,
    updateBot: routes.updateBot,
    findBot: async (botId) => {
      const bot = await findFeishuBot(botId)
      return bot ? botDto(bot) : null
    },
    findBotByAppId: async (appId) => {
      const bot = (await listFeishuBots()).find((value) => value.appId === appId)
      return bot ? botDto(bot) : null
    },
    refreshOfficialIdentity: async ({ botId, ownerOpenId }) => {
      const bot = await findFeishuBot(botId)
      if (!bot) throw new Error('Feishu bot not found')
      if (!bot.appSecret) throw new Error('Feishu app secret is not configured')
      const identity = await resolveOfficialFeishuRegistrationIdentity({
        appId: bot.appId,
        appSecret: bot.appSecret,
        openId: ownerOpenId,
        brand: bot.platform,
      })
      if (bot.tenantId && bot.tenantId !== identity.tenantId) {
        throw new Error(`Feishu tenant changed for ${bot.appId}; expected ${bot.tenantId}, got ${identity.tenantId}`)
      }
      await upsertFeishuBot({
        id: bot.id,
        name: bot.name,
        appId: bot.appId,
        platform: bot.platform,
        tenantId: identity.tenantId,
        tenantName: identity.tenantName,
        enabled: false,
        allowAllUsers: bot.allowAllUsers,
        allowedOpenIds: bot.allowedOpenIds,
        allowedChatIds: bot.allowedChatIds,
        groupMentionMode: bot.groupMentionMode,
        p2pMode: bot.p2pMode,
        defaultProjectKey: bot.defaultProjectKey,
      })
      return identity
    },
    configureOfficialApp: async ({ botId, signal, visibility }) => {
      const bot = await findFeishuBot(botId)
      if (!bot) return { ok: false, reason: 'api_error' as const, message: 'Feishu bot not found' }
      if (!bot.appSecret) return { ok: false, reason: 'api_error' as const, message: 'Feishu app secret is not configured' }
      return configureOfficialFeishuOpenPlatformApp({
        appId: bot.appId,
        appSecret: bot.appSecret,
        brand: bot.platform,
        signal,
        visibility,
      })
    },
    verifyBotConnection: async (botId, signal) => {
      const deadline = Date.now() + 20_000
      for (;;) {
        if (signal.aborted) throw new Error('服务停止，连接验证已中断')
        const bot = await findFeishuBot(botId)
        if (!bot) throw new Error('飞书机器人配置在连接验证期间消失')
        if (bot.status === 'connected' && bot.botOpenId.trim()) {
          const report = await service.diagnose(botId)
          if (!report.ok) {
            const failed = report.checks.filter((check) => check.status === 'fail')
            throw new Error(`飞书实时诊断未通过: ${failed.map((check) => `${check.id}（${check.message}）`).join('；')}`)
          }
          const verified = await findFeishuBot(botId)
          if (!verified?.botOpenId.trim()) throw new Error('实时诊断通过后未能回读机器人身份')
          return botDto(verified)
        }
        if (bot.status === 'error') throw new Error(bot.lastError || '飞书长连接建立失败')
        if (Date.now() >= deadline) throw new Error('飞书长连接或机器人身份在 20 秒内未验证成功')
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    },
    ensureOwnerAccess: async (botId, email) => {
      const bot = await findFeishuBot(botId)
      if (!bot) throw new Error('飞书机器人配置不存在')
      try {
        const ownerOpenId = await resolveFeishuOwnerOpenId({
          appId: bot.appId,
          appSecret: bot.appSecret,
          email: email ?? '',
        })
        return routes.updateBot(botId, {
          allowAllUsers: bot.allowAllUsers,
          allowedOpenIds: [...new Set([ownerOpenId, ...bot.allowedOpenIds])],
        })
      } catch (error) {
        if (bot.allowedOpenIds.length > 0) return botDto(bot)
        throw error
      }
    },
    loadPersistedJobs: () => listFeishuQrSetupJobs(100),
    savePersistedJob: upsertFeishuQrSetupJob,
    deleteExpiredPersistedJobs: deleteExpiredFeishuQrSetupJobs,
  })

  return {
    service,
    routes,
    draftScenarioPackage: (value) => gateway.draftScenarioPackage(value),
    start: async () => {
      await cleanupFeishuOperationalData()
      await service.start()
      await qrSetupManager.restore()
      if (!cleanupTimer) {
        cleanupTimer = setInterval(() => { void cleanupFeishuOperationalData() }, 24 * 60 * 60_000)
        cleanupTimer.unref?.()
      }
    },
    stop: async () => {
      await qrSetupManager.stop()
      if (cleanupTimer) clearInterval(cleanupTimer)
      cleanupTimer = null
      await service.stop()
    },
  }
}
