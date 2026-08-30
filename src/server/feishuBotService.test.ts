import { describe, expect, it, vi } from 'vitest'
import {
  FeishuBotService,
  LarkSdkTransport,
  formatFeishuSdkError,
  normalizeFeishuInbound,
  type FeishuBotDefinition,
  type FeishuBotStorePort,
  type FeishuLifecyclePort,
  type FeishuPendingInbound,
  type FeishuRuntimeUpdate,
  type FeishuSessionBinding,
  type FeishuTransport,
  type FeishuTransportHandlers,
  type FeishuTransportState,
} from './feishuBotService'
import type { FeishuAutoRoute, FeishuCard, FeishuTurn } from './feishuBotStore'
import type { FeishuMessageResource } from './feishuMessageParser'
import { FeishuPermanentDeliveryError } from './feishuReliableTransport'
import { FEISHU_CARD_ACTIONS } from './feishuCards'

const bot: FeishuBotDefinition = {
  botId: 'bot-1', appId: 'cli_a', appSecret: 'secret', enabled: true,
  allowedOpenIds: ['ou_user'], botOpenId: 'ou_bot', botName: 'Cody', groupMentionMode: 'bound',
}

function inbound(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'event-1',
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ key: '@_user_1', name: 'Cody', id: { open_id: 'ou_bot' } }],
      ...overrides,
    },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
  }
}

class MemoryStore implements FeishuBotStorePort {
  bindings = new Map<string, FeishuSessionBinding>()
  pending = new Map<string, FeishuPendingInbound>()
  runtime: FeishuRuntimeUpdate[] = []
  seen = new Set<string>()
  completedEvents: string[] = []
  failedEvents: Array<{ key: string; error: string }> = []
  pendingClaims = new Map<string, string>()
  autoRoutes = new Map<string, FeishuAutoRoute>()
  scenarioPackages = new Map<string, {
    id: string; title: string; description: string; content: string
    primarySkill: { name: string; path: string; displayName: string; description: string } | null
  }>()
  constructor(private readonly configuredBot: FeishuBotDefinition = bot) {}
  async listBots() { return [this.configuredBot] }
  async updateRuntime(_botId: string, update: FeishuRuntimeUpdate) { this.runtime.push(update) }
  async claimEvent(botId: string, key: string) { const full = `${botId}:${key}`; if (this.seen.has(full)) return false; this.seen.add(full); return true }
  async completeEvent(botId: string, key: string) { this.completedEvents.push(`${botId}:${key}`) }
  async failEvent(botId: string, key: string, error: string) { this.failedEvents.push({ key: `${botId}:${key}`, error }) }
  async findBinding(_botId: string, bindingKey: string) { return this.bindings.get(bindingKey) ?? null }
  async listBindings() { return [...this.bindings.values()] }
  async upsertBinding(binding: FeishuSessionBinding) { this.bindings.set(binding.bindingKey, binding) }
  async touchBinding() {}
  async deleteBinding(_botId: string, bindingKey: string) { this.bindings.delete(bindingKey) }
  async savePendingMessage(message: FeishuPendingInbound) { this.pending.set(message.bindingKey, message) }
  async peekPendingMessage(_botId: string, bindingKey: string) { return this.pending.get(bindingKey) ?? null }
  async deletePendingMessage(_botId: string, messageId: string) {
    for (const [bindingKey, pending] of this.pending) if (pending.messageId === messageId) this.pending.delete(bindingKey)
  }
  async claimPendingMessage(_botId: string, bindingKey: string, claimToken: string) {
    if (this.pendingClaims.has(bindingKey)) return null
    const pending = this.pending.get(bindingKey) ?? null
    if (pending) this.pendingClaims.set(bindingKey, claimToken)
    return pending
  }
  async releasePendingMessageClaim(_botId: string, claimToken: string) {
    for (const [bindingKey, token] of this.pendingClaims) if (token === claimToken) this.pendingClaims.delete(bindingKey)
  }
  async listAutoRoutes(input: { botId?: string; chatId?: string; enabled?: boolean }) {
    return [...this.autoRoutes.values()].filter((route) =>
      (!input.botId || route.botId === input.botId)
      && (!input.chatId || route.chatId === input.chatId)
      && (input.enabled === undefined || route.enabled === input.enabled))
  }
  async touchAutoRoute(id: string) {
    const route = this.autoRoutes.get(id)
    if (route) this.autoRoutes.set(id, { ...route, matchCount: route.matchCount + 1, lastMatchedAtIso: new Date().toISOString() })
  }
  async upsertAutoRoute(input: Parameters<NonNullable<FeishuBotStorePort['upsertAutoRoute']>>[0]) {
    const existing = [...this.autoRoutes.values()].find((route) => route.botId === input.botId && route.chatId === input.chatId && route.fingerprintKey === input.fingerprintKey)
    const id = existing?.id ?? `route-${String(this.autoRoutes.size + 1)}`
    const now = new Date().toISOString()
    const route: FeishuAutoRoute = {
      id, botId: input.botId, bindingKey: existing?.bindingKey ?? `${input.botId}:auto-route:${id}`,
      chatId: input.chatId, name: input.name, enabled: true, sourceSenderId: input.sourceSenderId,
      sourceSenderType: input.sourceSenderType, messageType: 'interactive', cardTitle: input.cardTitle,
      requiredKeywords: input.requiredKeywords, fingerprintKey: input.fingerprintKey, instruction: input.instruction,
      projectKey: input.projectKey, projectCwd: input.projectCwd, projectName: input.projectName,
      sessionId: input.sessionId, sessionTitle: input.sessionTitle, createdByOpenId: input.createdByOpenId,
      scenarioPackageId: input.scenarioPackageId ?? '',
      createdAtIso: existing?.createdAtIso ?? now, updatedAtIso: now,
      lastMatchedAtIso: existing?.lastMatchedAtIso ?? null, matchCount: existing?.matchCount ?? 0,
    }
    this.autoRoutes.set(id, route)
    return route
  }
  async updateAutoRouteDefinition(input: Parameters<NonNullable<FeishuBotStorePort['updateAutoRouteDefinition']>>[0]) {
    const current = this.autoRoutes.get(input.id)
    if (!current) return null
    const updated = { ...current, ...input, updatedAtIso: new Date().toISOString() }
    this.autoRoutes.set(input.id, updated)
    return updated
  }
  async findScenarioPackage(id: string) { return this.scenarioPackages.get(id) ?? null }
  async listScenarioPackages(cwd: string) {
    void cwd
    return [...this.scenarioPackages.values()].map(({ content: _content, ...item }) => item)
  }
}

class MemoryLifecycle implements FeishuLifecyclePort {
  turns = new Map<string, FeishuTurn>()
  cards = new Map<string, FeishuCard>()
  private sequence = 0

  async createTurn(input: Parameters<FeishuLifecyclePort['createTurn']>[0]) {
    const now = new Date().toISOString()
    const turn: FeishuTurn = {
      id: `durable-turn-${String(++this.sequence)}`,
      botId: input.botId,
      bindingKey: input.bindingKey,
      inboundMessageId: input.inboundMessageId,
      sessionId: input.sessionId,
      turnId: '',
      status: input.status,
      prompt: input.prompt,
      responseText: '',
      cardId: null,
      lastError: '',
      createdAtIso: now,
      updatedAtIso: now,
      completedAtIso: null,
    }
    this.turns.set(turn.id, turn)
    return turn
  }

  async updateTurn(id: string, patch: Parameters<FeishuLifecyclePort['updateTurn']>[1]) {
    const current = this.turns.get(id)
    if (!current) return null
    const status = patch.status ?? current.status
    const next: FeishuTurn = {
      ...current,
      ...patch,
      updatedAtIso: new Date().toISOString(),
      completedAtIso: patch.completedAtIso ?? (['completed', 'failed', 'cancelled'].includes(status)
        ? new Date().toISOString()
        : current.completedAtIso),
    }
    this.turns.set(id, next)
    return next
  }

  async listTurns() { return [...this.turns.values()] }

  async upsertCard(input: Parameters<FeishuLifecyclePort['upsertCard']>[0]) {
    const now = new Date().toISOString()
    const current = this.cards.get(input.id)
    const card: FeishuCard = {
      id: input.id,
      botId: input.botId,
      bindingKey: input.bindingKey,
      messageId: input.messageId === undefined ? (current?.messageId ?? null) : input.messageId,
      purpose: input.purpose,
      status: input.status,
      version: input.version,
      state: input.state,
      createdAtIso: current?.createdAtIso ?? now,
      updatedAtIso: now,
    }
    this.cards.set(card.id, card)
    return card
  }

  async findCard(id: string) { return this.cards.get(id) ?? null }
  async listCards() { return [...this.cards.values()] }
}

class FakeTransport implements FeishuTransport {
  getMessage?: FeishuTransport['getMessage']
  handlers: FeishuTransportHandlers | null = null
  state: FeishuTransportState = 'idle'
  cards: Array<{ kind: string; id: string; card: Record<string, unknown> }> = []
  texts: string[] = []
  repliesInThread: boolean[] = []
  chatMode: 'group' | 'topic' | 'p2p' = 'group'
  chatModeError: Error | null = null
  permanentReplyFailure = false
  failCardUpdates = false
  failImageUploads = false
  sendUserCardError: Error | null = null
  failedResourceKeys = new Set<string>()
  identityOpenId = 'ou_bot'
  identityError: Error | null = null
  downloadedResources: Array<{ messageId: string; resource: FeishuMessageResource }> = []
  uploadedImages: Array<{ fileName: string; mimeType: string; size: number }> = []
  async getBotIdentity() {
    if (this.identityError) throw this.identityError
    return { openId: this.identityOpenId, name: 'Cody' }
  }
  async start(handlers: FeishuTransportHandlers) { this.handlers = handlers; this.state = 'connected'; handlers.onState('connected') }
  close() { this.state = 'idle' }
  getState() { return this.state }
  async getChatMode() { if (this.chatModeError) throw this.chatModeError; return this.chatMode }
  async sendText(_chatId: string, text: string) { this.texts.push(text); return 'sent-text' }
  async replyText(_messageId: string, text: string, replyInThread = false) { if (this.permanentReplyFailure) throw new FeishuPermanentDeliveryError('230011: message withdrawn', 'outbox-text'); this.texts.push(text); this.repliesInThread.push(replyInThread); return 'reply-text' }
  async sendCard(_chatId: string, card: Record<string, unknown>) { this.cards.push({ kind: 'send', id: 'card-1', card }); return 'card-1' }
  async sendUserCard(openId: string, card: Record<string, unknown>) {
    if (this.sendUserCardError) throw this.sendUserCardError
    const id = `user-card-${this.cards.length + 1}`
    this.cards.push({ kind: `user:${openId}`, id, card })
    return id
  }
  async replyCard(_messageId: string, card: Record<string, unknown>, replyInThread = false) { if (this.permanentReplyFailure) throw new FeishuPermanentDeliveryError('230011: message withdrawn', 'outbox-card'); const id = `card-${this.cards.length + 1}`; this.cards.push({ kind: 'reply', id, card }); this.repliesInThread.push(replyInThread); return id }
  async updateCard(messageId: string, card: Record<string, unknown>) {
    if (this.failCardUpdates) throw new Error('patch unavailable')
    this.cards.push({ kind: 'patch', id: messageId, card })
  }
  async uploadImage(image: { buffer: Buffer; fileName: string; mimeType: string }) {
    if (this.failImageUploads) throw new Error('image upload unavailable')
    this.uploadedImages.push({ fileName: image.fileName, mimeType: image.mimeType, size: image.buffer.byteLength })
    return `img_v2_fake_${String(this.uploadedImages.length)}`
  }
  async downloadResource(messageId: string, resource: FeishuMessageResource) {
    this.downloadedResources.push({ messageId, resource })
    if (this.failedResourceKeys.has(resource.key)) throw new Error('resource unavailable')
    return { ...resource, path: `/private/feishu/${resource.name}`, sizeBytes: 12 }
  }
}

function harness(binding?: FeishuSessionBinding, options: {
  listProjects?: () => Promise<Array<{ projectKey: string; cwd: string; label: string; sessionCount: number; sessions: Array<{ threadId: string; title: string }> }>>
  startSession?: (input: { cwd: string; projectKey: string }) => Promise<{ threadId: string; title: string }>
  bot?: FeishuBotDefinition
  isThreadBusy?: (threadId: string) => Promise<boolean>
  findActiveTurnId?: (threadId: string) => Promise<string | null>
  stopTurn?: (input: { threadId: string; turnId?: string }) => Promise<void>
  grantUser?: (input: { botId: string; openId: string }) => Promise<void>
  now?: () => Date
  lifecycle?: FeishuLifecyclePort
  readTurnState?: (threadId: string, turnId: string) => Promise<{
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'missing'
    responseText?: string
    error?: string
  }>
  analyzeAutoRoute?: (input: {
    cwd: string; cardTitle: string; cardText: string; candidateKeywords: string[]; requestedInstruction: string
  }) => Promise<{ requiredKeywords: string[]; instruction: string; reason: string }>
  scenarioPackages?: Array<{
    id: string; title: string; description: string; content: string
    primarySkill: { name: string; path: string; displayName: string; description: string } | null
  }>
} = {}) {
  const store = new MemoryStore(options.bot)
  for (const item of options.scenarioPackages ?? []) store.scenarioPackages.set(item.id, item)
  if (binding) store.bindings.set(binding.bindingKey, binding)
  const transport = new FakeTransport()
  let turnSequence = 0
  const startTurn = vi.fn(async () => ({ turnId: `turn-${String(++turnSequence)}` }))
  const stopTurn = vi.fn(options.stopTurn ?? (async () => undefined))
  const renameSession = vi.fn(async () => undefined)
  const archiveSession = vi.fn(async () => undefined)
  const approvalResolve = vi.fn(async () => undefined)
  const grantUser = vi.fn(options.grantUser ?? (async () => undefined))
  const respondServerRequest = vi.fn(async () => undefined)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const service = new FeishuBotService({
    store,
    catalog: {
      listProjects: options.listProjects ?? (async () => [{
        projectKey: '/repo', cwd: '/repo', label: 'Repo', sessionCount: 2,
        sessions: [
          { threadId: 'thread-1', title: 'Existing thread' },
          { threadId: 'thread-2', title: 'Second thread' },
        ],
      }]),
      startSession: options.startSession ?? (async () => ({ threadId: 'thread-new', title: 'New thread' })),
      renameSession,
      archiveSession,
    },
    turns: {
      startTurn,
      stopTurn,
      ...(options.isThreadBusy ? { isThreadBusy: options.isThreadBusy } : {}),
      ...(options.findActiveTurnId ? { findActiveTurnId: options.findActiveTurnId } : {}),
      ...(options.readTurnState ? { readTurnState: options.readTurnState } : {}),
    },
    approvals: { resolve: approvalResolve },
    access: { grantUser },
    serverRequests: { respond: respondServerRequest },
    ...(options.analyzeAutoRoute ? { autoRouteAnalyzer: { analyze: options.analyzeAutoRoute } } : {}),
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    transportFactory: () => transport,
    schedule: (work) => work(),
    ...(options.now ? { now: options.now } : {}),
    logger,
    reconnectCheckMs: 1_000_000,
    streamPatchMs: 1_000_000,
  })
  return { service, store, transport, startTurn, stopTurn, renameSession, archiveSession, approvalResolve, grantUser, respondServerRequest, logger }
}

function binding(): FeishuSessionBinding {
  return {
    botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
    senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
    threadId: 'thread-1', threadTitle: 'Existing thread',
  }
}

function commandMessage(messageId: string, prompt: string): Record<string, unknown> {
  const message = inbound({ message_id: messageId, content: JSON.stringify({ text: `@_user_1 ${prompt}` }) })
  message.event_id = `event-${messageId}`
  return message
}

function findCardActionValue(value: unknown, action: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCardActionValue(item, action)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.action === action) return record
  for (const child of Object.values(record)) {
    const found = findCardActionValue(child, action)
    if (found) return found
  }
  return null
}

describe('FeishuBotService', () => {
  it('constructs REST transport with the Lark international domain when stored platform is lark', () => {
    const transport = new LarkSdkTransport({ ...bot, platform: 'lark' })
    expect((transport as unknown as { client: { domain: string } }).client.domain).toBe('https://open.larksuite.com')
  })

  it('keeps an ordinary group reply chat-scoped when it only has root_id', () => {
    const normalized = normalizeFeishuInbound(bot, inbound({ message_id: 'om_reply', root_id: 'om_root' }))
    expect(normalized).toMatchObject({
      bindingKey: 'bot-1:group:oc_1:oc_1', rootId: '', prompt: 'hello', explicitlyMentioned: true,
      topLevel: true,
    })
  })

  it('normalizes real group topic routing and removes the bot mention', () => {
    const normalized = normalizeFeishuInbound(bot, inbound({ root_id: 'om_root', thread_id: 'omt_thread' }))
    expect(normalized).toMatchObject({
      bindingKey: 'bot-1:group:oc_1:om_root', rootId: 'om_root', prompt: 'hello', explicitlyMentioned: true,
      topLevel: false,
    })
  })

  it('routes each top-level private message to its own topic by default', () => {
    const normalized = normalizeFeishuInbound(bot, inbound({ chat_type: 'p2p', message_id: 'om_private' }))
    expect(normalized).toMatchObject({
      bindingKey: 'bot-1:p2p:oc_1:om_private', rootId: 'om_private', topLevel: true,
    })
  })

  it('reuses a private topic only when both root_id and thread_id are present', () => {
    const threaded = normalizeFeishuInbound(bot, inbound({
      chat_type: 'p2p', message_id: 'om_reply', root_id: 'om_root', thread_id: 'omt_thread',
    }))
    expect(threaded).toMatchObject({
      bindingKey: 'bot-1:p2p:oc_1:om_root', rootId: 'om_root', topLevel: false,
    })

    const quoted = normalizeFeishuInbound(bot, inbound({
      chat_type: 'p2p', message_id: 'om_quote', root_id: 'om_quoted',
    }))
    expect(quoted).toMatchObject({
      bindingKey: 'bot-1:p2p:oc_1:om_quote', rootId: 'om_quote', topLevel: true,
    })
  })

  it('keeps private messages chat-scoped in explicit flat mode', () => {
    const normalized = normalizeFeishuInbound({ ...bot, p2pMode: 'chat' }, inbound({
      chat_type: 'p2p', message_id: 'om_reply', root_id: 'om_root', thread_id: 'omt_thread',
    }))
    expect(normalized).toMatchObject({
      bindingKey: 'bot-1:p2p:oc_1:chat', rootId: '',
    })
  })

  it('distinguishes own and other bot app_id mentions', () => {
    const own = normalizeFeishuInbound(bot, inbound({
      content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ key: '@_user_1', name: 'Cody', id: bot.appId, id_type: 'app_id' }],
    }))
    expect(own).toMatchObject({ prompt: 'hello', explicitlyMentioned: true, hasNonBotMention: false })

    const other = normalizeFeishuInbound(bot, inbound({
      content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ key: '@_user_1', name: 'Other bot', id: 'cli_other', id_type: 'app_id' }],
    }))
    expect(other).toMatchObject({ explicitlyMentioned: false, hasNonBotMention: true })
  })

  it('normalizes rich-text messages and recognizes a bot mention inside post content', () => {
    const normalized = normalizeFeishuInbound(bot, inbound({
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '排查',
          content: [[
            { tag: 'at', user_id: 'ou_bot', user_name: 'Cody' },
            { tag: 'text', text: ' 看下日志' },
            { tag: 'img', image_key: 'img_log' },
          ]],
        },
      }),
      mentions: [],
    }))
    expect(normalized).toMatchObject({
      prompt: '排查\n看下日志[图片 1]',
      explicitlyMentioned: true,
      resources: [{ type: 'image', key: 'img_log', name: 'img_log.jpg' }],
    })
  })

  it('downloads images and files before starting the same Codex turn', async () => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    await service.start()
    transport.handlers?.onMessage(inbound({
      message_type: 'post',
      content: JSON.stringify({ zh_cn: { content: [[
        { tag: 'at', user_id: 'ou_bot', user_name: 'Cody' },
        { tag: 'text', text: ' 分析附件' },
        { tag: 'img', image_key: 'img_1' },
        { tag: 'file', file_key: 'file_1', file_name: 'spec.pdf' },
      ]] } }),
      mentions: [],
    }))

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(transport.downloadedResources.map((item) => item.messageId)).toEqual(['om_1', 'om_1'])
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      localImagePaths: ['/private/feishu/img_1.jpg'],
      prompt: expect.stringContaining('spec.pdf: /private/feishu/spec.pdf'),
    }))
    await service.stop()
  })

  it('keeps the text turn visible when an attachment cannot be downloaded', async () => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    transport.failedResourceKeys.add('file_bad')
    await service.start()
    transport.handlers?.onMessage(inbound({
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_bad', file_name: 'broken.zip' }),
      mentions: [{ key: '@_user_1', name: 'Cody', id: { open_id: 'ou_bot' } }],
    }))

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('broken.zip: resource unavailable'),
      localImagePaths: [],
    }))
    await service.stop()
  })

  it.each([
    {
      label: 'stickers', reason: '暂不支持下载表情资源',
      message: { message_type: 'sticker', content: JSON.stringify({ file_key: 'sticker_1' }), mentions: [] },
    },
    {
      label: 'card resources', reason: '不支持下载卡片消息中的资源（234043）',
      message: { message_type: 'interactive', content: JSON.stringify({ elements: [{ tag: 'img', img_key: 'card_img' }] }), mentions: [] },
    },
  ])('degrades unsupported Feishu $label into a visible prompt note', async ({ reason, message }) => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    await service.start()
    transport.handlers?.onMessage(inbound({
      ...message,
      mentions: [{ key: '@_user_1', name: 'Cody', id: { open_id: 'ou_bot' } }],
    }))

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(reason) }))
    expect(transport.downloadedResources).toEqual([])
    await service.stop()
  })

  it('fast-dispatches an unbound message into the project selection flow', async () => {
    const { service, store, transport } = harness()
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(transport.cards).toHaveLength(1))
    expect(store.pending.get('bot-1:group:oc_1:oc_1')?.prompt).toBe('hello')
    expect(JSON.stringify(transport.cards[0]?.card)).toContain('cody_feishu_select_project')
    expect(transport.repliesInThread).toEqual([false])
    await service.stop()
  })

  it('opens the project selection card inside a new private-message topic', async () => {
    const { service, store, transport } = harness()
    await service.start()
    transport.chatModeError = new Error('private chats must not query group mode')
    transport.handlers?.onMessage(inbound({ chat_type: 'p2p', message_id: 'om_private' }))
    await vi.waitFor(() => expect(transport.cards).toHaveLength(1))
    expect(store.pending.get('bot-1:p2p:oc_1:om_private')).toMatchObject({ rootId: 'om_private' })
    expect(transport.repliesInThread).toEqual([true])
    await service.stop()
  })

  it('sends project selection to the private chat in explicit flat mode', async () => {
    const { service, store, transport } = harness(undefined, { bot: { ...bot, p2pMode: 'chat' } })
    await service.start()
    transport.handlers?.onMessage(inbound({
      chat_type: 'p2p', message_id: 'om_private_reply', root_id: 'om_old_topic', thread_id: 'omt_old_topic',
    }))
    await vi.waitFor(() => expect(transport.cards).toHaveLength(1))
    expect(store.pending.get('bot-1:p2p:oc_1:chat')).toMatchObject({ rootId: '' })
    expect(transport.cards[0]?.kind).toBe('send')
    expect(transport.repliesInThread).toEqual([])
    await service.stop()
  })

  it('sends the streaming reply to the private chat in explicit flat mode', async () => {
    const flatBinding: FeishuSessionBinding = {
      ...binding(), bindingKey: 'bot-1:p2p:oc_1:chat', rootId: '', chatType: 'p2p',
    }
    const { service, transport, startTurn } = harness(flatBinding, { bot: { ...bot, p2pMode: 'chat' } })
    await service.start()
    transport.handlers?.onMessage(inbound({
      chat_type: 'p2p', message_id: 'om_private_reply', root_id: 'om_old_topic', thread_id: 'omt_old_topic',
    }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(transport.cards[0]?.kind).toBe('send')
    expect(transport.repliesInThread).toEqual([])
    await service.stop()
  })

  it('ignores unmentioned messages in an unbound group', async () => {
    const { service, transport } = harness()
    await service.start()
    transport.handlers?.onMessage(inbound({ content: JSON.stringify({ text: 'background chat' }), mentions: [] }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(transport.cards).toHaveLength(0)
    await service.stop()
  })

  it('blocks an empty allowlist unless broad access was explicitly enabled', async () => {
    const denied = harness(undefined, {
      bot: { ...bot, allowAllUsers: false, allowedOpenIds: [] },
    })
    await denied.service.start()
    denied.transport.handlers?.onMessage(inbound())
    await new Promise((resolve) => setImmediate(resolve))
    expect(denied.transport.cards).toHaveLength(0)
    expect(denied.store.seen.size).toBe(0)
    await denied.service.stop()

    const allowed = harness(undefined, {
      bot: { ...bot, allowAllUsers: true, allowedOpenIds: [] },
    })
    await allowed.service.start()
    allowed.transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(allowed.transport.cards).toHaveLength(1))
    await allowed.service.stop()
  })

  it('lets an unauthorized mentioned user request a narrow grant and join the shared Session after owner approval', async () => {
    const { service, store, transport, startTurn, grantUser } = harness(binding(), {
      bot: { ...bot, allowedOpenIds: ['ou_owner'], allowAllUsers: false },
    })
    await service.start()

    const request = inbound({ message_id: 'om_access_request' })
    request.event_id = 'event-access-request'
    ;((request.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(request)
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'user:ou_owner')).toBe(true))
    const ownerCard = transport.cards.find((row) => row.kind === 'user:ou_owner')?.card
    const accessAction = findCardActionValue(ownerCard, 'cody_feishu_grant_access')
    const requestToken = String(accessAction?.access_request_token ?? '')
    expect(requestToken).not.toBe('')
    expect(transport.texts.some((text) => text.includes('已向管理员发送访问申请'))).toBe(true)
    expect(startTurn).not.toHaveBeenCalled()
    expect(store.completedEvents).toContain('bot-1:event-access-request')

    const denied = await transport.handlers?.onCardAction({
      action: { value: { action: 'cody_feishu_grant_access', access_request_token: requestToken } },
      operator: { operator_id: { open_id: 'ou_guest' } },
    })
    expect(JSON.stringify(denied)).toContain('只有机器人管理员')
    expect(grantUser).not.toHaveBeenCalled()

    const tampered = await transport.handlers?.onCardAction({
      action: { value: { action: 'cody_feishu_grant_access', access_request_token: `${requestToken}x` } },
      operator: { operator_id: { open_id: 'ou_owner' } },
    })
    expect(JSON.stringify(tampered)).toContain('校验失败')
    expect(grantUser).not.toHaveBeenCalled()

    const approved = await transport.handlers?.onCardAction({
      action: { value: { action: 'cody_feishu_grant_access', access_request_token: requestToken } },
      operator: { operator_id: { open_id: 'ou_owner' } },
    })
    expect(grantUser).toHaveBeenCalledWith({ botId: 'bot-1', openId: 'ou_guest' })
    expect(JSON.stringify(approved)).toContain('已允许访问')
    expect(JSON.stringify(approved)).not.toContain('cody_feishu_')

    const followUp = inbound({ message_id: 'om_guest_followup', content: JSON.stringify({ text: '@_user_1 SHARESESSIONOK' }) })
    followUp.event_id = 'event-guest-followup'
    ;((followUp.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(followUp)
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1))
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', prompt: 'SHARESESSIONOK', metadata: expect.objectContaining({ feishuSenderOpenId: 'ou_guest' }),
    }))
    await service.stop()
  })

  it('coalesces simultaneous duplicate access approvals into one persisted grant', async () => {
    let releaseGrant: (() => void) | undefined
    const grantUser = vi.fn(async () => new Promise<void>((resolve) => { releaseGrant = resolve }))
    const { service, transport } = harness(binding(), {
      bot: { ...bot, allowedOpenIds: ['ou_owner'], allowAllUsers: false },
      grantUser,
    })
    await service.start()
    const request = inbound({ message_id: 'om_access_concurrent' })
    request.event_id = 'event-access-concurrent'
    ;((request.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(request)
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'user:ou_owner')).toBe(true))
    const token = String(findCardActionValue(
      transport.cards.find((row) => row.kind === 'user:ou_owner')?.card,
      'cody_feishu_grant_access',
    )?.access_request_token ?? '')
    const payload = {
      action: { value: { action: 'cody_feishu_grant_access', access_request_token: token } },
      operator: { operator_id: { open_id: 'ou_owner' } },
    }
    const first = transport.handlers?.onCardAction(payload)
    await vi.waitFor(() => expect(grantUser).toHaveBeenCalledTimes(1))
    const second = transport.handlers?.onCardAction(payload)
    await new Promise((resolve) => setImmediate(resolve))
    expect(grantUser).toHaveBeenCalledTimes(1)
    releaseGrant?.()
    const results = await Promise.all([first, second])
    expect(results.map((value) => JSON.stringify(value))).toEqual([
      expect.stringContaining('已允许访问'),
      expect.stringContaining('已允许访问'),
    ])
    expect(grantUser).toHaveBeenCalledTimes(1)
    await service.stop()
  })

  it('supports private access requests and a frozen denial without granting access', async () => {
    const { service, transport, startTurn, grantUser } = harness(undefined, {
      bot: { ...bot, allowedOpenIds: ['ou_owner'], allowAllUsers: false },
    })
    await service.start()
    const request = inbound({
      message_id: 'om_private_access', chat_id: 'oc_private_guest', chat_type: 'p2p', mentions: [],
      content: JSON.stringify({ text: 'hello' }),
    })
    request.event_id = 'event-private-access'
    ;((request.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(request)
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'user:ou_owner')).toBe(true))
    const token = String(findCardActionValue(
      transport.cards.find((row) => row.kind === 'user:ou_owner')?.card,
      'cody_feishu_deny_access',
    )?.access_request_token ?? '')
    const denied = await transport.handlers?.onCardAction({
      action: { value: { action: 'cody_feishu_deny_access', access_request_token: token } },
      operator: { operator_id: { open_id: 'ou_owner' } },
    })
    expect(JSON.stringify(denied)).toContain('已拒绝访问')
    expect(JSON.stringify(denied)).not.toContain('cody_feishu_')
    expect(grantUser).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('rejects an otherwise valid access request token after its seven-day lifetime', async () => {
    let current = new Date('2026-07-19T00:00:00.000Z')
    const { service, transport, grantUser } = harness(undefined, {
      bot: { ...bot, allowedOpenIds: ['ou_owner'], allowAllUsers: false },
      now: () => current,
    })
    await service.start()
    const request = inbound({ message_id: 'om_access_expiring' })
    request.event_id = 'event-access-expiring'
    ;((request.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(request)
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'user:ou_owner')).toBe(true))
    const token = String(findCardActionValue(
      transport.cards.find((row) => row.kind === 'user:ou_owner')?.card,
      'cody_feishu_grant_access',
    )?.access_request_token ?? '')
    current = new Date('2026-07-27T00:00:00.000Z')
    const expired = await transport.handlers?.onCardAction({
      action: { value: { action: 'cody_feishu_grant_access', access_request_token: token } },
      operator: { operator_id: { open_id: 'ou_owner' } },
    })
    expect(JSON.stringify(expired)).toContain('已失效')
    expect(grantUser).not.toHaveBeenCalled()
    await service.stop()
  })

  it('does not create access requests from ambiguous multi-mention group traffic', async () => {
    const { service, store, transport } = harness(binding(), {
      bot: { ...bot, allowedOpenIds: ['ou_owner'], allowAllUsers: false },
    })
    await service.start()
    const request = inbound({
      message_id: 'om_access_ambiguous',
      content: JSON.stringify({ text: '@_user_1 @_user_2 hello' }),
      mentions: [
        { key: '@_user_1', name: 'Cody', id: { open_id: 'ou_bot' } },
        { key: '@_user_2', name: 'Colleague', id: { open_id: 'ou_colleague' } },
      ],
    })
    request.event_id = 'event-access-ambiguous'
    ;((request.sender as Record<string, unknown>).sender_id as Record<string, unknown>).open_id = 'ou_guest'
    transport.handlers?.onMessage(request)
    await new Promise((resolve) => setImmediate(resolve))
    expect(transport.cards).toHaveLength(0)
    expect(transport.texts).toHaveLength(0)
    expect(store.seen.size).toBe(0)
    await service.stop()
  })

  it('enforces a configured group-chat allowlist before claiming the event', async () => {
    const denied = harness(undefined, {
      bot: { ...bot, allowedChatIds: ['oc_allowed'] },
    })
    await denied.service.start()
    denied.transport.handlers?.onMessage(inbound({ chat_id: 'oc_denied' }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(denied.transport.cards).toHaveLength(0)
    expect(denied.store.seen.size).toBe(0)
    await denied.service.stop()

    const allowed = harness(undefined, {
      bot: { ...bot, allowedChatIds: ['oc_1'] },
    })
    await allowed.service.start()
    allowed.transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(allowed.transport.cards).toHaveLength(1))
    await allowed.service.stop()
  })

  it('gives each top-level message in a topic group its own binding anchor', async () => {
    const { service, store, transport } = harness()
    transport.chatMode = 'topic'
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(store.pending.size).toBe(1))
    expect(store.pending.has('bot-1:group:oc_1:om_1')).toBe(true)
    expect(store.pending.get('bot-1:group:oc_1:om_1')?.rootId).toBe('om_1')
    await service.stop()
  })

  it('reuses a bound Codex thread and patches its streaming card from notifications', async () => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(transport.repliesInThread[0]).toBe(false)
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', prompt: 'hello', source: 'feishu' }))

    service.handleAppServerNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello ' } })
    service.handleAppServerNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'world' } })
    service.handleAppServerNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && JSON.stringify(row.card).includes('Hello world'))).toBe(true))
    await service.stop()
  })

  it('does not turn an ordinary group reply into a topic after the group is bound', async () => {
    const existing: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(existing)
    await service.start()
    transport.handlers?.onMessage(inbound({ message_id: 'om_reply', root_id: 'om_original' }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', prompt: 'hello' }))
    expect(transport.repliesInThread[0]).toBe(false)
    await service.stop()
  })

  it('uploads an AI-generated image once and embeds it in the terminal reply card', async () => {
    const { service, transport, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    const imageData = Buffer.from('generated-png').toString('base64')

    service.handleAppServerNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          result: { content: [{ type: 'image', data: imageData, mimeType: 'image/png', alt: 'System diagram' }] },
        },
      },
    })
    service.handleAppServerNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: '图已经画好了。' } },
    })
    service.handleAppServerNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })

    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && JSON.stringify(row.card).includes('img_v2_fake_1'))).toBe(true))
    expect(transport.uploadedImages).toEqual([{ fileName: 'generated-image.png', mimeType: 'image/png', size: 13 }])
    await service.stop()
  })

  it('preserves the text reply and shows a note when an AI image upload fails', async () => {
    const { service, transport, startTurn } = harness(binding())
    transport.failImageUploads = true
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())

    service.handleAppServerNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          result: { content: [{ type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }] },
        },
      },
    })
    service.handleAppServerNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: '文字结论仍然在。' } },
    })
    service.handleAppServerNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })

    await vi.waitFor(() => expect(transport.cards.some((row) => {
      const card = JSON.stringify(row.card)
      return row.kind === 'patch' && card.includes('文字结论仍然在') && card.includes('1 张 AI 图片上传失败')
    })).toBe(true))
    await service.stop()
  })

  it('starts the authoritative turn when an advisory busy check cannot read a fresh thread', async () => {
    const isThreadBusy = vi.fn(async () => {
      throw new Error('thread thread-new is not materialized yet; includeTurns is unavailable before first user message')
    })
    const freshBinding = { ...binding(), threadId: 'thread-new', threadTitle: 'New session' }
    const { service, transport, startTurn } = harness(freshBinding, { isThreadBusy })
    await service.start()

    transport.handlers?.onMessage(inbound())

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-new', prompt: 'hello', source: 'feishu',
    }))
    expect(transport.cards.some((row) => row.kind === 'reply')).toBe(true)
    await service.stop()
  })

  it('queues messages for a busy shared thread and starts the next turn only after completion', async () => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1))

    const second = inbound({ message_id: 'om_2', content: JSON.stringify({ text: '@_user_1 second' }) })
    second.event_id = 'event-2'
    transport.handlers?.onMessage(second)
    await vi.waitFor(() => expect(transport.cards.filter((row) => row.kind === 'reply')).toHaveLength(2))
    expect(startTurn).toHaveBeenCalledTimes(1)

    service.handleAppServerNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2))
    expect(startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'second' }))
    await service.stop()
  })

  it('keeps a reconnecting Codex turn active until an authoritative terminal notification', async () => {
    const readTurnState = vi.fn(async () => ({ status: 'running' as const }))
    const { service, transport, startTurn } = harness(binding(), { readTurnState })
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1))

    const second = inbound({ message_id: 'om_2', content: JSON.stringify({ text: '@_user_1 second' }) })
    second.event_id = 'event-2'
    transport.handlers?.onMessage(second)
    await vi.waitFor(() => expect(transport.cards.filter((row) => row.kind === 'reply')).toHaveLength(2))

    service.handleAppServerNotification({
      method: 'error',
      params: { threadId: 'thread-1', turnId: 'turn-1', message: 'Reconnecting... 2/5' },
    })
    await vi.waitFor(() => expect(readTurnState).toHaveBeenCalledWith('thread-1', 'turn-1'))
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(transport.cards.some((row) => row.kind === 'patch' && JSON.stringify(row.card).includes('Reconnecting... 2/5'))).toBe(false)

    service.handleAppServerNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2))
    expect(startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'second' }))
    await service.stop()
  })

  it('continues a shared-thread queue even when the terminal card patch fails', async () => {
    const binding: FeishuSessionBinding = {
      botId: 'bot-1', bindingKey: 'bot-1:group:oc_1:oc_1', chatId: 'oc_1', rootId: '', chatType: 'group',
      senderOpenId: 'ou_user', projectKey: '/repo', projectLabel: 'Repo', cwd: '/repo',
      threadId: 'thread-1', threadTitle: 'Existing thread',
    }
    const { service, transport, startTurn } = harness(binding)
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1))

    const second = inbound({ message_id: 'om_2', content: JSON.stringify({ text: '@_user_1 second' }) })
    second.event_id = 'event-2'
    transport.handlers?.onMessage(second)
    await vi.waitFor(() => expect(transport.cards.filter((row) => row.kind === 'reply')).toHaveLength(2))
    transport.failCardUpdates = true
    service.handleAppServerNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })

    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2))
    expect(startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: 'second',
      metadata: expect.objectContaining({ feishuMessageId: 'om_2' }),
    }))
    await service.stop()
  })

  it('binds an existing session from a card action and delivers the pending prompt', async () => {
    const { service, store, transport, startTurn } = harness()
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(store.pending.size).toBe(1))
    const response = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' },
      context: { open_message_id: 'selection-card' },
      action: {
        option: 'thread-1',
        value: {
          action: 'cody_feishu_select_session', binding_key: 'bot-1:group:oc_1:oc_1',
          project_key: '/repo', pending_message_id: 'om_1',
        },
      },
    })
    expect(JSON.stringify(response)).toContain('正在处理')
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'selection-card' && JSON.stringify(row.card).includes('Session 已连接'))).toBe(true))
    expect(store.bindings.get('bot-1:group:oc_1:oc_1')?.threadId).toBe('thread-1')
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.stop()
  })

  it('exposes connected runtime snapshots without secrets', async () => {
    const { service } = harness()
    await service.start()
    expect(service.getRuntimeSnapshots()).toEqual([expect.objectContaining({ botId: 'bot-1', state: 'connected', connectionState: 'connected' })])
    expect(JSON.stringify(service.getRuntimeSnapshots())).not.toContain('secret')
    await service.stop()
  })

  it('runs a live connectivity probe without exposing credentials or identity values', async () => {
    const { service } = harness()
    await service.start()
    const report = await service.diagnose('bot-1')
    expect(report).toMatchObject({
      botId: 'bot-1', ok: true,
      checks: [
        { id: 'configuration', status: 'pass' },
        { id: 'enabled', status: 'pass' },
        { id: 'runtime', status: 'pass' },
        { id: 'long_connection', status: 'pass' },
        { id: 'credential_api', status: 'pass' },
        { id: 'bot_identity', status: 'pass' },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('ou_bot')
    await service.stop()
  })

  it('fails the live probe when credentials are rejected or the runtime is disconnected', async () => {
    const { service, transport } = harness()
    await service.start()
    transport.state = 'failed'
    transport.identityError = new Error('tenant_access_token rejected secret')
    const report = await service.diagnose('bot-1')
    expect(report.ok).toBe(false)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'long_connection', status: 'fail' }),
      expect.objectContaining({ id: 'credential_api', status: 'fail' }),
      expect.objectContaining({ id: 'bot_identity', status: 'fail' }),
    ]))
    expect(JSON.stringify(report)).not.toContain('secret')
    await service.stop()
  })

  it('returns requestUserInput answers and freezes the card after submission', async () => {
    const { service, transport, respondServerRequest, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleServerRequest({
      id: 77,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
        questions: [{
          id: 'size', header: 'Size', question: 'Choose a size', isOther: false, isSecret: false,
          options: [{ label: 'Small', description: 'Fast' }, { label: 'Large', description: 'Thorough' }],
        }],
      },
    })
    expect(JSON.stringify(transport.cards.at(-1)?.card)).toContain('cody_feishu_user_input_toggle')

    const toggled = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' },
      action: { value: {
        action: 'cody_feishu_user_input_toggle', request_id: '77', binding_key: binding().bindingKey,
        requester_open_id: 'ou_user', question_id: 'size', answer: 'Large',
      } },
    })
    expect(JSON.stringify(toggled)).toContain('● Large')

    const submitted = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' },
      context: { open_message_id: 'input-card' },
      action: { value: {
        action: 'cody_feishu_user_input_submit', request_id: '77', binding_key: binding().bindingKey,
        requester_open_id: 'ou_user',
      } },
    })
    expect(JSON.stringify(submitted)).toContain('正在处理')
    await vi.waitFor(() => expect(respondServerRequest).toHaveBeenCalledWith({
      requestId: '77',
      result: { answers: { size: { answers: ['Large'] } } },
    }))
    expect(JSON.stringify(transport.cards.find((row) => row.kind === 'patch' && row.id === 'input-card')?.card)).toContain('已提交答案')
    await service.stop()
  })

  it('contains a failed private approval-card delivery at the notification boundary', async () => {
    const { service, transport, startTurn, logger } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    transport.sendUserCardError = Object.assign(
      new Error('Request failed with status code 400'),
      { status: 400 },
    )

    service.handleAppServerNotification({
      method: 'server/request',
      params: {
        id: 80,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          command: 'git status',
        },
      },
    })

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(
        'failed to present Codex server request 80',
      ))
    })
    expect(service.getRuntimeSnapshots()[0]?.connectionState).toBe('connected')
    await service.stop()
  })

  it('accepts a free-text follow-up answer in Feishu and syncs the original card', async () => {
    const { service, transport, respondServerRequest, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleServerRequest({
      id: 78,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1',
        questions: [{ id: 'note', header: 'Note', question: 'Add context', isOther: true, isSecret: false, options: [] }],
      },
    })
    expect(JSON.stringify(transport.cards.at(-1)?.card)).toContain('/answer 78 note')

    transport.handlers?.onMessage(commandMessage('om_custom_answer', '/answer 78 note Keep the migration reversible'))
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && JSON.stringify(row.card).includes('Keep the migration reversible'))).toBe(true))
    expect(transport.texts.some((text) => text.includes('已记录自定义答案'))).toBe(true)

    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'custom-answer-card' },
      action: { value: {
        action: 'cody_feishu_user_input_submit', request_id: '78', binding_key: binding().bindingKey,
        requester_open_id: 'ou_user',
      } },
    })
    await vi.waitFor(() => expect(respondServerRequest).toHaveBeenCalledWith({
      requestId: '78', result: { answers: { note: { answers: ['Keep the migration reversible'] } } },
    }))
    await service.stop()
  })

  it('submits a sensitive free-text answer only from private chat and never echoes it', async () => {
    const { service, transport, respondServerRequest, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleServerRequest({
      id: 79,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1',
        questions: [{ id: 'token', header: 'Token', question: 'Enter token', isOther: true, isSecret: true, options: [] }],
      },
    })
    transport.handlers?.onMessage(commandMessage('om_group_secret', '/answer 79 token secret-from-group'))
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('只能在与机器人私聊'))).toBe(true))
    expect(respondServerRequest).not.toHaveBeenCalled()

    const privateMessage = inbound({
      message_id: 'om_private_secret', chat_id: 'oc_private', chat_type: 'p2p', mentions: [],
      content: JSON.stringify({ text: '/answer 79 token private-secret-value' }),
    })
    privateMessage.event_id = 'event-private-secret'
    transport.handlers?.onMessage(privateMessage)
    await vi.waitFor(() => expect(respondServerRequest).toHaveBeenCalledWith({
      requestId: '79', result: { answers: { token: { answers: ['private-secret-value'] } } },
    }))
    expect(JSON.stringify(transport.cards)).not.toContain('private-secret-value')
    expect(transport.texts.some((text) => text.includes('内容不会显示'))).toBe(true)
    await service.stop()
  })

  it('rejects unauthorized request operators and freezes a resolved approval', async () => {
    const { service, transport, approvalResolve, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleApprovalRequest({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'npm test' },
    })
    const deniedOperator = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_other' },
      context: { open_message_id: 'approval-card' },
      action: { value: {
        action: 'cody_feishu_approve', request_id: '42', binding_key: binding().bindingKey,
        requester_open_id: 'ou_user', decision: 'accept', scope: 'single',
      } },
    })
    expect(JSON.stringify(deniedOperator)).toContain('只有请求发起者')
    expect(approvalResolve).not.toHaveBeenCalled()
    expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'approval-card')).toBe(false)

    const approved = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' },
      context: { open_message_id: 'approval-card' },
      action: { value: {
        action: 'cody_feishu_approve', request_id: '42', binding_key: binding().bindingKey,
        requester_open_id: 'ou_user', decision: 'accept', scope: 'single',
      } },
    })
    expect(JSON.stringify(approved)).toContain('正在处理')
    await vi.waitFor(() => expect(approvalResolve).toHaveBeenCalledWith({ requestId: '42', decision: 'accept', scope: 'single' }))
    expect(JSON.stringify(transport.cards.find((row) => row.kind === 'patch' && row.id === 'approval-card')?.card)).toContain('已批准')
    await service.stop()
  })

  it('supports session status, list, switch, rename and archive commands', async () => {
    const initial = binding()
    const { service, store, transport, renameSession, archiveSession } = harness(initial)
    await service.start()

    transport.handlers?.onMessage(commandMessage('om_status', '/status'))
    await vi.waitFor(() => expect(transport.cards.some((row) => JSON.stringify(row.card).includes('Session 状态'))).toBe(true))

    transport.handlers?.onMessage(commandMessage('om_sessions', '/sessions'))
    await vi.waitFor(() => expect(transport.cards.some((row) => JSON.stringify(row.card).includes('cody_feishu_select_session'))).toBe(true))

    transport.handlers?.onMessage(commandMessage('om_switch', '/switch 2'))
    await vi.waitFor(() => expect(store.bindings.get(initial.bindingKey)?.threadId).toBe('thread-2'))
    expect(store.bindings.get(initial.bindingKey)?.threadTitle).toBe('Second thread')

    transport.handlers?.onMessage(commandMessage('om_rename', '/rename Mobile shared session'))
    await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith({ threadId: 'thread-2', title: 'Mobile shared session' }))
    expect(store.bindings.get(initial.bindingKey)?.threadTitle).toBe('Mobile shared session')

    transport.handlers?.onMessage(commandMessage('om_archive', '/archive'))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith({ threadId: 'thread-2' }))
    expect(store.bindings.has(initial.bindingKey)).toBe(false)
    await service.stop()
  })

  it('freezes a request card when it is resolved from the Web UI', async () => {
    const { service, transport, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleApprovalRequest({
      id: 99,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'Update files' },
    })
    service.handleAppServerNotification({ method: 'server/request/resolved', params: { id: 99 } })
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && JSON.stringify(row.card).includes('已在其他入口处理'))).toBe(true))
    await service.stop()
  })

  it('acks quickly and serializes every Session option that consumes the same pending message', async () => {
    let resolveProjects!: (projects: Array<{ projectKey: string; cwd: string; label: string; sessionCount: number; sessions: never[] }>) => void
    const projects = new Promise<Array<{ projectKey: string; cwd: string; label: string; sessionCount: number; sessions: never[] }>>((resolve) => { resolveProjects = resolve })
    const startSession = vi.fn(async () => ({ threadId: 'thread-new', title: 'New thread' }))
    const { service, store, transport } = harness(undefined, { listProjects: () => projects, startSession })
    await service.start()
    await store.savePendingMessage({
      botId: 'bot-1', bindingKey: binding().bindingKey, messageId: 'om_pending', prompt: 'hello',
      chatId: 'oc_1', rootId: '', chatType: 'group', senderOpenId: 'ou_user', createdAtIso: new Date().toISOString(),
    })
    const payload = {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'new-card' },
      action: { value: {
        action: 'cody_feishu_new_session', binding_key: binding().bindingKey,
        project_key: '/repo', pending_message_id: 'om_pending',
      } },
    }
    const before = performance.now()
    const first = await service.handleCardAction('bot-1', payload)
    expect(performance.now() - before).toBeLessThan(50)
    expect(first).toEqual({ toast: expect.objectContaining({ type: 'info' }) })
    expect(transport.cards.some((row) => row.kind === 'patch')).toBe(false)
    const second = await service.handleCardAction('bot-1', payload)
    expect(JSON.stringify(second)).toContain('请勿重复点击')
    const conflicting = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'new-card' },
      action: {
        option: 'thread-existing',
        value: {
          action: 'cody_feishu_select_session', binding_key: binding().bindingKey,
          project_key: '/repo', pending_message_id: 'om_pending',
        },
      },
    })
    expect(JSON.stringify(conflicting)).toContain('请勿重复点击')
    resolveProjects([{ projectKey: '/repo', cwd: '/repo', label: 'Repo', sessionCount: 0, sessions: [] }])
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'new-card')).toBe(true))
    expect(store.bindings.get(binding().bindingKey)?.threadId).toBe('thread-new')
    await service.stop()
  })

  it('creates a fixed-session card route and safely applies Codex tool refinement', async () => {
    const analyzeAutoRoute = vi.fn(async () => ({
      requiredKeywords: ['任务ID', '不存在的字段', '校验结果'],
      instruction: '定位差异根因并给出处理建议',
      reason: '任务ID和校验结果是稳定结构',
    }))
    const { service, store, startTurn } = harness(undefined, {
      analyzeAutoRoute,
      scenarioPackages: [{
        id: 'scenario-alert', title: '差异告警排障', description: '排查差异告警',
        content: '按稳定标识核对并定位根因。',
        primarySkill: {
          name: 'alert-triage', path: '/repo/.codex/skills/alert-triage/SKILL.md',
          displayName: 'Alert triage', description: 'Investigate alerts.',
        },
      }],
    })
    await service.start()
    const current = binding()
    await store.savePendingMessage({
      botId: 'bot-1', bindingKey: current.bindingKey, messageId: 'om_config_route',
      prompt: '请分析告警', chatId: 'oc_1', rootId: '', chatType: 'group', senderOpenId: 'ou_user',
      createdAtIso: new Date().toISOString(),
      autoRouteDraft: {
        sourceSenderId: 'on_alert_bot', sourceSenderType: 'app', messageType: 'interactive',
        cardTitle: '【平台】差异播报', requiredKeywords: ['任务ID', '校验结果', '校验时间'],
        fingerprintKey: 'initial-fingerprint', instruction: '请分析告警',
        preview: '[卡片: 【平台】差异播报]\n任务ID：T1\n校验结果：不一致',
      },
    })
    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'route-picker-card' },
      action: { option: 'scenario-alert', value: {
        action: FEISHU_CARD_ACTIONS.selectScenarioPackage, binding_key: current.bindingKey,
        project_key: '/repo', pending_message_id: 'om_config_route',
      } },
    })
    await vi.waitFor(() => expect(store.pending.get(current.bindingKey)?.scenarioPackageId).toBe('scenario-alert'))
    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'route-picker-card' },
      action: { option: 'thread-1', value: {
        action: 'cody_feishu_select_session', binding_key: current.bindingKey,
        project_key: '/repo', pending_message_id: 'om_config_route',
      } },
    })
    await vi.waitFor(() => expect(analyzeAutoRoute).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect([...store.autoRoutes.values()][0]).toMatchObject({
      sessionId: 'thread-1', requiredKeywords: ['任务ID', '校验结果'],
      instruction: '定位差异根因并给出处理建议',
      scenarioPackageId: 'scenario-alert',
    }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      skills: [{ name: 'alert-triage', path: '/repo/.codex/skills/alert-triage/SKILL.md' }],
      prompt: expect.stringContaining('按稳定标识核对并定位根因。'),
    })))
    expect([...store.bindings.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingKey: expect.stringContaining(':auto-route:'), threadId: 'thread-1' }),
    ]))
    await service.stop()
  })

  it('keeps an ordinary quoted foreign-bot card in the normal conversation flow', async () => {
    const { service, store, transport, startTurn } = harness()
    transport.getMessage = async (messageId, options) => ({ data: { items: messageId === 'om_source_card'
      ? [{
          message_id: messageId, msg_type: 'interactive',
          sender: { id: 'on_alert_bot', id_type: 'union_id', sender_type: 'app', name: 'Alert bot' },
          body: { content: JSON.stringify({
            header: { title: { tag: 'plain_text', content: '【平台】差异播报' } },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: '任务ID：T1\n校验结果：不一致' } }],
          }) },
        }]
      : [{
          message_id: messageId, msg_type: 'text',
          body: { content: JSON.stringify({ text: '@_user_1 帮我分析根因' }) },
        }] } })
    await service.start()
    transport.handlers?.onMessage(inbound({
      message_id: 'om_config', parent_id: 'om_source_card', root_id: 'om_source_card',
      content: JSON.stringify({ text: '@_user_1 帮我分析根因' }),
    }))
    await vi.waitFor(() => expect([...store.pending.values()].find((row) => row.messageId === 'om_config')).toBeTruthy())
    expect([...store.pending.values()].find((row) => row.messageId === 'om_config')?.autoRouteDraft).toBeUndefined()
    expect(transport.cards.some((row) => JSON.stringify(row.card).includes('配置卡片自动路由'))).toBe(false)
    expect(transport.cards.some((row) => JSON.stringify(row.card).includes('连接 CodyWeb'))).toBe(true)
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('turns /route on a quoted foreign-bot card into the route project picker', async () => {
    const { service, store, transport, startTurn } = harness()
    transport.getMessage = async (messageId, options) => ({ data: { items: messageId === 'om_source_card'
      ? [{
          message_id: messageId, msg_type: 'interactive',
          sender: { id: 'on_alert_bot', id_type: 'union_id', sender_type: 'app', name: 'Alert bot' },
          body: { content: JSON.stringify({
            header: { title: { tag: 'plain_text', content: '【平台】差异播报' } },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: '任务ID：T1\n校验结果：不一致' } }],
          }) },
        }]
      : [{
          message_id: messageId, msg_type: 'text',
          body: { content: JSON.stringify({ text: '@_user_1 /route 帮我分析根因' }) },
        }] } })
    await service.start()
    transport.handlers?.onMessage(inbound({
      message_id: 'om_config', parent_id: 'om_source_card', root_id: 'om_source_card',
      content: JSON.stringify({ text: '@_user_1 /route 帮我分析根因' }),
    }))
    await vi.waitFor(() => expect([...store.pending.values()].find((row) => row.messageId === 'om_config')?.autoRouteDraft).toMatchObject({
      sourceSenderId: '*', cardTitle: '【平台】差异播报',
      requiredKeywords: ['任务ID', '校验结果'], instruction: '帮我分析根因',
    }))
    expect(transport.cards.some((row) => JSON.stringify(row.card).includes('配置卡片自动路由'))).toBe(true)
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('explains that /route requires a quoted card', async () => {
    const { service, transport, startTurn } = harness()
    await service.start()
    transport.handlers?.onMessage(commandMessage('om_route_without_quote', '/route 分析根因'))
    await vi.waitFor(() => expect(transport.texts).toContain('请回复一张飞书卡片并发送：@Cody /route [处理说明]'))
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('rejects a stale Session card instead of consuming a newer pending message', async () => {
    const { service, store, transport } = harness()
    await service.start()
    await store.savePendingMessage({
      botId: 'bot-1', bindingKey: binding().bindingKey, messageId: 'om_current', prompt: 'current prompt',
      chatId: 'oc_1', rootId: '', chatType: 'group', senderOpenId: 'ou_user', createdAtIso: new Date().toISOString(),
    })
    const malformed = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'malformed-card' },
      action: { option: 'thread-1', value: {
        action: 'cody_feishu_select_session', binding_key: binding().bindingKey, project_key: '/repo',
      } },
    })
    expect(JSON.stringify(malformed)).toContain('缺少原消息标识')
    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'stale-card' },
      action: { option: 'thread-1', value: {
        action: 'cody_feishu_select_session', binding_key: binding().bindingKey,
        project_key: '/repo', pending_message_id: 'om_old',
      } },
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(store.bindings.has(binding().bindingKey)).toBe(false)
    expect(store.pending.get(binding().bindingKey)?.messageId).toBe('om_current')
    expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'stale-card')).toBe(false)

    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'forged-session-card' },
      action: { option: 'thread-hidden-or-other-project', value: {
        action: 'cody_feishu_select_session', binding_key: binding().bindingKey,
        project_key: '/repo', pending_message_id: 'om_current',
      } },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(store.bindings.has(binding().bindingKey)).toBe(false)
    expect(store.pending.get(binding().bindingKey)?.messageId).toBe('om_current')
    await service.stop()
  })

  it('restores a bound pending message after a process restart boundary', async () => {
    const current = binding()
    const { service, store, startTurn } = harness(current)
    await store.savePendingMessage({
      botId: current.botId, bindingKey: current.bindingKey, messageId: 'om_recover', prompt: 'recover me',
      chatId: current.chatId, rootId: current.rootId, chatType: current.chatType,
      senderOpenId: current.senderOpenId, createdAtIso: new Date().toISOString(),
      sessionSelection: {
        action: 'select_session', projectKey: current.projectKey, knownThreadIds: [current.threadId],
        startedAtIso: new Date().toISOString(), createdThreadId: current.threadId,
        createdThreadTitle: current.threadTitle,
      },
    })

    await service.start()
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: current.threadId, prompt: 'recover me' }))
    expect(store.pending.has(current.bindingKey)).toBe(false)
    await service.stop()
  })

  it('does not drain a new project picker into the conversation old binding after restart', async () => {
    const current = binding()
    const { service, store, startTurn } = harness(current)
    await store.savePendingMessage({
      botId: current.botId, bindingKey: current.bindingKey, messageId: 'om_waiting_for_choice', prompt: 'use another project',
      chatId: current.chatId, rootId: current.rootId, chatType: current.chatType,
      senderOpenId: current.senderOpenId, createdAtIso: new Date().toISOString(),
    })

    await service.start()
    expect(startTurn).not.toHaveBeenCalled()
    expect(store.pending.get(current.bindingKey)?.messageId).toBe('om_waiting_for_choice')
    await service.stop()
  })

  it('keeps completed selection caching scoped to one pending message and allows a later rebind', async () => {
    const current = binding()
    const { service, store } = harness(current)
    await service.start()
    const choose = async (messageId: string, threadId: string) => {
      await store.savePendingMessage({
        botId: current.botId, bindingKey: current.bindingKey, messageId, prompt: `prompt ${messageId}`,
        chatId: current.chatId, rootId: current.rootId, chatType: current.chatType,
        senderOpenId: current.senderOpenId, createdAtIso: new Date().toISOString(),
      })
      await service.handleCardAction('bot-1', {
        operator: { open_id: 'ou_user' }, context: { open_message_id: `card-${messageId}` },
        action: {
          option: threadId,
          value: {
            action: 'cody_feishu_select_session', binding_key: current.bindingKey,
            project_key: '/repo', pending_message_id: messageId,
          },
        },
      })
      await vi.waitFor(() => expect(store.bindings.get(current.bindingKey)?.threadId).toBe(threadId))
    }

    await choose('om_round_one', 'thread-2')
    await choose('om_round_two', 'thread-1')
    await service.stop()
  })

  it('recovers a newly created Session from a durable creation intent after restart', async () => {
    const startSession = vi.fn(async () => ({ threadId: 'must-not-create', title: 'Duplicate' }))
    const recovered = { threadId: 'thread-recovered', title: 'Recovered thread', updatedAtIso: new Date().toISOString() }
    const { service, store } = harness(undefined, {
      startSession,
      listProjects: async () => [{
        projectKey: '/repo', cwd: '/repo', label: 'Repo', sessionCount: 1, sessions: [recovered],
      }],
    })
    await service.start()
    await store.savePendingMessage({
      botId: 'bot-1', bindingKey: binding().bindingKey, messageId: 'om_creation_recovery', prompt: 'continue safely',
      chatId: 'oc_1', rootId: '', chatType: 'group', senderOpenId: 'ou_user', createdAtIso: new Date().toISOString(),
      sessionSelection: {
        action: 'new_session', projectKey: '/repo', knownThreadIds: [], startedAtIso: new Date().toISOString(),
      },
    })
    await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'recovery-card' },
      action: { value: {
        action: 'cody_feishu_new_session', binding_key: binding().bindingKey,
        project_key: '/repo', pending_message_id: 'om_creation_recovery',
      } },
    })

    await vi.waitFor(() => expect(store.bindings.get(binding().bindingKey)?.threadId).toBe('thread-recovered'))
    expect(startSession).not.toHaveBeenCalled()
    await service.stop()
  })

  it('lets the binding owner stop a Web-origin turn in the shared Session', async () => {
    const isThreadBusy = vi.fn(async () => true)
    const findActiveTurnId = vi.fn(async () => 'turn-web')
    const { service, transport, stopTurn } = harness(binding(), { isThreadBusy, findActiveTurnId })
    await service.start()

    transport.handlers?.onMessage(commandMessage('om_external_status', '/status'))
    await vi.waitFor(() => expect(transport.cards.some((row) => JSON.stringify(row.card).includes('其他入口运行中'))).toBe(true))
    transport.handlers?.onMessage(commandMessage('om_external_stop', '/stop'))
    await vi.waitFor(() => expect(stopTurn).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-web' }))
    expect(transport.texts.some((text) => text.includes('其他入口启动的任务'))).toBe(true)
    await service.stop()
  })

  it('re-reads and stops the latest Web-origin turn when the first active id is stale', async () => {
    const findActiveTurnId = vi.fn()
      .mockResolvedValueOnce('turn-stale')
      .mockResolvedValueOnce('turn-current')
    const { service, transport, stopTurn } = harness(binding(), {
      findActiveTurnId,
      stopTurn: async ({ turnId }) => {
        if (turnId === 'turn-stale') throw new Error('expected active turn id turn-stale but found turn-current')
      },
    })
    await service.start()

    transport.handlers?.onMessage(commandMessage('om_external_stop_retry', '/stop'))

    await vi.waitFor(() => expect(stopTurn).toHaveBeenCalledTimes(2))
    expect(stopTurn).toHaveBeenNthCalledWith(1, { threadId: 'thread-1', turnId: 'turn-stale' })
    expect(stopTurn).toHaveBeenNthCalledWith(2, { threadId: 'thread-1', turnId: 'turn-current' })
    expect(transport.texts.some((text) => text.includes('其他入口启动的任务'))).toBe(true)
    await service.stop()
  })

  it('keeps the durable turn and card cancelled when completion races an explicit stop', async () => {
    const lifecycle = new MemoryLifecycle()
    let serviceForStop: FeishuBotService | null = null
    const setup = harness(binding(), {
      lifecycle,
      stopTurn: async () => {
        serviceForStop?.handleAppServerNotification({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        })
        await new Promise((resolve) => setImmediate(resolve))
      },
    })
    serviceForStop = setup.service
    await setup.service.start()

    setup.transport.handlers?.onMessage(commandMessage('om_stop_race_prompt', 'run until stopped'))
    await vi.waitFor(() => expect(setup.startTurn).toHaveBeenCalledTimes(1))
    setup.transport.handlers?.onMessage(commandMessage('om_stop_race_command', '/stop'))

    await vi.waitFor(() => expect(setup.stopTurn).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' }))
    await vi.waitFor(() => expect([...lifecycle.turns.values()][0]?.status).toBe('cancelled'))
    expect([...lifecycle.cards.values()][0]?.status).toBe('cancelled')
    expect(setup.transport.cards.some((row) => JSON.stringify(row.card).includes('已停止'))).toBe(true)
    await setup.service.stop()
  })

  it('keeps the original card retryable after a background failure', async () => {
    let attempts = 0
    const project = { projectKey: '/repo', cwd: '/repo', label: 'Repo', sessionCount: 1, sessions: [{ threadId: 'thread-1', title: 'Existing thread' }] }
    const { service, store, transport } = harness(undefined, {
      listProjects: async () => { attempts += 1; if (attempts === 1) throw new Error('catalog unavailable'); return [project] },
    })
    await service.start()
    await store.savePendingMessage({ ...binding(), messageId: 'om_pending', prompt: 'hello', createdAtIso: new Date().toISOString() })
    const payload = {
      operator: { open_id: 'ou_user' }, context: { open_message_id: 'retry-card' },
      action: { option: 'thread-1', value: {
        action: 'cody_feishu_select_session', binding_key: binding().bindingKey,
        project_key: '/repo', pending_message_id: 'om_pending',
      } },
    }
    await service.handleCardAction('bot-1', payload)
    await vi.waitFor(() => expect(attempts).toBe(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'retry-card')).toBe(false)
    await service.handleCardAction('bot-1', payload)
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'patch' && row.id === 'retry-card')).toBe(true))
    expect(attempts).toBe(2)
    await service.stop()
  })

  it('fails closed when chat mode lookup fails even with an old flat binding', async () => {
    const { service, transport, startTurn } = harness(binding())
    transport.chatModeError = new Error('lookup unavailable')
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('无法确认群聊模式'))).toBe(true))
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('rejects inbound messages without a stable sender open_id', async () => {
    const { service, transport, startTurn } = harness(binding())
    await service.start()
    const message = inbound()
    message.sender = { sender_type: 'user', sender_id: {} }
    transport.handlers?.onMessage(message)
    await new Promise((resolve) => setImmediate(resolve))
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('shows compact help and does not forward unknown slash commands to Codex', async () => {
    const { service, transport, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(commandMessage('om_help', '/help'))
    await vi.waitFor(() => expect(transport.cards.some((row) => JSON.stringify(row.card).includes('CodyWeb 机器人帮助'))).toBe(true))
    transport.handlers?.onMessage(commandMessage('om_unknown', '/definitely_unknown'))
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('未知命令'))).toBe(true))
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('persists Plan mode per binding and forwards it to new turns', async () => {
    const { service, store, transport, startTurn } = harness(binding())
    await service.start()
    transport.handlers?.onMessage(commandMessage('om_mode_plan', '/mode plan'))
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('Plan 模式'))).toBe(true))
    expect(store.bindings.get(binding().bindingKey)?.collaborationMode).toBe('plan')

    transport.handlers?.onMessage(commandMessage('om_mode_prompt', 'Ask me to choose one option'))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ collaborationMode: 'plan', permissionMode: 'yolo' }))
    await service.stop()
  })

  it('defaults Feishu bindings to YOLO and persists Normal permission mode', async () => {
    const { service, store, transport, startTurn } = harness(binding())
    await service.start()

    transport.handlers?.onMessage(commandMessage('om_permission_normal', '/permission normal'))
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('Normal'))).toBe(true))
    expect(store.bindings.get(binding().bindingKey)?.permissionMode).toBe('normal')

    transport.handlers?.onMessage(commandMessage('om_permission_prompt', 'Run this carefully'))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'normal' }))

    transport.handlers?.onMessage(commandMessage('om_permission_yolo', '/yolo'))
    await vi.waitFor(() => expect(transport.texts.some((text) => text.includes('已切换到 YOLO'))).toBe(true))
    expect(store.bindings.get(binding().bindingKey)?.permissionMode).toBe('yolo')
    await service.stop()
  })

  it('switches permission mode from a bound-session card in both directions', async () => {
    const { service, store } = harness({ ...binding(), permissionMode: 'yolo' })
    await service.start()
    const action = (permissionMode: 'normal' | 'yolo') => ({
      operator: { open_id: 'ou_user' },
      context: { open_message_id: 'permission-card' },
      action: { value: {
        action: 'cody_feishu_set_permission_mode',
        binding_key: binding().bindingKey,
        permission_mode: permissionMode,
      } },
    })

    await service.handleCardAction('bot-1', action('normal'))
    await vi.waitFor(() => expect(store.bindings.get(binding().bindingKey)?.permissionMode).toBe('normal'))
    await service.handleCardAction('bot-1', action('yolo'))
    await vi.waitFor(() => expect(store.bindings.get(binding().bindingKey)?.permissionMode).toBe('yolo'))
    await service.handleCardAction('bot-1', action('normal'))
    await vi.waitFor(() => expect(store.bindings.get(binding().bindingKey)?.permissionMode).toBe('normal'))
    await service.stop()
  })

  it('redacts SDK headers, token fields and the exact app secret', () => {
    const serialized = formatFeishuSdkError(
      'Authorization: Bearer abc.def {"appSecret":"sekret","tenant_access_token":"tenant","app_access_token":"app","client_secret":"client","refresh_token":"refresh"} sekret',
      ['sekret'],
    )
    expect(serialized).not.toMatch(/abc\.def|sekret|tenant"|app"|client"|refresh"/u)
    expect(serialized).toContain('[REDACTED]')
    expect(formatFeishuSdkError({
      message: 'request failed', code: 'E_HTTP', response: { status: 401, data: { code: 999, msg: 'denied' } },
      config: { headers: { Authorization: 'Bearer leaked' }, appSecret: 'leaked-secret' },
    })).toBe('code=999 status=401 message=denied')
  })

  it('deduplicates concurrent approval notifications and ignores Web-origin requests', async () => {
    const { service, transport, startTurn } = harness(binding())
    await service.start()
    await service.handleApprovalRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-web', turnId: 'turn-web' } })
    expect(transport.cards).toHaveLength(0)
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    const request = { id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'npm test' } }
    await Promise.all([service.handleApprovalRequest(request), service.handleApprovalRequest(request)])
    expect(transport.cards.filter((row) => row.kind === 'user:ou_user' && JSON.stringify(row.card).includes('npm test'))).toHaveLength(1)
    await service.stop()
  })

  it('enforces group mention modes and yields to messages addressed to another user', async () => {
    const alwaysBot = { ...bot, groupMentionMode: undefined }
    const always = harness(binding(), { bot: alwaysBot })
    await always.service.start()
    always.transport.handlers?.onMessage(inbound({ content: JSON.stringify({ text: 'plain group chat' }), mentions: [] }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(always.startTurn).not.toHaveBeenCalled()
    await always.service.stop()

    const topicBinding = { ...binding(), bindingKey: 'bot-1:group:oc_1:om_root', rootId: 'om_root' }
    const topic = harness(topicBinding, { bot: { ...bot, groupMentionMode: 'topic' } })
    await topic.service.start()
    topic.transport.handlers?.onMessage(inbound({ root_id: 'om_root', thread_id: 'omt_topic', content: JSON.stringify({ text: 'continue topic' }), mentions: [] }))
    await vi.waitFor(() => expect(topic.startTurn).toHaveBeenCalledOnce())
    await topic.service.stop()

    const bound = harness(binding(), { bot: { ...bot, groupMentionMode: 'bound' } })
    await bound.service.start()
    bound.transport.handlers?.onMessage(inbound({
      content: JSON.stringify({ text: '@_user_2 please review' }),
      mentions: [{ key: '@_user_2', id: { open_id: 'ou_someone_else' }, name: 'Someone' }],
    }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(bound.startTurn).not.toHaveBeenCalled()
    await bound.service.stop()
  })

  it('routes matching top-level cards from any sender into the configured fixed session', async () => {
    const { service, store, transport, startTurn } = harness()
    store.autoRoutes.set('route-1', {
      id: 'route-1', botId: 'bot-1', bindingKey: 'bot-1:auto-route:route-1', chatId: 'oc_1',
      name: '差异播报', enabled: true, sourceSenderId: 'on_alert_bot', sourceSenderType: 'app',
      messageType: 'interactive', cardTitle: '【平台】差异播报', requiredKeywords: ['任务ID', '校验结果'],
      fingerprintKey: 'fingerprint-1', instruction: '分析根因', projectKey: '/repo', projectCwd: '/repo',
      projectName: 'Repo', sessionId: 'thread-1', sessionTitle: 'Alert triage', createdByOpenId: 'ou_user',
      createdAtIso: '', updatedAtIso: '', lastMatchedAtIso: null, matchCount: 0,
    })
    await service.start()
    transport.handlers?.onMessage({
      event_id: 'event-auto-route',
      message: {
        message_id: 'om_alert', chat_id: 'oc_1', chat_type: 'group', message_type: 'interactive',
        content: JSON.stringify({
          header: { title: { tag: 'plain_text', content: '【平台】差异播报' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: '任务ID：T1\n校验结果：不一致' } }],
        }),
        mentions: [],
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', permissionMode: 'yolo',
      prompt: expect.stringContaining('固定处理指令：分析根因'),
    }))
    expect(store.autoRoutes.get('route-1')?.matchCount).toBe(1)
    expect(store.bindings.get('bot-1:auto-route:route-1')).toMatchObject({ threadId: 'thread-1' })

    expect(store.autoRoutes.get('route-1')?.matchCount).toBe(1)

    transport.handlers?.onMessage({
      event_id: 'event-auto-route-self',
      message: {
        message_id: 'om_self', chat_id: 'oc_1', chat_type: 'group', message_type: 'interactive',
        content: JSON.stringify({ header: { title: { content: '【平台】差异播报' } }, elements: [{ tag: 'div', text: { content: '任务ID：T4\n校验结果：不一致' } }] }),
        mentions: [],
      },
      sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(startTurn).toHaveBeenCalledOnce()
    await service.stop()
  })

  it('applies a linked scenario package and its optional primary Skill to an auto-routed card', async () => {
    const primarySkill = {
      name: 'alert-triage', path: '/repo/.codex/skills/alert-triage/SKILL.md',
      displayName: 'Alert triage', description: 'Investigate alert cards.',
    }
    const { service, store, transport, startTurn } = harness(undefined, {
      scenarioPackages: [{
        id: 'scenario-alert', title: '差异告警排障', description: '定位差异告警',
        content: '先核对任务标识，再定位数据源延迟，最后输出根因与行动项。', primarySkill,
      }],
    })
    store.autoRoutes.set('route-scenario', {
      id: 'route-scenario', botId: 'bot-1', bindingKey: 'bot-1:auto-route:route-scenario', chatId: 'oc_1',
      name: '差异播报', enabled: true, sourceSenderId: '*', sourceSenderType: 'app',
      messageType: 'interactive', cardTitle: '【平台】差异播报', requiredKeywords: ['任务ID', '校验结果'],
      fingerprintKey: 'fingerprint-scenario', instruction: '旧的固定指令', scenarioPackageId: 'scenario-alert',
      projectKey: '/repo', projectCwd: '/repo', projectName: 'Repo', sessionId: 'thread-1',
      sessionTitle: 'Alert triage', createdByOpenId: 'ou_user', createdAtIso: '', updatedAtIso: '',
      lastMatchedAtIso: null, matchCount: 0,
    })
    await service.start()
    transport.handlers?.onMessage({
      event_id: 'event-auto-route-scenario',
      message: {
        message_id: 'om_alert_scenario', chat_id: 'oc_1', chat_type: 'group', message_type: 'interactive',
        content: JSON.stringify({
          header: { title: { content: '【平台】差异播报' } },
          elements: [{ tag: 'div', text: { content: '任务ID：T2\n校验结果：不一致' } }],
        }), mentions: [],
      },
      sender: { sender_type: 'app', sender_id: { union_id: 'on_any_alert_bot' } },
    })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      skills: [{ name: primarySkill.name, path: primarySkill.path }],
      prompt: expect.stringMatching(/场景包：差异告警排障[\s\S]*先核对任务标识/u),
    }))
    await service.stop()
  })

  it('does not run a saved card route after its group is removed from the allowlist', async () => {
    const restrictedBot = { ...bot, allowedChatIds: ['oc_allowed'] }
    const { service, store, transport, startTurn } = harness(undefined, { bot: restrictedBot })
    store.autoRoutes.set('route-1', {
      id: 'route-1', botId: 'bot-1', bindingKey: 'bot-1:auto-route:route-1', chatId: 'oc_1',
      name: '差异播报', enabled: true, sourceSenderId: 'on_alert_bot', sourceSenderType: 'app',
      messageType: 'interactive', cardTitle: '【平台】差异播报', requiredKeywords: ['任务ID'],
      fingerprintKey: 'fingerprint-1', instruction: '分析根因', projectKey: '/repo', projectCwd: '/repo',
      projectName: 'Repo', sessionId: 'thread-1', sessionTitle: 'Alert triage', createdByOpenId: 'ou_user',
      createdAtIso: '', updatedAtIso: '', lastMatchedAtIso: null, matchCount: 0,
    })
    await service.start()
    transport.handlers?.onMessage({
      event_id: 'event-disallowed-auto-route',
      message: {
        message_id: 'om_alert', chat_id: 'oc_1', chat_type: 'group', message_type: 'interactive',
        content: JSON.stringify({
          header: { title: { content: '【平台】差异播报' } },
          elements: [{ tag: 'div', text: { content: '任务ID：T1' } }],
        }),
        mentions: [],
      },
      sender: { sender_type: 'app', sender_id: { union_id: 'on_alert_bot' } },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(startTurn).not.toHaveBeenCalled()
    expect(store.autoRoutes.get('route-1')?.matchCount).toBe(0)
    await service.stop()
  })

  it('falls back to chat delivery when a reply source is permanently unavailable', async () => {
    const { service, transport, startTurn } = harness(binding())
    transport.permanentReplyFailure = true
    await service.start()
    transport.handlers?.onMessage(inbound())
    await vi.waitFor(() => expect(transport.cards.some((row) => row.kind === 'send')).toBe(true))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.stop()
  })

  it('keeps a private topic reply in its topic when the immediate source was withdrawn', async () => {
    const topicBinding: FeishuSessionBinding = {
      ...binding(), bindingKey: 'bot-1:p2p:oc_1:om_root', rootId: 'om_root', chatType: 'p2p',
    }
    const { service, transport, startTurn } = harness(topicBinding)
    const replyCard = vi.fn()
      .mockRejectedValueOnce(new FeishuPermanentDeliveryError('230011: message withdrawn', 'outbox-card'))
      .mockResolvedValueOnce('root-card')
    transport.replyCard = replyCard
    await service.start()
    transport.handlers?.onMessage(inbound({
      chat_type: 'p2p', message_id: 'om_child', root_id: 'om_root', thread_id: 'omt_topic',
    }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(replyCard).toHaveBeenNthCalledWith(1, 'om_child', expect.any(Object), true)
    expect(replyCard).toHaveBeenNthCalledWith(2, 'om_root', expect.any(Object), true)
    expect(transport.cards.some((row) => row.kind === 'send')).toBe(false)
    await service.stop()
  })

  it.each([
    ['transient', new Error('temporary network failure')],
    ['permanent non-source', new FeishuPermanentDeliveryError('permission denied', 'outbox-permission')],
  ])('does not fallback for %s reply errors', async (_label, failure) => {
    const { service, transport, startTurn } = harness(binding())
    transport.replyCard = vi.fn(async () => { throw failure })
    await service.start()
    transport.handlers?.onMessage(inbound())
    await new Promise((resolve) => setImmediate(resolve))
    expect(transport.cards.some((row) => row.kind === 'send')).toBe(false)
    expect(startTurn).not.toHaveBeenCalled()
    await service.stop()
  })

  it('routes shared-thread requests to the actual Feishu turn sender, not the binding owner', async () => {
    const sharedBinding = { ...binding(), senderOpenId: 'ou_owner' }
    const { service, transport, startTurn, approvalResolve } = harness(sharedBinding, {
      bot: { ...bot, allowAllUsers: true, allowedOpenIds: [], groupMentionMode: 'always' },
    })
    await service.start()
    const actorMessage = inbound()
    actorMessage.sender = { sender_type: 'user', sender_id: { open_id: 'ou_actor' } }
    transport.handlers?.onMessage(actorMessage)
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    await service.handleApprovalRequest({
      id: 123,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', command: 'npm test' },
    })
    expect(transport.cards.some((row) => row.kind === 'user:ou_actor')).toBe(true)
    const ownerAttempt = await service.handleCardAction('bot-1', {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'private-approval' },
      action: { value: { action: 'cody_feishu_approve', request_id: '123', binding_key: sharedBinding.bindingKey, requester_open_id: 'ou_owner', decision: 'accept', scope: 'single' } },
    })
    expect(JSON.stringify(ownerAttempt)).toContain('只有请求发起者')
    expect(approvalResolve).not.toHaveBeenCalled()
    await service.stop()
  })

  it('completes nonsupport websocket messages through im.message.get before starting Codex', async () => {
    const { service, transport, startTurn } = harness(binding())
    transport.getMessage = vi.fn(async () => ({ data: { items: [{
      message_id: 'om_1', msg_type: 'text', body: { content: JSON.stringify({ text: 'REST recovered content' }) },
    }] } }))
    await service.start()
    transport.handlers?.onMessage(inbound({ message_type: 'nonsupport', content: '{}' }))
    transport.handlers?.onMessage(inbound({ message_type: 'nonsupport', content: '{}' }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'REST recovered content' }))
    expect(transport.getMessage).toHaveBeenCalledWith('om_1', { userCardContent: true })
    expect(transport.getMessage).toHaveBeenCalledTimes(1)
    await service.stop()
  })

  it('downloads resources from a quoted message using the quoted message id', async () => {
    const quotedBinding = binding()
    const { service, transport, startTurn } = harness(quotedBinding)
    transport.getMessage = vi.fn(async (messageId) => ({ data: { items: [{
      message_id: messageId, msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_quote' }) },
    }] } }))
    await service.start()
    transport.handlers?.onMessage(inbound({
      parent_id: 'om_quote', root_id: 'om_root', content: JSON.stringify({ text: '@_user_1 inspect this quote' }),
    }))
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    expect(transport.downloadedResources).toEqual([
      expect.objectContaining({ messageId: 'om_quote', resource: expect.objectContaining({ key: 'img_quote', messageId: 'om_quote' }) }),
    ])
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      localImagePaths: ['/private/feishu/img_quote.jpg'],
      prompt: expect.stringContaining('引用消息'),
    }))
    await service.stop()
  })
})
