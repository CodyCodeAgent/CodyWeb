import * as Lark from '@larksuiteoapi/node-sdk'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  FEISHU_CARD_ACTIONS,
  buildAccessRequestCard,
  buildApprovalCard,
  buildActionResultCard,
  buildAutoRouteCreatedCard,
  buildBotHelpCard,
  buildBoundSessionCard,
  buildProjectSelectionCard,
  buildResolvedAccessRequestCard,
  buildResolvedRequestCard,
  buildSessionSelectionCard,
  buildSessionStatusCard,
  buildStreamingReplyCard,
  buildUserInputCard,
  type FeishuCard,
  type FeishuCardProject,
  type FeishuCardSession,
  type FeishuStreamState,
  type FeishuUserInputQuestion,
} from './feishuCards.js'
import { persistFeishuAttachment, type FeishuDownloadedResource } from './feishuAttachments.js'
import { parseFeishuMessage, type FeishuMessageResource } from './feishuMessageParser.js'
import { resolveFeishuMessage, type FeishuMessageGetOptions, type FeishuResolvedQuote } from './feishuMessageResolver.js'
import {
  buildFeishuAutoRoutePrompt,
  createFeishuAutoRouteDraft,
  matchesFeishuAutoRoute,
  type FeishuAutoRouteDraft,
} from './feishuAutoRoute.js'
import {
  discoverCodexGeneratedReplyImages,
  extractFeishuToolReplyImages,
  feishuReplyImageLimits,
  prepareFeishuReplyMarkdown,
  type FeishuImageUpload,
  type FeishuUploadedReplyImage,
} from './feishuReplyImages.js'
import type { FeishuAutoRoute, FeishuCard as StoredFeishuCard, FeishuTurn as StoredFeishuTurn } from './feishuBotStore.js'
import { FeishuPermanentDeliveryError } from './feishuReliableTransport.js'

export type FeishuRuntimeState = 'connected' | 'connecting' | 'disconnected' | 'error'
export type FeishuTransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export type FeishuBotDefinition = {
  botId: string
  appId: string
  appSecret: string
  platform?: 'feishu' | 'lark'
  enabled: boolean
  allowAllUsers?: boolean
  allowedOpenIds: string[]
  /** Optional group-chat IDs (`oc_...`). Empty means no chat-level restriction. */
  allowedChatIds?: string[]
  groupMentionMode?: 'always' | 'topic' | 'bound'
  /** Private-chat routing: one topic per top-level DM (default), or one flat chat session. */
  p2pMode?: 'topic' | 'chat'
  botOpenId?: string
  botName?: string
}

export type FeishuConversationRoute = {
  bindingKey: string
  chatId: string
  rootId: string
  chatType: 'p2p' | 'group'
  senderOpenId: string
}

export type FeishuPendingInbound = FeishuConversationRoute & {
  botId: string
  messageId: string
  prompt: string
  resources?: FeishuMessageResource[]
  createdAtIso: string
  autoRouteDraft?: FeishuAutoRouteDraft
  sessionSelection?: {
    action: 'new_session' | 'select_session'
    projectKey: string
    knownThreadIds: string[]
    startedAtIso: string
    createdThreadId?: string
    createdThreadTitle?: string
  }
}

export type FeishuSessionBinding = FeishuConversationRoute & {
  botId: string
  projectKey: string
  projectLabel: string
  cwd: string
  threadId: string
  threadTitle: string
  collaborationMode?: 'default' | 'plan'
  permissionMode?: 'normal' | 'yolo'
}

export type FeishuRuntimeUpdate = {
  state: FeishuRuntimeState
  connectionState: FeishuTransportState
  lastError?: string
  connectedAtIso?: string | null
  botOpenId?: string
  botName?: string
}

export interface FeishuBotStorePort {
  listBots(): Promise<FeishuBotDefinition[]>
  updateRuntime(botId: string, update: FeishuRuntimeUpdate): Promise<void>
  claimEvent(botId: string, eventKey: string): Promise<boolean>
  completeEvent?(botId: string, eventKey: string): Promise<void>
  failEvent?(botId: string, eventKey: string, error: string): Promise<void>
  findBinding(botId: string, bindingKey: string): Promise<FeishuSessionBinding | null>
  listBindings(botId?: string): Promise<FeishuSessionBinding[]>
  upsertBinding(binding: FeishuSessionBinding): Promise<void>
  touchBinding(botId: string, bindingKey: string): Promise<void>
  deleteBinding(botId: string, bindingKey: string): Promise<void>
  savePendingMessage(message: FeishuPendingInbound): Promise<void>
  peekPendingMessage(botId: string, bindingKey: string): Promise<FeishuPendingInbound | null>
  deletePendingMessage(botId: string, messageId: string): Promise<void>
  claimPendingMessage(botId: string, bindingKey: string, claimToken: string): Promise<FeishuPendingInbound | null>
  releasePendingMessageClaim(botId: string, claimToken: string): Promise<void>
  listAutoRoutes?(input: { botId?: string; chatId?: string; enabled?: boolean }): Promise<FeishuAutoRoute[]>
  upsertAutoRoute?(input: {
    botId: string; chatId: string; name: string; sourceSenderId: string; sourceSenderType: 'app' | 'bot'
    cardTitle: string; requiredKeywords: string[]; fingerprintKey: string; instruction: string
    projectKey: string; projectCwd: string; projectName: string; sessionId: string; sessionTitle: string
    createdByOpenId: string
  }): Promise<FeishuAutoRoute>
  touchAutoRoute?(id: string): Promise<void>
  updateAutoRouteDefinition?(input: {
    id: string; requiredKeywords: string[]; instruction: string
  }): Promise<FeishuAutoRoute | null>
}

export interface FeishuCatalogPort {
  listProjects(): Promise<Array<FeishuCardProject & { sessions: FeishuCardSession[] }>>
  startSession(input: { cwd: string; projectKey: string }): Promise<{ threadId: string; title: string }>
  renameSession?(input: { threadId: string; title: string }): Promise<void>
  archiveSession?(input: { threadId: string }): Promise<void>
}

export interface FeishuTurnPort {
  startTurn(input: {
    threadId: string
    prompt: string
    localImagePaths?: string[]
    source: 'feishu'
    metadata: Record<string, string>
    collaborationMode?: 'default' | 'plan'
    permissionMode?: 'normal' | 'yolo'
  }): Promise<{ turnId: string }>
  stopTurn?(input: { threadId: string; turnId?: string }): Promise<void>
  isThreadBusy?(threadId: string): Promise<boolean>
  findActiveTurnId?(threadId: string): Promise<string | null>
  readTurnState?(threadId: string, turnId: string): Promise<{
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'missing'
    responseText?: string
    error?: string
  }>
}

export type FeishuAppServerNotification = { method: string; params?: unknown }
export type FeishuAppServerRequest = { id: string | number; method: string; params?: unknown }

export interface FeishuNotificationPort {
  subscribe(listener: (notification: FeishuAppServerNotification) => void): () => void
}

export interface FeishuApprovalPort {
  resolve(input: { requestId: string; decision: string; scope: string }): Promise<void>
}

export interface FeishuServerRequestPort {
  isPending?(requestId: string): Promise<boolean>
  respond(input: {
    requestId: string
    result?: unknown
    approvalScope?: string
    error?: { code?: number; message: string }
  }): Promise<void>
}

export interface FeishuAccessPort {
  /** Persist one exact user grant. Broad access must never be enabled here. */
  grantUser(input: { botId: string; openId: string }): Promise<void>
}

export interface FeishuLifecyclePort {
  createTurn(input: {
    botId: string; bindingKey: string; inboundMessageId: string; sessionId: string
    prompt: string; status: 'queued' | 'running'
  }): Promise<StoredFeishuTurn>
  updateTurn(id: string, patch: Partial<Pick<StoredFeishuTurn,
    'turnId' | 'status' | 'responseText' | 'cardId' | 'lastError' | 'completedAtIso'
  >>): Promise<StoredFeishuTurn | null>
  listTurns(input: { botId?: string; sessionId?: string; bindingKey?: string; limit?: number }): Promise<StoredFeishuTurn[]>
  upsertCard(input: {
    id: string; botId: string; bindingKey: string; messageId?: string | null
    purpose: string; status: StoredFeishuCard['status']; version: number; state: unknown
  }): Promise<StoredFeishuCard>
  findCard(id: string): Promise<StoredFeishuCard | null>
  listCards(input: { botId?: string; bindingKey?: string; limit?: number }): Promise<StoredFeishuCard[]>
}

export type FeishuTransportHandlers = {
  onMessage: (payload: unknown) => void
  onCardAction: (payload: unknown) => Promise<unknown>
  onState: (state: FeishuTransportState, error?: Error) => void
}

export interface FeishuTransport {
  getBotIdentity?(): Promise<{ openId: string; name: string }>
  getChatMode?(chatId: string, options?: { forceRefresh?: boolean }): Promise<'group' | 'topic' | 'p2p'>
  getMessage?(messageId: string, options?: FeishuMessageGetOptions): Promise<unknown>
  withDeliveryScope?<T>(stableKey: string, work: () => Promise<T>): Promise<T>
  start(handlers: FeishuTransportHandlers): Promise<void>
  close(): void
  getState(): FeishuTransportState
  sendText(chatId: string, text: string, providerUuid?: string): Promise<string>
  replyText(messageId: string, text: string, replyInThread?: boolean, providerUuid?: string): Promise<string>
  sendCard(chatId: string, card: FeishuCard, providerUuid?: string): Promise<string>
  sendUserCard?(openId: string, card: FeishuCard, providerUuid?: string): Promise<string>
  replyCard(messageId: string, card: FeishuCard, replyInThread?: boolean, providerUuid?: string): Promise<string>
  updateCard(messageId: string, card: FeishuCard, delivery?: { version?: number; terminal?: boolean }): Promise<void>
  downloadResource?(messageId: string, resource: FeishuMessageResource): Promise<FeishuDownloadedResource>
  uploadImage?(image: FeishuImageUpload): Promise<string>
}

export type FeishuBotRuntimeSnapshot = {
  botId: string
  appId: string
  botName: string
  state: FeishuRuntimeState
  connectionState: FeishuTransportState
  connectedAtIso: string | null
  lastError: string
}

export type FeishuConnectivityCheckId =
  | 'configuration'
  | 'enabled'
  | 'runtime'
  | 'long_connection'
  | 'credential_api'
  | 'bot_identity'

export type FeishuConnectivityReport = {
  botId: string
  ok: boolean
  generatedAtIso: string
  latencyMs: number
  checks: Array<{
    id: FeishuConnectivityCheckId
    status: 'pass' | 'fail'
    message: string
  }>
}

export type FeishuBotServiceDependencies = {
  store: FeishuBotStorePort
  catalog: FeishuCatalogPort
  turns: FeishuTurnPort
  notifications?: FeishuNotificationPort
  approvals?: FeishuApprovalPort
  access?: FeishuAccessPort
  serverRequests?: FeishuServerRequestPort
  autoRouteAnalyzer?: {
    analyze(input: {
      cwd: string; cardTitle: string; cardText: string; candidateKeywords: string[]; requestedInstruction: string
    }): Promise<{ requiredKeywords: string[]; instruction: string; reason: string }>
  }
  lifecycle?: FeishuLifecyclePort
  transportFactory?: (bot: FeishuBotDefinition) => FeishuTransport
  webThreadUrl?: (threadId: string) => string
  logger?: Pick<Console, 'info' | 'warn' | 'error' | 'debug'>
  schedule?: (work: () => void) => void
  now?: () => Date
  reconnectCheckMs?: number
  streamPatchMs?: number
  diagnosticTimeoutMs?: number
}

type Runtime = {
  bot: FeishuBotDefinition
  fingerprint: string
  transport: FeishuTransport
  snapshot: FeishuBotRuntimeSnapshot
}

type ActiveTurnCard = {
  botId: string
  binding: FeishuSessionBinding
  messageId: string
  turnId: string
  content: string
  state: FeishuStreamState
  error: string
  patchTimer: ReturnType<typeof setTimeout> | null
  sourceMessageId: string
  resources: FeishuMessageResource[]
  requesterOpenId: string
  startedAtIso: string
  durableTurnId?: string
  durableCardId?: string
  cardVersion: number
  stopRequested: boolean
  preparedContent: string
  replyImages: FeishuUploadedReplyImage[]
  replyImageFingerprints: Set<string>
  replyImageUploads: Promise<void>[]
  replyPreparation: Promise<void> | null
  replyImageFailures: string[]
}

type QueuedTurnCard = {
  active: ActiveTurnCard
  prompt: string
  sourceMessageId: string
  resources: FeishuMessageResource[]
}

type NormalizedInbound = FeishuConversationRoute & {
  botId: string
  messageId: string
  prompt: string
  resources: FeishuMessageResource[]
  explicitlyMentioned: boolean
  hasNonBotMention: boolean
  senderType: string
  senderId: string
  messageType: string
  eventKey: string
  topLevel: boolean
  autoRouteDraft?: FeishuAutoRouteDraft
}

type PendingRequestCard = {
  requestId: string
  botId: string
  binding: FeishuSessionBinding
  messageId: string
  requesterOpenId: string
  kind: 'approval' | 'user_input'
  title: string
  summary: string
  questions: FeishuUserInputQuestion[]
  selections: Record<string, string>
}

type DurableTurnCardState = {
  kind: 'turn'
  binding: FeishuSessionBinding
  sourceMessageId: string
  resources: FeishuMessageResource[]
  streamState: FeishuStreamState
  content: string
  preparedContent?: string
  replyImages?: FeishuUploadedReplyImage[]
  replyImageFailures?: string[]
  error: string
  requesterOpenId?: string
  startedAtIso?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[key])
}

function transportStateToRuntime(state: FeishuTransportState): FeishuRuntimeState {
  if (state === 'connected') return 'connected'
  if (state === 'connecting' || state === 'reconnecting') return 'connecting'
  if (state === 'failed') return 'error'
  return 'disconnected'
}

function botFingerprint(bot: FeishuBotDefinition): string {
  return JSON.stringify([
    bot.appId,
    bot.appSecret,
    bot.platform ?? 'feishu',
    bot.enabled,
    bot.allowAllUsers,
    bot.allowedOpenIds.slice().sort(),
    (bot.allowedChatIds ?? []).slice().sort(),
    bot.groupMentionMode ?? 'always',
    bot.p2pMode ?? 'topic',
  ])
}

function messageBindingKey(botId: string, chatId: string, chatType: 'p2p' | 'group', rootId: string): string {
  return `${botId}:${chatType}:${chatId}:${rootId || 'chat'}`
}

/** Normalizes Feishu text/mentions and computes a stable p2p/group/topic binding key. */
export function normalizeFeishuInbound(bot: FeishuBotDefinition, payload: unknown): NormalizedInbound | null {
  const envelope = asRecord(payload)
  const event = asRecord(envelope?.event) ?? envelope
  const message = asRecord(event?.message)
  const sender = asRecord(event?.sender)
  if (!message || !sender) return null
  const messageId = readString(message.message_id || message.messageId)
  const chatId = readString(message.chat_id || message.chatId)
  if (!messageId || !chatId) return null
  const chatType: 'p2p' | 'group' = readString(message.chat_type || message.chatType) === 'p2p' ? 'p2p' : 'group'
  const senderId = asRecord(sender.sender_id || sender.senderId)
  const senderOpenId = readString(senderId?.open_id || senderId?.openId)
  const stableSenderId = readString(senderId?.union_id || senderId?.unionId)
    || senderOpenId
    || readString(senderId?.app_id || senderId?.appId || senderId?.user_id || senderId?.userId)
  const senderType = readString(sender.sender_type || sender.senderType)
  const parsedMessage = parseFeishuMessage({
    messageType: message.message_type || message.messageType || message.msg_type,
    content: message.content,
    mentions: message.mentions,
    messageId,
    parentId: message.parent_id || message.parentId,
    rootId: message.root_id || message.rootId,
    threadId: message.thread_id || message.threadId,
  }, { botOpenId: bot.botOpenId, botAppId: bot.appId })
  const prompt = parsedMessage.text
  const downloadUnsupportedReason = parsedMessage.messageType === 'interactive'
    ? '飞书 API 不支持下载卡片消息中的资源（234043）'
    : ''
  const resources = parsedMessage.resources.map((resource) => downloadUnsupportedReason
    ? { ...resource, downloadUnsupportedReason }
    : resource)
  const rawRootId = readString(message.root_id || message.rootId)
  const rawThreadId = readString(message.thread_id || message.threadId)
  // Feishu ordinary replies may expose root_id without actually being inside
  // a topic. Only the root_id + thread_id pair is a reliable topic signal.
  const isThreadReply = Boolean(rawRootId && rawThreadId)
  const rootId = chatType === 'p2p'
    ? (bot.p2pMode === 'chat' ? '' : isThreadReply ? rawRootId : messageId)
    : isThreadReply ? rawRootId : ''
  const anchor = rootId || (chatType === 'group' ? chatId : '')
  const eventId = readString(envelope?.event_id || envelope?.eventId || nestedRecord(envelope, 'header')?.event_id)
  const hasNonBotMention = parsedMessage.mentions.some((mention) => {
    const isOwnBot = (Boolean(bot.botOpenId) && mention.openId === bot.botOpenId)
      || (Boolean(bot.appId) && mention.appId === bot.appId)
    return !isOwnBot && Boolean(mention.openId || mention.userId || mention.unionId || mention.appId)
  })
  return {
    botId: bot.botId,
    bindingKey: messageBindingKey(bot.botId, chatId, chatType, anchor),
    chatId,
    // Keep the real Feishu reply root separate from the binding anchor. A flat
    // group binds at chatId but must NOT set reply_in_thread on outbound replies.
    rootId,
    chatType,
    senderOpenId,
    senderId: stableSenderId,
    messageType: parsedMessage.messageType,
    messageId,
    prompt,
    resources,
    explicitlyMentioned: parsedMessage.explicitlyMentioned,
    hasNonBotMention,
    senderType,
    eventKey: eventId || messageId,
    topLevel: chatType === 'group' ? !rootId : !isThreadReply,
  }
}

function actionData(payload: unknown): {
  value: Record<string, unknown>
  option: string
  operatorOpenId: string
  openMessageId: string
  eventId: string
} {
  const body = asRecord(payload)
  const action = asRecord(body?.action)
  let value = asRecord(action?.value) ?? {}
  if (typeof action?.value === 'string') {
    try { value = asRecord(JSON.parse(action.value)) ?? {} } catch { value = {} }
  }
  return {
    value,
    option: readString(action?.option || action?.selected_option || value.option),
    operatorOpenId: readString(nestedRecord(body?.operator, 'operator_id')?.open_id || nestedRecord(body, 'operator')?.open_id),
    openMessageId: readString(nestedRecord(body, 'context')?.open_message_id || body?.open_message_id),
    eventId: readString(body?.event_id || nestedRecord(body, 'header')?.event_id),
  }
}

function rawCardResponse(card: FeishuCard): Record<string, unknown> {
  return { card: { type: 'raw', data: card } }
}

const ACCESS_REQUEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

type SignedAccessRequest = {
  v: 1
  botId: string
  requesterOpenId: string
  chatId: string
  eventKey: string
  createdAtMs: number
}

function signAccessRequest(bot: FeishuBotDefinition, inbound: NormalizedInbound, createdAtMs: number): string {
  const payload: SignedAccessRequest = {
    v: 1,
    botId: bot.botId,
    requesterOpenId: inbound.senderOpenId,
    chatId: inbound.chatId,
    eventKey: inbound.eventKey,
    createdAtMs,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', bot.appSecret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyAccessRequestToken(bot: FeishuBotDefinition, token: string, nowMs: number): SignedAccessRequest | null {
  const [encoded, suppliedSignature, extra] = token.split('.')
  if (!encoded || !suppliedSignature || extra) return null
  const expectedSignature = createHmac('sha256', bot.appSecret).update(encoded).digest('base64url')
  const supplied = Buffer.from(suppliedSignature)
  const expected = Buffer.from(expectedSignature)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SignedAccessRequest>
    if (value.v !== 1 || value.botId !== bot.botId || !/^ou_[A-Za-z0-9_-]+$/u.test(value.requesterOpenId ?? '')) return null
    if (typeof value.chatId !== 'string' || typeof value.eventKey !== 'string' || typeof value.createdAtMs !== 'number') return null
    if (value.createdAtMs > nowMs + 60_000 || nowMs - value.createdAtMs > ACCESS_REQUEST_MAX_AGE_MS) return null
    return value as SignedAccessRequest
  } catch {
    return null
  }
}

function notificationIds(notification: FeishuAppServerNotification): { threadId: string; turnId: string } {
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  return {
    threadId: readString(params?.threadId || params?.thread_id || turn?.threadId || turn?.thread_id),
    turnId: readString(params?.turnId || params?.turn_id || turn?.id),
  }
}

function notificationDelta(notification: FeishuAppServerNotification): { delta: string; completedText: string } {
  const params = asRecord(notification.params)
  const item = asRecord(params?.item)
  if (notification.method === 'item/agentMessage/delta') {
    return { delta: readString(params?.delta || item?.delta || params?.text), completedText: '' }
  }
  if (notification.method === 'item/completed' && readString(item?.type) === 'agentMessage') {
    return { delta: '', completedText: readString(item?.text || item?.content) }
  }
  return { delta: '', completedText: '' }
}

function turnError(notification: FeishuAppServerNotification): string {
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  const error = asRecord(turn?.error || params?.error)
  return readString(error?.message || turn?.error || params?.error || params?.message)
}

function requestKey(botId: string, requestId: string): string {
  return `${botId}:${requestId}`
}

function normalizeUserInputQuestions(params: unknown): FeishuUserInputQuestion[] {
  const rows = asRecord(params)?.questions
  if (!Array.isArray(rows)) return []
  return rows.flatMap((value) => {
    const row = asRecord(value)
    const id = readString(row?.id).trim()
    if (!id) return []
    const options = Array.isArray(row?.options)
      ? row.options.flatMap((optionValue) => {
        const option = asRecord(optionValue)
        const label = readString(option?.label).trim()
        return label ? [{ label, description: readString(option?.description).trim() }] : []
      })
      : []
    return [{
      id,
      header: readString(row?.header).trim(),
      question: readString(row?.question).trim(),
      isOther: row?.isOther === true,
      isSecret: row?.isSecret === true,
      options,
    }]
  })
}

function redactFeishuText(value: string, exactSecrets: string[] = []): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/(["']?(?:authorization|app[_-]?secret|client_secret|tenant_access_token|app_access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s,"'};]+/giu, '$1[REDACTED]')
  for (const secret of exactSecrets.filter(Boolean)) redacted = redacted.split(secret).join('[REDACTED]')
  return redacted.slice(0, 1_000)
}

/** Safe SDK error summary: deliberately ignores Axios config, headers and request bodies. */
export function formatFeishuSdkError(value: unknown, exactSecrets: string[] = []): string {
  if (typeof value === 'string') return redactFeishuText(value, exactSecrets)
  const row = asRecord(value)
  const response = asRecord(row?.response)
  const data = asRecord(response?.data)
  const rawCode = data?.code ?? row?.code
  const rawStatus = response?.status ?? row?.status
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : ''
  const status = typeof rawStatus === 'string' || typeof rawStatus === 'number' ? String(rawStatus) : ''
  const message = redactFeishuText(readString(data?.msg ?? data?.message ?? row?.message) || 'Feishu SDK error', exactSecrets)
  return [code && `code=${code}`, status && `status=${status}`, `message=${message}`].filter(Boolean).join(' ')
}

function createRedactingLarkLogger(exactSecrets: string[]) {
  const format = (values: unknown[]) => values.map((value) => formatFeishuSdkError(value, exactSecrets)).join(' ')
  return {
    error: (...values: unknown[]) => console.error('[feishu-sdk]', format(values)),
    warn: (...values: unknown[]) => console.warn('[feishu-sdk]', format(values)),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  }
}

export class LarkSdkTransport implements FeishuTransport {
  private readonly client: Lark.Client
  private readonly sdkLogger: ReturnType<typeof createRedactingLarkLogger>
  private ws: Lark.WSClient | null = null
  private state: FeishuTransportState = 'idle'
  private readonly chatModeCache = new Map<string, { mode: 'group' | 'topic' | 'p2p'; expiresAt: number }>()

  constructor(private readonly bot: FeishuBotDefinition) {
    this.sdkLogger = createRedactingLarkLogger([bot.appSecret])
    this.client = new Lark.Client({
      appId: bot.appId,
      appSecret: bot.appSecret,
      domain: bot.platform === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      logger: this.sdkLogger,
    })
  }

  async getBotIdentity(): Promise<{ openId: string; name: string }> {
    const response = await this.client.request<{ code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info/',
    })
    if (response.code !== 0) throw new Error(`Feishu bot identity failed: ${response.msg} (${response.code})`)
    const openId = response.bot?.open_id?.trim() ?? ''
    if (!openId) throw new Error('Feishu bot identity did not include open_id')
    return { openId, name: response.bot?.app_name?.trim() ?? '' }
  }

  async getChatMode(chatId: string, options?: { forceRefresh?: boolean }): Promise<'group' | 'topic' | 'p2p'> {
    const cached = this.chatModeCache.get(chatId)
    if (!options?.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.mode
    const response = await this.client.request<{
      code?: number
      msg?: string
      data?: { chat_mode?: string; group_message_type?: string }
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    })
    if (response.code !== 0) throw new Error(`Feishu chat lookup failed: ${response.msg} (${response.code})`)
    const rawMode = response.data?.chat_mode?.toLowerCase()
    const groupMessageType = response.data?.group_message_type?.toLowerCase()
    const mode = rawMode === 'p2p' ? 'p2p' : rawMode === 'topic' || groupMessageType === 'thread' ? 'topic' : 'group'
    this.chatModeCache.set(chatId, { mode, expiresAt: Date.now() + 5 * 60_000 })
    while (this.chatModeCache.size > 1_000) {
      const oldest = this.chatModeCache.keys().next().value as string | undefined
      if (!oldest) break
      this.chatModeCache.delete(oldest)
    }
    return mode
  }

  async getMessage(messageId: string, options: FeishuMessageGetOptions = {}): Promise<unknown> {
    const response = await this.client.request<{ code?: number; msg?: string; data?: unknown }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      params: {
        // Persist a tenant-stable foreign-bot identity when a quoted card is
        // converted into an auto route. Default open_id values are scoped to
        // this app and are not a sound cross-application routing key.
        user_id_type: 'union_id',
        ...(options.userCardContent ? { card_msg_content_type: 'user_card_content' } : {}),
        with_sender_name: 'true',
      },
    })
    if (response.code !== 0) throw new Error(`Feishu message lookup failed: ${response.msg} (${response.code})`)
    return response.data
  }

  async start(handlers: FeishuTransportHandlers): Promise<void> {
    this.state = 'connecting'
    handlers.onState(this.state)
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => { handlers.onMessage(data) },
      'card.action.trigger': (data: unknown) => handlers.onCardAction(data),
    } as never)
    this.ws = new Lark.WSClient({
      appId: this.bot.appId,
      appSecret: this.bot.appSecret,
      domain: this.bot.platform === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      logger: this.sdkLogger,
      loggerLevel: Lark.LoggerLevel.warn,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
      onReady: () => { this.state = 'connected'; handlers.onState(this.state) },
      onReconnecting: () => { this.state = 'reconnecting'; handlers.onState(this.state) },
      onReconnected: () => { this.state = 'connected'; handlers.onState(this.state) },
      onError: (error) => { this.state = 'failed'; handlers.onState(this.state, error) },
    })
    await this.ws.start({ eventDispatcher: dispatcher })
  }

  close(): void {
    this.ws?.close({ force: true })
    this.ws = null
    this.state = 'idle'
  }

  getState(): FeishuTransportState { return this.ws?.getConnectionStatus().state ?? this.state }

  async sendText(chatId: string, text: string, providerUuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), ...(providerUuid ? { uuid: providerUuid } : {}) },
    })
    return this.readMessageId(response)
  }

  async replyText(messageId: string, text: string, replyInThread = false, providerUuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }), ...(replyInThread ? { reply_in_thread: true } : {}), ...(providerUuid ? { uuid: providerUuid } : {}) },
    })
    return this.readMessageId(response)
  }

  async sendCard(chatId: string, card: FeishuCard, providerUuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), ...(providerUuid ? { uuid: providerUuid } : {}) },
    })
    return this.readMessageId(response)
  }

  async sendUserCard(openId: string, card: FeishuCard, providerUuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card), ...(providerUuid ? { uuid: providerUuid } : {}) },
    })
    return this.readMessageId(response)
  }

  async replyCard(messageId: string, card: FeishuCard, replyInThread = false, providerUuid?: string): Promise<string> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), ...(replyInThread ? { reply_in_thread: true } : {}), ...(providerUuid ? { uuid: providerUuid } : {}) },
    })
    return this.readMessageId(response)
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    const response = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
    if (response.code !== 0) throw new Error(`Feishu card patch failed: ${response.msg} (${response.code})`)
  }

  async uploadImage(image: FeishuImageUpload): Promise<string> {
    const response = await this.client.im.v1.image.create({
      data: { image_type: 'message', image: image.buffer },
    })
    const imageKey = response?.image_key?.trim() ?? ''
    if (!imageKey) throw new Error('Feishu image upload did not include image_key')
    return imageKey
  }

  async downloadResource(messageId: string, resource: FeishuMessageResource): Promise<FeishuDownloadedResource> {
    if (resource.downloadUnsupportedReason) throw new Error(resource.downloadUnsupportedReason)
    if (resource.type === 'sticker') {
      throw new Error('Feishu does not support downloading sticker resources')
    }
    const resourceMessageId = resource.messageId?.trim() || messageId
    // Use the SDK's generic request path here. Some SDK releases attach an
    // empty body in generated GET calls, which Feishu's resource gateway can
    // reject with HTTP 411. The explicit request still uses the SDK's token
    // handling while returning a backpressure-aware stream.
    const response = await this.client.request<Readable & { headers?: unknown }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(resourceMessageId)}/resources/${encodeURIComponent(resource.key)}`,
      params: { type: resource.type === 'image' ? 'image' : 'file' },
      responseType: 'stream',
    })
    return persistFeishuAttachment({
      botId: this.bot.botId,
      messageId: resourceMessageId,
      resource,
      stream: response,
      headers: response.headers,
    })
  }

  private readMessageId(response: { code?: number; msg?: string; data?: { message_id?: string } | null }): string {
    if (response.code !== 0) throw new Error(`Feishu message failed: ${response.msg} (${response.code})`)
    const messageId = response.data?.message_id
    if (!messageId) throw new Error('Feishu response did not include message_id')
    return messageId
  }
}

export class FeishuBotService {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly activeTurnsByThread = new Map<string, ActiveTurnCard>()
  private readonly queuedTurnsByThread = new Map<string, QueuedTurnCard[]>()
  private readonly externalBusyThreads = new Set<string>()
  private readonly messageQueues = new Map<string, Promise<void>>()
  private readonly pendingRequestCards = new Map<string, PendingRequestCard>()
  private readonly serverRequestPresentations = new Map<string, Promise<void>>()
  private readonly inFlightCardActions = new Map<string, Promise<void>>()
  private readonly inFlightAccessActions = new Map<string, Promise<FeishuCard>>()
  private readonly completedCardActions = new Map<string, { completedAt: number; card: FeishuCard }>()
  private unsubscribeNotifications: (() => void) | null = null
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private stopped = true

  constructor(private readonly dependencies: FeishuBotServiceDependencies) {}

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    if (this.dependencies.notifications) {
      this.unsubscribeNotifications = this.dependencies.notifications.subscribe((notification) => {
        this.handleAppServerNotification(notification)
      })
    }
    await this.reconcile()
    await this.restoreDurableLifecycle()
    await this.restorePendingDeliveries()
    await this.restoreDurableRequests()
    this.reconnectTimer = setInterval(() => {
      void this.reviveFailedConnections()
    }, this.dependencies.reconnectCheckMs ?? 60_000)
    this.reconnectTimer.unref?.()
  }

  async reconcile(botId?: string): Promise<void> {
    const bots = await this.dependencies.store.listBots()
    const desired = new Map(bots.filter((bot) => !botId || bot.botId === botId).map((bot) => [bot.botId, bot]))
    for (const [id, runtime] of this.runtimes) {
      if ((botId && id !== botId) || desired.has(id)) continue
      runtime.transport.close()
      this.runtimes.delete(id)
    }
    for (const bot of desired.values()) {
      const existing = this.runtimes.get(bot.botId)
      if (!bot.enabled || !bot.appId.trim() || !bot.appSecret.trim()) {
        if (existing) { existing.transport.close(); this.runtimes.delete(bot.botId) }
        await this.dependencies.store.updateRuntime(bot.botId, {
          state: 'disconnected', connectionState: 'idle', lastError: '', connectedAtIso: null,
        })
        continue
      }
      const fingerprint = botFingerprint(bot)
      if (existing?.fingerprint === fingerprint) continue
      existing?.transport.close()
      await this.connectBot(bot, fingerprint)
    }
  }

  /** Force a fresh long connection even when the stored bot fingerprint is unchanged. */
  async reconnect(botId: string): Promise<void> {
    const existing = this.runtimes.get(botId)
    if (existing) {
      existing.transport.close()
      this.runtimes.delete(botId)
    }
    await this.reconcile(botId)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribeNotifications?.()
    this.unsubscribeNotifications = null
    if (this.reconnectTimer) clearInterval(this.reconnectTimer)
    this.reconnectTimer = null
    for (const runtime of this.runtimes.values()) runtime.transport.close()
    // A transport callback can still be finishing after the long connection is
    // closed. Drain those per-binding handlers before clearing recovered state,
    // otherwise an old service instance may write into the same SQLite rows
    // after a replacement instance has already restored them.
    const pendingMessages = Array.from(this.messageQueues.values())
    if (pendingMessages.length > 0) await Promise.allSettled(pendingMessages)
    this.messageQueues.clear()
    this.runtimes.clear()
    for (const active of this.activeTurnsByThread.values()) if (active.patchTimer) clearTimeout(active.patchTimer)
    this.activeTurnsByThread.clear()
    this.queuedTurnsByThread.clear()
    this.externalBusyThreads.clear()
    this.pendingRequestCards.clear()
    this.serverRequestPresentations.clear()
    this.inFlightCardActions.clear()
    this.inFlightAccessActions.clear()
    this.completedCardActions.clear()
  }

  getRuntimeSnapshots(): FeishuBotRuntimeSnapshot[] {
    return Array.from(this.runtimes.values(), ({ snapshot }) => ({ ...snapshot }))
  }

  /**
   * Run a live probe without sending a chat message or changing remote state.
   * The bot identity request proves that the
   * current App ID/Secret can obtain a tenant credential and call Feishu, while
   * the transport state independently proves that the event long connection is
   * currently established. No token, secret, or Open ID is returned. A fully
   * successful probe refreshes the local heartbeat timestamp.
   */
  async diagnose(botId: string): Promise<FeishuConnectivityReport> {
    const startedAt = Date.now()
    const checks: FeishuConnectivityReport['checks'] = []
    let liveIdentity: { openId: string; name: string } | null = null
    const configured = (await this.dependencies.store.listBots()).find((value) => value.botId === botId)
    const add = (id: FeishuConnectivityCheckId, passed: boolean, message: string) => {
      checks.push({ id, status: passed ? 'pass' : 'fail', message })
    }

    const hasConfiguration = Boolean(configured?.appId.trim() && configured.appSecret.trim())
    add('configuration', hasConfiguration, hasConfiguration
      ? 'App ID and encrypted App Secret are configured.'
      : configured ? 'App ID or App Secret is missing.' : 'Bot configuration was not found.')
    add('enabled', configured?.enabled === true, configured?.enabled
      ? 'The bot is enabled in CodyWeb.'
      : 'The bot is disabled in CodyWeb.')

    const runtime = this.runtimes.get(botId)
    add('runtime', Boolean(runtime), runtime
      ? 'The in-process bot runtime exists.'
      : 'The in-process bot runtime is not running.')
    const transportState = runtime?.transport.getState()
    const longConnectionReady = transportState === 'connected' && runtime?.snapshot.connectionState === 'connected'
    add('long_connection', longConnectionReady, longConnectionReady
      ? 'The Feishu event long connection reports connected.'
      : `The Feishu event long connection is ${transportState ?? 'unavailable'}.`)

    if (!runtime?.transport.getBotIdentity) {
      add('credential_api', false, 'The active runtime cannot perform a credential API probe.')
      add('bot_identity', false, 'The bot identity could not be verified.')
    } else {
      try {
        const identity = await promiseWithTimeout(
          runtime.transport.getBotIdentity(),
          this.dependencies.diagnosticTimeoutMs ?? 10_000,
          'Feishu identity probe timed out.',
        )
        liveIdentity = identity
        add('credential_api', true, 'Feishu accepted the current credentials and returned the bot identity API response.')
        const expectedOpenId = configured?.botOpenId?.trim() || runtime.bot.botOpenId?.trim() || ''
        const identityMatches = Boolean(identity.openId.trim()) && (!expectedOpenId || expectedOpenId === identity.openId.trim())
        add('bot_identity', identityMatches, identityMatches
          ? 'The live bot identity is present and matches the persisted identity.'
          : 'The live bot identity does not match the persisted identity.')
      } catch (error) {
        const message = redactFeishuText(error instanceof Error ? error.message : String(error), [runtime.bot.appSecret])
        add('credential_api', false, `Feishu rejected or could not complete the credential probe: ${message}`)
        add('bot_identity', false, 'The bot identity could not be verified.')
      }
    }

    const report: FeishuConnectivityReport = {
      botId,
      ok: checks.every((check) => check.status === 'pass'),
      generatedAtIso: this.now().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      checks,
    }
    if (report.ok && runtime && liveIdentity) {
      await this.dependencies.store.updateRuntime(botId, {
        state: 'connected',
        connectionState: 'connected',
        lastError: '',
        connectedAtIso: runtime.snapshot.connectedAtIso,
        botOpenId: liveIdentity.openId,
        botName: liveIdentity.name,
      }).catch((error) => this.log('error', `Failed to persist Feishu diagnostic heartbeat: ${String(error)}`))
    }
    return report
  }

  handleAppServerNotification(notification: FeishuAppServerNotification): void {
    if (notification.method === 'server/request') {
      const row = asRecord(notification.params)
      const id = row?.id
      const method = readString(row?.method)
      if ((typeof id === 'number' || typeof id === 'string') && method) {
        void this.handleServerRequest({ id, method, params: row?.params }).catch((error) => {
          this.log('error', `[feishu] failed to present Codex server request ${String(id)} (${method}): ${String(error)}`)
        })
      }
      return
    }
    if (notification.method === 'server/request/resolved') {
      const params = asRecord(notification.params)
      const rawId = params?.id ?? params?.requestId ?? params?.request_id
      if (typeof rawId === 'number' || typeof rawId === 'string') {
        void this.freezeExternallyResolvedRequest(String(rawId)).catch((error) => {
          this.log('error', `[feishu] failed to freeze resolved Codex server request ${String(rawId)}: ${String(error)}`)
        })
      }
      return
    }
    const { threadId, turnId } = notificationIds(notification)
    if (!threadId) return
    const active = this.activeTurnsByThread.get(threadId)
    const belongsToActive = Boolean(active && (!turnId || !active.turnId || turnId === active.turnId))
    if (notification.method === 'turn/started' && !belongsToActive) {
      this.externalBusyThreads.add(threadId)
      return
    }
    if (!belongsToActive) {
      if (['turn/completed', 'turn/failed', 'turn/interrupted'].includes(notification.method)) {
        this.externalBusyThreads.delete(threadId)
        void this.startNextQueuedTurn(threadId)
      }
      return
    }
    if (!active) return
    this.captureToolReplyImages(active, notification)
    if (notification.method === 'turn/started') {
      if (turnId && !active.turnId) active.turnId = turnId
      if (!active.stopRequested) active.state = 'running'
      return
    }
    const { delta, completedText } = notificationDelta(notification)
    if (completedText) { active.content = completedText; active.preparedContent = '' }
    else if (delta) { active.content += delta; active.preparedContent = '' }
    if (notification.method === 'turn/completed') {
      const error = turnError(notification)
      active.error = error
      active.state = active.stopRequested ? 'stopped' : error ? 'failed' : 'completed'
      void this.patchActiveTurn(active, true)
      return
    }
    if (notification.method === 'turn/interrupted') {
      active.state = 'stopped'
      active.stopRequested = true
      void this.patchActiveTurn(active, true)
      return
    }
    if (notification.method === 'turn/failed') {
      active.error = turnError(notification) || 'Codex 执行失败'
      active.state = active.stopRequested ? 'stopped' : 'failed'
      void this.patchActiveTurn(active, true)
      return
    }
    if (notification.method === 'error') {
      // Codex emits transient, turn-scoped `error` notifications while its
      // upstream connection is retrying (for example "Reconnecting... 2/5").
      // The authoritative turn remains inProgress in that case. Treating this
      // notification as terminal makes the Feishu card fail early while the
      // still-running Codex turn keeps the shared Session busy forever.
      void this.reconcileActiveTurnError(active, turnError(notification) || 'Codex 连接暂时异常')
      return
    }
    if (delta || completedText) {
      active.state = 'running'
      this.scheduleStreamPatch(active)
    }
  }

  private captureToolReplyImages(active: ActiveTurnCard, notification: FeishuAppServerNotification): void {
    const runtime = this.runtimes.get(active.botId)
    if (!runtime?.transport.uploadImage) return
    for (const image of extractFeishuToolReplyImages(notification)) {
      if (active.replyImageFingerprints.size >= feishuReplyImageLimits.maxImages) break
      if (active.replyImageFingerprints.has(image.fingerprint)) continue
      active.replyImageFingerprints.add(image.fingerprint)
      const upload = runtime.transport.uploadImage(image).then((imageKey) => {
        active.replyImages.push({ imageKey, alt: image.alt, fingerprint: image.fingerprint })
        this.scheduleStreamPatch(active)
      }).catch((error) => {
        active.replyImageFingerprints.delete(image.fingerprint)
        if (!active.replyImageFailures.includes(image.alt)) active.replyImageFailures.push(image.alt)
        this.scheduleStreamPatch(active)
        this.log('warn', `Failed to upload generated image to Feishu: ${String(error)}`)
      })
      active.replyImageUploads.push(upload)
    }
  }

  private async prepareActiveReply(active: ActiveTurnCard): Promise<void> {
    if (active.preparedContent || active.state !== 'completed') return
    if (active.replyPreparation) return active.replyPreparation
    active.replyPreparation = (async () => {
      await Promise.all(active.replyImageUploads)
      active.replyImageUploads = []
      const runtime = this.runtimes.get(active.botId)
      if (!runtime?.transport.uploadImage) {
        active.preparedContent = active.content
        return
      }
      try {
        const generatedImages = await discoverCodexGeneratedReplyImages({
          threadId: active.binding.threadId,
          startedAtMs: Date.parse(active.startedAtIso),
        })
        for (const image of generatedImages) {
          if (active.replyImageFingerprints.size >= feishuReplyImageLimits.maxImages) break
          if (active.replyImageFingerprints.has(image.fingerprint)) continue
          active.replyImageFingerprints.add(image.fingerprint)
          try {
            const imageKey = await runtime.transport.uploadImage(image)
            active.replyImages.push({ imageKey, alt: image.alt, fingerprint: image.fingerprint })
          } catch (error) {
            active.replyImageFingerprints.delete(image.fingerprint)
            active.replyImageFailures.push(image.alt)
            this.log('warn', `Failed to upload Codex generated image to Feishu: ${String(error)}`)
          }
        }
        const prepared = await prepareFeishuReplyMarkdown({
          markdown: active.content,
          cwd: active.binding.cwd,
          upload: (image) => runtime.transport.uploadImage!(image),
          appendedImages: active.replyImages,
        })
        const failureNote = active.replyImageFailures.length > 0
          ? `> ⚠️ ${String(active.replyImageFailures.length)} 张 AI 图片上传失败，文本回答已保留。`
          : ''
        active.preparedContent = [prepared, failureNote].filter(Boolean).join('\n\n')
      } catch (error) {
        active.preparedContent = active.content
        this.log('warn', `Failed to prepare Feishu reply images: ${String(error)}`)
      }
    })().finally(() => { active.replyPreparation = null })
    return active.replyPreparation
  }

  private async reconcileActiveTurnError(active: ActiveTurnCard, notificationError: string): Promise<void> {
    const readTurnState = this.dependencies.turns.readTurnState
    if (!readTurnState || !active.turnId) {
      this.log('warn', `Non-terminal Codex error for ${active.binding.threadId}: ${notificationError}`)
      return
    }
    try {
      const authoritative = await readTurnState(active.binding.threadId, active.turnId)
      if (authoritative.status === 'running') {
        this.log('warn', `Codex turn ${active.turnId} is reconnecting but still active: ${notificationError}`)
        return
      }
      active.content = authoritative.responseText || active.content
      active.error = authoritative.error || (authoritative.status === 'missing' ? notificationError : '')
      active.state = authoritative.status === 'failed' || authoritative.status === 'missing'
        ? 'failed'
        : authoritative.status === 'cancelled'
          ? 'stopped'
          : 'completed'
      await this.patchActiveTurn(active, true)
    } catch (error) {
      this.log('warn', `Failed to reconcile Codex error for turn ${active.turnId}; keeping it active: ${String(error)}`)
    }
  }

  async handleApprovalRequest(request: FeishuAppServerRequest): Promise<void> {
    if (!request.method.endsWith('/requestApproval')) return
    await this.presentApprovalRequest(request)
  }

  async handleServerRequest(request: FeishuAppServerRequest): Promise<void> {
    if (request.method === 'item/tool/requestUserInput') {
      await this.presentUserInputRequest(request)
      return
    }
    if (request.method.endsWith('/requestApproval')) await this.presentApprovalRequest(request)
  }

  private async presentApprovalRequest(request: FeishuAppServerRequest): Promise<void> {
    const binding = await this.findFeishuRequestOrigin(request)
    if (!binding) return
    const runtime = this.runtimes.get(binding.botId)
    if (!runtime) return
    const presentationKey = requestKey(binding.botId, String(request.id))
    if (this.pendingRequestCards.has(presentationKey)) return
    const existingPresentation = this.serverRequestPresentations.get(presentationKey)
    if (existingPresentation) return existingPresentation
    const present = async () => {
    if (this.pendingRequestCards.has(presentationKey)) return
    const params = asRecord(request.params)
    const summary = readString(params?.reason || params?.command || params?.summary) || request.method
    const approvalCard = buildApprovalCard({
      bindingKey: binding.bindingKey,
      requestId: String(request.id),
      title: request.method.includes('fileChange') ? '文件修改需要批准' : '操作需要批准',
      summary,
      requesterOpenId: binding.senderOpenId,
    })
    if (binding.chatType === 'group' && !runtime.transport.sendUserCard) {
      this.log('warn', `[feishu:${binding.botId}] cannot present group approval privately: sendUserCard unavailable`)
      return
    }
    const messageId = binding.chatType === 'group'
      ? await runtime.transport.sendUserCard!(binding.senderOpenId, approvalCard)
      : binding.rootId
        ? await this.replyCardWithFallback(runtime, binding.rootId, binding.chatId, approvalCard, binding.rootId, binding.chatType)
        : await runtime.transport.sendCard(binding.chatId, approvalCard)
    this.pendingRequestCards.set(requestKey(binding.botId, String(request.id)), {
      requestId: String(request.id),
      botId: binding.botId,
      binding,
      messageId,
      requesterOpenId: binding.senderOpenId,
      kind: 'approval',
      title: request.method.includes('fileChange') ? '文件修改需要批准' : '操作需要批准',
      summary,
      questions: [],
      selections: {},
    })
    await this.persistRequestCard(this.pendingRequestCards.get(requestKey(binding.botId, String(request.id)))!, 'streaming')
    }
    const work = (runtime.transport.withDeliveryScope
      ? runtime.transport.withDeliveryScope(`server-request:${binding.botId}:${String(request.id)}`, present)
      : present()).finally(() => { this.serverRequestPresentations.delete(presentationKey) })
    this.serverRequestPresentations.set(presentationKey, work)
    return work
  }

  private async presentUserInputRequest(request: FeishuAppServerRequest): Promise<void> {
    const binding = await this.findFeishuRequestOrigin(request)
    if (!binding) return
    const runtime = this.runtimes.get(binding.botId)
    if (!runtime) return
    const presentationKey = requestKey(binding.botId, String(request.id))
    if (this.pendingRequestCards.has(presentationKey)) return
    const existingPresentation = this.serverRequestPresentations.get(presentationKey)
    if (existingPresentation) return existingPresentation
    const present = async () => {
    if (this.pendingRequestCards.has(presentationKey)) return
    const questions = normalizeUserInputQuestions(request.params)
    if (questions.length === 0) return
    const requestId = String(request.id)
    const card = buildUserInputCard({
      bindingKey: binding.bindingKey,
      requestId,
      requesterOpenId: binding.senderOpenId,
      questions,
    })
    if (binding.chatType === 'group' && !runtime.transport.sendUserCard) {
      this.log('warn', `[feishu:${binding.botId}] cannot present group user input privately: sendUserCard unavailable`)
      return
    }
    const messageId = binding.chatType === 'group'
      ? await runtime.transport.sendUserCard!(binding.senderOpenId, card)
      : binding.rootId
        ? await this.replyCardWithFallback(runtime, binding.rootId, binding.chatId, card, binding.rootId, binding.chatType)
        : await runtime.transport.sendCard(binding.chatId, card)
    this.pendingRequestCards.set(requestKey(binding.botId, requestId), {
      requestId,
      botId: binding.botId,
      binding,
      messageId,
      requesterOpenId: binding.senderOpenId,
      kind: 'user_input',
      title: 'Codex 需要你的选择',
      summary: questions.map((question) => question.header || question.question || question.id).join('；'),
      questions,
      selections: {},
    })
    await this.persistRequestCard(this.pendingRequestCards.get(requestKey(binding.botId, requestId))!, 'streaming')
    }
    const work = (runtime.transport.withDeliveryScope
      ? runtime.transport.withDeliveryScope(`server-request:${binding.botId}:${String(request.id)}`, present)
      : present()).finally(() => { this.serverRequestPresentations.delete(presentationKey) })
    this.serverRequestPresentations.set(presentationKey, work)
    return work
  }

  private async findFeishuRequestOrigin(request: FeishuAppServerRequest): Promise<FeishuSessionBinding | null> {
    const { threadId, turnId } = notificationIds({ method: request.method, params: request.params })
    if (!threadId) return null
    const active = this.activeTurnsByThread.get(threadId)
    if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
      return { ...active.binding, senderOpenId: active.requesterOpenId }
    }
    if (!turnId || !this.dependencies.lifecycle) return null
    const durable = (await this.dependencies.lifecycle.listTurns({ sessionId: threadId, limit: 100 }))
      .find((turn) => turn.turnId === turnId)
    if (!durable) return null
    const binding = await this.dependencies.store.findBinding(durable.botId, durable.bindingKey)
    if (!binding) return null
    const card = durable.cardId ? await this.dependencies.lifecycle.findCard(durable.cardId) : null
    const requesterOpenId = readString(asRecord(card?.state)?.requesterOpenId)
    return requesterOpenId ? { ...binding, senderOpenId: requesterOpenId } : null
  }

  async handleCardAction(botId: string, payload: unknown): Promise<unknown> {
    const runtime = this.runtimes.get(botId)
    if (!runtime) return { toast: { type: 'error', content: '机器人当前未连接' } }
    const data = actionData(payload)
    const { value, option, operatorOpenId } = data
    const action = readString(value.action)
    const bindingKey = readString(value.binding_key)
    if (!action.startsWith('cody_feishu_')) return undefined
    return this.handleFastCardAction(runtime, data)

  }

  private async handleFastCardAction(runtime: Runtime, data: ReturnType<typeof actionData>): Promise<unknown> {
    const { value, option, operatorOpenId, openMessageId } = data
    const action = readString(value.action)
    const botId = runtime.bot.botId
    if (action === FEISHU_CARD_ACTIONS.grantAccess || action === FEISHU_CARD_ACTIONS.denyAccess) {
      if (!operatorOpenId || operatorOpenId !== runtime.bot.allowedOpenIds[0]) {
        return { toast: { type: 'error', content: '只有机器人管理员可以处理访问申请' } }
      }
      const request = verifyAccessRequestToken(runtime.bot, readString(value.access_request_token), this.now().getTime())
      if (!request) return { toast: { type: 'warning', content: '访问申请已失效或校验失败，请让对方重新申请' } }
      const requesterOpenId = request.requesterOpenId
      const granted = action === FEISHU_CARD_ACTIONS.grantAccess
      if (granted && !this.dependencies.access) return { toast: { type: 'error', content: '访问授权通道尚未连接' } }
      const operationKey = `${botId}:access:${readString(value.access_request_token)}:${granted ? 'grant' : 'deny'}`
      const nowMs = this.now().getTime()
      for (const [key, resolved] of this.completedCardActions) {
        if (nowMs - resolved.completedAt > 10 * 60_000) this.completedCardActions.delete(key)
      }
      const completed = this.completedCardActions.get(operationKey)
      if (completed) return rawCardResponse(completed.card)
      const inFlight = this.inFlightAccessActions.get(operationKey)
      if (inFlight) return rawCardResponse(await inFlight)
      const work = (async () => {
        if (granted && !runtime.bot.allowedOpenIds.includes(requesterOpenId)) {
          await this.dependencies.access!.grantUser({ botId, openId: requesterOpenId })
          runtime.bot = { ...runtime.bot, allowedOpenIds: [...runtime.bot.allowedOpenIds, requesterOpenId] }
          runtime.fingerprint = botFingerprint(runtime.bot)
        }
        const card = buildResolvedAccessRequestCard({
          requesterOpenId,
          granted,
          operatorOpenId,
          resolvedAtIso: this.now().toISOString(),
        })
        this.completedCardActions.set(operationKey, { completedAt: this.now().getTime(), card })
        return card
      })()
      this.inFlightAccessActions.set(operationKey, work)
      try {
        return rawCardResponse(await work)
      } finally {
        this.inFlightAccessActions.delete(operationKey)
      }
    }
    if (action === FEISHU_CARD_ACTIONS.userInputToggle) {
      const pending = this.pendingRequestCards.get(requestKey(botId, readString(value.request_id)))
      if (!pending || pending.kind !== 'user_input') return { toast: { type: 'warning', content: '该问题已回答或已失效' } }
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, pending.requesterOpenId)) return { toast: { type: 'error', content: '只有请求发起者或机器人管理员可以回答' } }
      const questionId = readString(value.question_id)
      const answer = readString(value.answer)
      if (!pending.questions.find((row) => row.id === questionId)?.options.some((row) => row.label === answer)) {
        return { toast: { type: 'warning', content: '这个选项已失效，请重新打开卡片' } }
      }
      pending.selections = { ...pending.selections, [questionId]: answer }
      await this.persistRequestCard(pending, 'streaming')
      return rawCardResponse(buildUserInputCard({
        bindingKey: pending.binding.bindingKey,
        requestId: pending.requestId,
        requesterOpenId: pending.requesterOpenId,
        questions: pending.questions,
        selections: pending.selections,
      }))
    }

    const consumesPendingSelection = action === FEISHU_CARD_ACTIONS.selectSession || action === FEISHU_CARD_ACTIONS.newSession
    const pendingMessageId = readString(value.pending_message_id)
    if (consumesPendingSelection && !pendingMessageId) {
      return { toast: { type: 'warning', content: '选择卡片缺少原消息标识，请重新发送消息' } }
    }
    const operationKey = action === FEISHU_CARD_ACTIONS.approve
      || action === FEISHU_CARD_ACTIONS.deny
      || action === FEISHU_CARD_ACTIONS.userInputSubmit
      ? `${botId}:request:${readString(value.request_id)}`
      : consumesPendingSelection
        ? `${botId}:pending-selection:${readString(value.binding_key)}:${pendingMessageId}`
      : [
        botId, action, readString(value.binding_key), readString(value.request_id),
        readString(value.pending_message_id), option || readString(value.thread_id) || readString(value.project_key),
        readString(value.permission_mode),
      ].join(':')
    if (this.inFlightCardActions.has(operationKey)) return { toast: { type: 'info', content: '请求正在处理，请勿重复点击' } }

    const ownerOpenId = await this.cardActionOwner(runtime.bot.botId, action, value)
    if (!ownerOpenId) {
      return { toast: { type: 'warning', content: '该请求已处理、已失效或不属于当前对话' } }
    }
    if (!operatorOpenId || !this.isOperatorAuthorized(runtime.bot, operatorOpenId, ownerOpenId)) {
      return { toast: { type: 'error', content: '只有请求发起者、Session 绑定者或机器人管理员可以执行此操作' } }
    }

    const now = Date.now()
    for (const [key, completed] of this.completedCardActions) {
      if (now - completed.completedAt > 10 * 60_000) this.completedCardActions.delete(key)
    }
    const repeatableAction = action === FEISHU_CARD_ACTIONS.setPermissionMode
    const completed = repeatableAction ? undefined : this.completedCardActions.get(operationKey)
    if (completed) {
      if (openMessageId) this.schedule(() => {
        void runtime.transport.updateCard(openMessageId, completed.card)
          .catch((error) => this.log('warn', `[feishu:${botId}] failed to resync completed action card: ${String(error)}`))
      })
      return { toast: { type: 'success', content: '该请求已处理，正在同步卡片状态' } }
    }

    const work = this.runSlowCardAction(runtime, action, value, option, operatorOpenId)
      .then(async (card) => {
        // Side effects are complete before the UI patch. A failed patch must not
        // make a replay create a second Codex Session or resolve twice.
        if (!repeatableAction) this.completedCardActions.set(operationKey, { completedAt: Date.now(), card })
        if (openMessageId) await runtime.transport.updateCard(openMessageId, card)
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log('warn', `[feishu:${botId}] card action failed: ${message}`)
      })
      .finally(() => { this.inFlightCardActions.delete(operationKey) })
    this.inFlightCardActions.set(operationKey, work)
    this.schedule(() => { void work })
    return { toast: { type: 'info', content: '已接收，正在处理；完成后卡片会自动更新' } }
  }

  private async cardActionOwner(botId: string, action: string, value: Record<string, unknown>): Promise<string> {
    if (action === FEISHU_CARD_ACTIONS.approve || action === FEISHU_CARD_ACTIONS.deny || action === FEISHU_CARD_ACTIONS.userInputSubmit) {
      return this.pendingRequestCards.get(requestKey(botId, readString(value.request_id)))?.requesterOpenId ?? ''
    }
    const bindingKey = readString(value.binding_key)
    if (action === FEISHU_CARD_ACTIONS.selectProject || action === FEISHU_CARD_ACTIONS.selectSession || action === FEISHU_CARD_ACTIONS.newSession) {
      let pending = await this.dependencies.store.peekPendingMessage(botId, bindingKey)
      if (pending) return pending.senderOpenId
    }
    return (await this.dependencies.store.findBinding(botId, bindingKey))?.senderOpenId ?? ''
  }

  private async runSlowCardAction(
    runtime: Runtime,
    action: string,
    value: Record<string, unknown>,
    option: string,
    operatorOpenId: string,
  ): Promise<FeishuCard> {
    const botId = runtime.bot.botId
    const bindingKey = readString(value.binding_key)
    const pendingMessageId = readString(value.pending_message_id)
    if (action === FEISHU_CARD_ACTIONS.selectProject) {
      const pending = await this.dependencies.store.peekPendingMessage(botId, bindingKey)
      if (!pending) throw new Error('原消息已过期，请重新发送消息')
      if (readString(value.pending_message_id) !== pending.messageId) throw new Error('这张项目选择卡已过期，请使用最新卡片')
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, pending.senderOpenId)) throw new Error('只有请求发起者或机器人管理员可以选择项目')
      const projects = await this.dependencies.catalog.listProjects()
      const project = projects.find((row) => row.projectKey === (option || readString(value.project_key)))
      if (!project) throw new Error('项目不存在或已隐藏，请刷新后重试')
      return buildSessionSelectionCard({
        project,
        sessions: project.sessions,
        bindingKey,
        pendingMessageId: pending.messageId,
        requesterOpenId: pending.senderOpenId,
        ...(pending.autoRouteDraft ? { autoRoute: pending.autoRouteDraft } : {}),
      })
    }

    if (action === FEISHU_CARD_ACTIONS.selectSession || action === FEISHU_CARD_ACTIONS.newSession) {
      // Keep the original message durable until a Feishu turn has been prepared.
      // The in-flight action map serializes live clicks; retaining this row also
      // lets startup recovery finish a binding if the process exits mid-flow.
      const claimToken = randomUUID()
      let pending = await this.dependencies.store.claimPendingMessage(botId, bindingKey, claimToken)
      if (!pending) {
        const existing = await this.dependencies.store.findBinding(botId, bindingKey)
        if (existing) return buildBoundSessionCard({
          projectLabel: existing.projectLabel,
          sessionTitle: existing.threadTitle,
          threadId: existing.threadId,
          bindingKey,
          webUrl: this.dependencies.webThreadUrl?.(existing.threadId),
          requesterOpenId: existing.senderOpenId,
          permissionMode: existing.permissionMode ?? 'yolo',
        })
        if (await this.dependencies.store.peekPendingMessage(botId, bindingKey)) {
          throw new Error('另一个 Session 选项正在处理，请勿重复选择')
        }
        throw new Error('原消息已过期，请重新发送消息')
      }
      try {
      if (pendingMessageId !== pending.messageId) throw new Error('这张 Session 选择卡已过期，请使用最新卡片')
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, pending.senderOpenId)) throw new Error('只有请求发起者或机器人管理员可以切换 Session')
      const alreadyBound = await this.dependencies.store.findBinding(botId, bindingKey)
      if (!pending.autoRouteDraft && alreadyBound && pending.sessionSelection?.createdThreadId === alreadyBound.threadId) {
        await this.deliverPendingMessages(runtime, alreadyBound, pending)
        return buildBoundSessionCard({
          projectLabel: alreadyBound.projectLabel,
          sessionTitle: alreadyBound.threadTitle,
          threadId: alreadyBound.threadId,
          bindingKey,
          webUrl: this.dependencies.webThreadUrl?.(alreadyBound.threadId),
          requesterOpenId: alreadyBound.senderOpenId,
          permissionMode: alreadyBound.permissionMode ?? 'yolo',
        })
      }
      const projects = await this.dependencies.catalog.listProjects()
      const project = projects.find((row) => row.projectKey === readString(value.project_key))
      if (!project) throw new Error('项目不存在或已隐藏')
      let threadId = ''
      let title = ''
      if (action === FEISHU_CARD_ACTIONS.selectSession) {
        const requestedThreadId = option || readString(value.thread_id)
        const selectedSession = project.sessions.find((session) => session.threadId === requestedThreadId)
        if (!selectedSession) throw new Error('所选 Session 已不存在或不属于当前可见项目，请刷新后重试')
        threadId = selectedSession.threadId
        title = selectedSession.title
      }
      if (action === FEISHU_CARD_ACTIONS.newSession) {
        const existingIntent = pending.sessionSelection?.action === 'new_session'
          && pending.sessionSelection.projectKey === project.projectKey
          ? pending.sessionSelection
          : null
        if (existingIntent?.createdThreadId) {
          threadId = existingIntent.createdThreadId
          title = existingIntent.createdThreadTitle ?? ''
        } else if (existingIntent) {
          const known = new Set(existingIntent.knownThreadIds)
          const candidates = project.sessions.filter((session) => {
            if (known.has(session.threadId)) return false
            if (!session.updatedAtIso) return true
            return Date.parse(session.updatedAtIso) >= Date.parse(existingIntent.startedAtIso) - 5_000
          })
          if (candidates.length === 1) {
            threadId = candidates[0]!.threadId
            title = candidates[0]!.title
          } else if (candidates.length > 1) {
            throw new Error('检测到多个新 Session，未自动选择以避免串会话；请返回项目选择后手动选择已有 Session')
          } else if (this.now().getTime() - Date.parse(existingIntent.startedAtIso) < 120_000) {
            throw new Error('正在确认新 Session 的创建结果，请稍后重试；原消息不会丢失')
          }
        }
        if (!threadId) {
          const intent = existingIntent ?? {
            action: 'new_session' as const,
            projectKey: project.projectKey,
            knownThreadIds: project.sessions.map((session) => session.threadId),
            startedAtIso: this.now().toISOString(),
          }
          pending = { ...pending, sessionSelection: intent }
          await this.dependencies.store.savePendingMessage(pending)
          const started = await this.dependencies.catalog.startSession({ cwd: project.cwd, projectKey: project.projectKey })
          threadId = started.threadId
          title = started.title
          pending = { ...pending, sessionSelection: {
            ...intent,
            createdThreadId: threadId,
            createdThreadTitle: title,
          } }
          await this.dependencies.store.savePendingMessage(pending)
        }
      }
      if (!threadId) throw new Error('请选择一个 Session')
      if (action === FEISHU_CARD_ACTIONS.selectSession) {
        pending = { ...pending, sessionSelection: {
          action: 'select_session',
          projectKey: project.projectKey,
          knownThreadIds: project.sessions.map((session) => session.threadId),
          startedAtIso: this.now().toISOString(),
          createdThreadId: threadId,
          createdThreadTitle: title,
        } }
        await this.dependencies.store.savePendingMessage(pending)
      }
      let binding: FeishuSessionBinding = {
        botId,
        bindingKey,
        chatId: pending.chatId,
        rootId: pending.rootId,
        chatType: pending.chatType,
        senderOpenId: pending.senderOpenId,
        projectKey: project.projectKey,
        projectLabel: project.label,
        cwd: project.cwd,
        threadId,
        threadTitle: title || 'Untitled session',
        permissionMode: 'yolo',
      }
      let autoRoute: FeishuAutoRoute | null = null
      if (pending.autoRouteDraft) {
        if (!this.dependencies.store.upsertAutoRoute) throw new Error('当前版本尚未启用卡片自动路由存储')
        const draft = pending.autoRouteDraft
        autoRoute = await this.dependencies.store.upsertAutoRoute({
          botId,
          chatId: pending.chatId,
          name: draft.cardTitle,
          sourceSenderId: draft.sourceSenderId,
          sourceSenderType: draft.sourceSenderType,
          cardTitle: draft.cardTitle,
          requiredKeywords: draft.requiredKeywords,
          fingerprintKey: draft.fingerprintKey,
          instruction: draft.instruction,
          projectKey: project.projectKey,
          projectCwd: project.cwd,
          projectName: project.label,
          sessionId: threadId,
          sessionTitle: title || 'Untitled session',
          createdByOpenId: pending.senderOpenId,
        })
        binding = { ...binding, bindingKey: autoRoute.bindingKey, rootId: '', threadTitle: autoRoute.sessionTitle }
        this.refineAutoRouteWithCodex(autoRoute, draft)
      }
      await this.dependencies.store.upsertBinding(binding)
      await this.deliverPendingMessages(runtime, binding, pending)
      if (autoRoute) return buildAutoRouteCreatedCard({
        routeName: autoRoute.name,
        projectLabel: binding.projectLabel,
        sessionTitle: binding.threadTitle,
        cardTitle: autoRoute.cardTitle,
        requiredKeywords: autoRoute.requiredKeywords,
        sourceSenderId: autoRoute.sourceSenderId,
        webUrl: this.dependencies.webThreadUrl?.(threadId),
      })
      return buildBoundSessionCard({
        projectLabel: binding.projectLabel,
        sessionTitle: binding.threadTitle,
        threadId,
        bindingKey,
        webUrl: this.dependencies.webThreadUrl?.(threadId),
        requesterOpenId: binding.senderOpenId,
        permissionMode: binding.permissionMode ?? 'yolo',
      })
      } finally {
        await this.dependencies.store.releasePendingMessageClaim(botId, claimToken)
      }
    }

    if (action === FEISHU_CARD_ACTIONS.setPermissionMode) {
      const binding = await this.dependencies.store.findBinding(botId, bindingKey)
      if (!binding) throw new Error('当前对话尚未绑定 Session')
      const permissionMode = readString(value.permission_mode)
      if (permissionMode !== 'normal' && permissionMode !== 'yolo') throw new Error('不支持的权限模式')
      const updated: FeishuSessionBinding = { ...binding, permissionMode }
      await this.dependencies.store.upsertBinding(updated)
      return buildBoundSessionCard({
        projectLabel: updated.projectLabel,
        sessionTitle: updated.threadTitle,
        threadId: updated.threadId,
        bindingKey: updated.bindingKey,
        webUrl: this.dependencies.webThreadUrl?.(updated.threadId),
        requesterOpenId: updated.senderOpenId,
        permissionMode,
      })
    }

    if (action === FEISHU_CARD_ACTIONS.unbind) {
      const binding = await this.dependencies.store.findBinding(botId, bindingKey)
      if (!binding) return buildActionResultCard({ title: '已解除绑定', message: '当前对话已没有绑定 Session。', success: true })
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, binding.senderOpenId)) throw new Error('只有 Session 绑定者或机器人管理员可以解除绑定')
      await this.dependencies.store.deleteBinding(botId, bindingKey)
      return buildActionResultCard({ title: '已解除绑定', message: '已解除当前 Session 绑定。', success: true })
    }

    if (action === FEISHU_CARD_ACTIONS.approve || action === FEISHU_CARD_ACTIONS.deny) {
      if (!this.dependencies.approvals) throw new Error('审批通道尚未连接')
      const pending = this.pendingRequestCards.get(requestKey(botId, readString(value.request_id)))
      if (!pending || pending.kind !== 'approval') throw new Error('该审批已处理或已失效')
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, pending.requesterOpenId)) throw new Error('只有请求发起者或机器人管理员可以审批')
      await this.dependencies.approvals.resolve({ requestId: pending.requestId, decision: readString(value.decision), scope: readString(value.scope) })
      await this.persistRequestCard(pending, 'completed')
      this.pendingRequestCards.delete(requestKey(botId, pending.requestId))
      return buildResolvedRequestCard({
        title: pending.title,
        summary: pending.summary,
        outcome: action === FEISHU_CARD_ACTIONS.deny ? 'denied' : 'approved',
        operatorOpenId,
        resolvedAtIso: this.now().toISOString(),
      })
    }

    if (action === FEISHU_CARD_ACTIONS.userInputSubmit) {
      const pending = this.pendingRequestCards.get(requestKey(botId, readString(value.request_id)))
      if (!pending || pending.kind !== 'user_input') throw new Error('该问题已回答或已失效')
      if (!this.isOperatorAuthorized(runtime.bot, operatorOpenId, pending.requesterOpenId)) throw new Error('只有请求发起者或机器人管理员可以回答')
      const unanswered = pending.questions.filter((question) => !pending.selections[question.id])
      if (unanswered.length) throw new Error(`请先回答：${unanswered.map((question) => question.header || question.question || question.id).join('、')}`)
      if (!this.dependencies.serverRequests) throw new Error('问题答复通道尚未连接')
      const answers = Object.fromEntries(Object.entries(pending.selections).map(([id, answer]) => [id, { answers: [answer] }]))
      await this.dependencies.serverRequests.respond({ requestId: pending.requestId, result: { answers } })
      await this.persistRequestCard(pending, 'completed')
      this.pendingRequestCards.delete(requestKey(botId, pending.requestId))
      return buildResolvedRequestCard({
        title: pending.title,
        summary: pending.summary,
        outcome: 'answered',
        operatorOpenId,
        resolvedAtIso: this.now().toISOString(),
        answers: Object.fromEntries(pending.questions.map((question) => [question.header || question.id, pending.selections[question.id] ?? ''])),
      })
    }
    throw new Error('未知的卡片操作')
  }

  private async connectBot(bot: FeishuBotDefinition, fingerprint: string): Promise<void> {
    const transport = this.dependencies.transportFactory?.(bot) ?? new LarkSdkTransport(bot)
    const snapshot: FeishuBotRuntimeSnapshot = {
      botId: bot.botId,
      appId: bot.appId,
      botName: bot.botName ?? '',
      state: 'connecting',
      connectionState: 'connecting',
      connectedAtIso: null,
      lastError: '',
    }
    const runtime: Runtime = { bot, fingerprint, transport, snapshot }
    this.runtimes.set(bot.botId, runtime)
    const handlers: FeishuTransportHandlers = {
      onMessage: (payload) => this.schedule(() => {
        void this.processInbound(runtime, payload).catch((error) => {
          this.log('error', `[feishu:${bot.botId}] inbound processing failed: ${String(error)}`)
        })
      }),
      onCardAction: (payload) => this.handleCardAction(bot.botId, payload),
      onState: (state, error) => { void this.recordRuntimeState(runtime, state, error) },
    }
    try {
      if (transport.getBotIdentity) {
        const identity = await transport.getBotIdentity()
        runtime.bot = { ...runtime.bot, botOpenId: identity.openId, botName: identity.name || runtime.bot.botName }
        runtime.snapshot.botName = runtime.bot.botName ?? ''
        await this.dependencies.store.updateRuntime(bot.botId, {
          state: 'connecting',
          connectionState: 'connecting',
          botOpenId: identity.openId,
          botName: identity.name,
        })
      }
      await transport.start(handlers)
    } catch (error) {
      await this.recordRuntimeState(runtime, 'failed', error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async recordRuntimeState(runtime: Runtime, state: FeishuTransportState, error?: Error): Promise<void> {
    const publicState = transportStateToRuntime(state)
    runtime.snapshot = {
      ...runtime.snapshot,
      state: publicState,
      connectionState: state,
      connectedAtIso: state === 'connected' ? (runtime.snapshot.connectedAtIso ?? this.now().toISOString()) : runtime.snapshot.connectedAtIso,
      lastError: error?.message ?? (state === 'connected' ? '' : runtime.snapshot.lastError),
    }
    await this.dependencies.store.updateRuntime(runtime.bot.botId, {
      state: publicState,
      connectionState: state,
      lastError: runtime.snapshot.lastError,
      connectedAtIso: runtime.snapshot.connectedAtIso,
    }).catch((storeError) => this.log('error', `Failed to persist Feishu runtime state: ${String(storeError)}`))
  }

  private async reviveFailedConnections(): Promise<void> {
    if (this.stopped) return
    for (const [botId, runtime] of this.runtimes) {
      if (runtime.transport.getState() !== 'failed') continue
      this.log('warn', `[feishu:${botId}] reconnect exhausted; recreating long connection`)
      runtime.transport.close()
      this.runtimes.delete(botId)
      await this.connectBot(runtime.bot, runtime.fingerprint)
    }
  }

  private async processInbound(runtime: Runtime, payload: unknown): Promise<void> {
    const preliminary = normalizeFeishuInbound(runtime.bot, payload)
    if (!preliminary) return
    const botSender = preliminary.senderType === 'app' || preliminary.senderType === 'bot'
    if (botSender) {
      await this.processAutoRouteInbound(runtime, payload, preliminary)
      return
    }
    if (!preliminary.senderOpenId) {
      this.log('warn', `[feishu:${runtime.bot.botId}] rejected inbound ${preliminary.messageId}: sender open_id missing`)
      return
    }
    if (!this.isInboundAuthorized(runtime.bot, preliminary)) {
      await this.processAccessRequest(runtime, preliminary)
      return
    }
    if (!await this.dependencies.store.claimEvent(runtime.bot.botId, preliminary.eventKey)) return
    try {
      const completed = await this.completeInboundMessage(runtime, payload)
      const normalized = normalizeFeishuInbound(runtime.bot, completed.payload) ?? preliminary
      const inbound = {
        ...normalized,
        prompt: completed.quoteText ? `${completed.quoteText}\n\n${normalized.prompt}`.trim() : normalized.prompt,
        resources: [...completed.quoteResources, ...normalized.resources],
        ...(completed.quote?.status === 'resolved' && completed.quote.text
          ? { autoRouteDraft: createFeishuAutoRouteDraft({
              sourceSenderId: completed.quote.senderId ?? '',
              sourceSenderType: completed.quote.senderType ?? '',
              messageType: completed.quote.messageType,
              text: completed.quote.text,
              instruction: normalized.prompt
                .replace(/^\[用户引用了飞书消息 [^\]]+\]\s*/u, '')
                .trim(),
            }) ?? undefined }
          : {}),
      }
      const processClaimed = () => this.processClaimedInbound(runtime, inbound)
      if (runtime.transport.withDeliveryScope) {
        await runtime.transport.withDeliveryScope(`${runtime.bot.botId}:${inbound.eventKey}`, processClaimed)
      } else {
        await processClaimed()
      }
      await this.dependencies.store.completeEvent?.(runtime.bot.botId, inbound.eventKey)
    } catch (error) {
      await this.dependencies.store.failEvent?.(
        runtime.bot.botId,
        preliminary.eventKey,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  private async processAutoRouteInbound(runtime: Runtime, payload: unknown, preliminary: NormalizedInbound): Promise<void> {
    if (preliminary.chatType !== 'group' || !preliminary.topLevel || preliminary.messageType !== 'interactive') return
    const allowedChatIds = runtime.bot.allowedChatIds ?? []
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(preliminary.chatId)) return
    if (
      !preliminary.senderId
      || preliminary.senderOpenId === runtime.bot.botOpenId
      || preliminary.senderId === runtime.bot.botOpenId
      || preliminary.senderId === runtime.bot.appId
    ) return
    const candidates = await this.dependencies.store.listAutoRoutes?.({
      botId: runtime.bot.botId,
      chatId: preliminary.chatId,
      enabled: true,
    }) ?? []
    if (!candidates.length) return
    if (!await this.dependencies.store.claimEvent(runtime.bot.botId, preliminary.eventKey)) return
    try {
      const completed = await this.completeInboundMessage(runtime, payload)
      const inbound = normalizeFeishuInbound(runtime.bot, completed.payload) ?? preliminary
      const route = candidates.find((candidate) => matchesFeishuAutoRoute(candidate, {
        sourceSenderId: inbound.senderId,
        sourceSenderType: inbound.senderType,
        messageType: inbound.messageType,
        text: inbound.prompt,
      }))
      if (!route) {
        await this.dependencies.store.completeEvent?.(runtime.bot.botId, preliminary.eventKey)
        return
      }
      let rootId = ''
      if (runtime.transport.getChatMode) {
        try {
          if (await runtime.transport.getChatMode(inbound.chatId, { forceRefresh: true }) === 'topic') rootId = inbound.messageId
        } catch (error) {
          this.log('warn', `[feishu:${runtime.bot.botId}] auto route ${route.id} could not resolve chat mode: ${String(error)}`)
          await this.dependencies.store.completeEvent?.(runtime.bot.botId, preliminary.eventKey)
          return
        }
      }
      const binding: FeishuSessionBinding = {
        botId: route.botId,
        bindingKey: route.bindingKey,
        chatId: route.chatId,
        rootId,
        chatType: 'group',
        senderOpenId: route.createdByOpenId,
        projectKey: route.projectKey,
        projectLabel: route.projectName || route.projectKey || route.projectCwd,
        cwd: route.projectCwd,
        threadId: route.sessionId,
        threadTitle: route.sessionTitle,
        permissionMode: 'yolo',
      }
      await this.dependencies.store.upsertBinding(binding)
      await this.dependencies.store.touchAutoRoute?.(route.id)
      const prompt = buildFeishuAutoRoutePrompt({
        routeName: route.name,
        instruction: route.instruction,
        cardText: inbound.prompt,
      })
      await this.enqueueMessage(binding.bindingKey, () => this.deliverPrompt(
        runtime,
        binding,
        inbound.messageId,
        prompt,
        inbound.resources,
        route.createdByOpenId,
      ))
      await this.dependencies.store.completeEvent?.(runtime.bot.botId, preliminary.eventKey)
    } catch (error) {
      await this.dependencies.store.failEvent?.(
        runtime.bot.botId,
        preliminary.eventKey,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  private refineAutoRouteWithCodex(route: FeishuAutoRoute, draft: FeishuAutoRouteDraft): void {
    const analyzer = this.dependencies.autoRouteAnalyzer
    if (!analyzer || !this.dependencies.store.updateAutoRouteDefinition || !draft.requiredKeywords.length) return
    this.schedule(() => {
      void analyzer.analyze({
        cwd: route.projectCwd,
        cardTitle: route.cardTitle,
        cardText: draft.preview,
        candidateKeywords: draft.requiredKeywords,
        requestedInstruction: route.instruction,
      }).then(async (proposal) => {
        const allowed = new Map(draft.requiredKeywords.map((keyword) => [keyword.toLocaleLowerCase(), keyword]))
        const requiredKeywords = Array.from(new Set(proposal.requiredKeywords
          .map((keyword) => allowed.get(keyword.trim().toLocaleLowerCase()) ?? '')
          .filter(Boolean)))
          .slice(0, 8)
        if (!requiredKeywords.length) throw new Error('Codex returned no valid stable card fields')
        const instruction = proposal.instruction.trim().slice(0, 1_000) || route.instruction
        // Preserve the deterministic fingerprint generated from the original
        // full schema. AI may narrow match fields, but reconfiguring the same
        // card must update the existing destination instead of creating a
        // second route with a new identity.
        await this.dependencies.store.updateAutoRouteDefinition?.({ id: route.id, requiredKeywords, instruction })
        this.log('info', `[feishu:${route.botId}] Codex refined auto route ${route.id}: ${proposal.reason || 'no reason provided'}`)
      }).catch((error) => {
        // The deterministic draft is already active. AI refinement is a safe,
        // best-effort enhancement and must never break first-use routing.
        this.log('warn', `[feishu:${route.botId}] Codex auto route refinement skipped: ${String(error)}`)
      })
    })
  }

  private async completeInboundMessage(runtime: Runtime, payload: unknown): Promise<{ payload: unknown; quoteText: string; quoteResources: FeishuMessageResource[]; quote?: FeishuResolvedQuote }> {
    if (!runtime.transport.getMessage) return { payload, quoteText: '', quoteResources: [] }
    const envelope = asRecord(payload)
    const event = asRecord(envelope?.event) ?? envelope
    const message = asRecord(event?.message)
    if (!envelope || !event || !message) return { payload, quoteText: '', quoteResources: [] }
    const messageId = readString(message.message_id || message.messageId)
    if (!messageId) return { payload, quoteText: '', quoteResources: [] }
    try {
      const resolved = await resolveFeishuMessage({
        messageId,
        messageType: message.message_type || message.messageType || message.msg_type,
        content: message.content,
        mentions: message.mentions,
        parentId: message.parent_id || message.parentId,
        rootId: message.root_id || message.rootId,
        threadId: message.thread_id || message.threadId,
      }, { getMessage: runtime.transport.getMessage.bind(runtime.transport) })
      const resolvedMessage = {
        ...message,
        message_type: resolved.messageType,
        content: resolved.content,
        ...(resolved.mentions !== undefined ? { mentions: resolved.mentions } : {}),
      }
      const resolvedEvent = { ...event, message: resolvedMessage }
      const resolvedPayload = envelope.event ? { ...envelope, event: resolvedEvent } : resolvedEvent
      const quoteText = resolved.quote?.status === 'resolved' && resolved.quote.text
        ? `引用消息：${resolved.quote.text}`
        : resolved.quote?.status === 'unavailable'
          ? `引用消息 ${resolved.quote.messageId} 无法读取：${resolved.quote.reason ?? '无权限或已删除'}`
          : ''
      const quoteResources = resolved.quote?.status === 'resolved' && resolved.quote.messageType && resolved.quote.content
        ? parseFeishuMessage({
          messageId: resolved.quote.messageId,
          messageType: resolved.quote.messageType,
          content: resolved.quote.content,
        }).resources.map((resource) => ({
          ...resource,
          messageId: resolved.quote!.messageId,
          ...(resolved.quote!.messageType === 'interactive'
            ? { downloadUnsupportedReason: '飞书 API 不支持下载卡片消息中的资源（234043）' }
            : {}),
        }))
        : []
      return { payload: resolvedPayload, quoteText, quoteResources, ...(resolved.quote ? { quote: resolved.quote } : {}) }
    } catch (error) {
      this.log('warn', `[feishu:${runtime.bot.botId}] failed to complete message ${messageId}: ${String(error)}`)
      return { payload, quoteText: '', quoteResources: [] }
    }
  }

  private async processClaimedInbound(runtime: Runtime, initialInbound: NormalizedInbound): Promise<void> {
    let inbound = initialInbound
    if (!inbound.senderOpenId) {
      this.log('warn', `[feishu:${runtime.bot.botId}] rejected inbound ${inbound.messageId}: sender open_id missing`)
      return
    }
    if (!this.isInboundAuthorized(runtime.bot, inbound)) return
    // A top-level post in a topic group has no root_id/thread_id in the event.
    // Query the mutable group_message_type so it gets its own binding instead
    // of accidentally sharing the flat group's chat-scoped session.
    let chatModeLookupFailed = false
    if (inbound.chatType === 'group' && inbound.topLevel && runtime.transport.getChatMode) {
      try {
        if (await runtime.transport.getChatMode(inbound.chatId, { forceRefresh: true }) === 'topic') {
          inbound = {
            ...inbound,
            rootId: inbound.messageId,
            bindingKey: messageBindingKey(inbound.botId, inbound.chatId, inbound.chatType, inbound.messageId),
          }
        }
      } catch (error) {
        chatModeLookupFailed = true
        this.log('warn', `[feishu:${runtime.bot.botId}] failed to resolve chat mode for ${inbound.chatId}: ${String(error)}`)
      }
    }
    let binding = await this.dependencies.store.findBinding(inbound.botId, inbound.bindingKey)

    if (chatModeLookupFailed) {
      if (inbound.explicitlyMentioned) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '暂时无法确认群聊模式，为避免绑定到错误的 Session，本次未处理。请稍后重试。', '', inbound.chatType)
      }
      return
    }

    if (inbound.chatType === 'group' && inbound.explicitlyMentioned && inbound.autoRouteDraft) {
      if (!this.dependencies.store.upsertAutoRoute || !this.dependencies.store.listAutoRoutes) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '当前版本尚未启用卡片自动路由存储。', inbound.rootId, inbound.chatType)
        return
      }
      const draft = inbound.autoRouteDraft
      // Route setup is an independent one-shot workflow. Reusing the ordinary
      // chat binding key would put repeated setup attempts behind older
      // unconsumed project pickers, making every new picker appear stale.
      const setupBindingKey = `${inbound.bindingKey}:auto-route-setup:${inbound.messageId}`
      const pending: FeishuPendingInbound = {
        ...inbound,
        bindingKey: setupBindingKey,
        prompt: buildFeishuAutoRoutePrompt({
          routeName: draft.cardTitle,
          instruction: draft.instruction,
          cardText: draft.preview,
        }),
        autoRouteDraft: draft,
        createdAtIso: this.now().toISOString(),
      }
      await this.dependencies.store.savePendingMessage(pending)
      const projects = await this.dependencies.catalog.listProjects()
      await this.replyCardWithFallback(runtime, inbound.messageId, inbound.chatId, buildProjectSelectionCard({
        projects,
        bindingKey: setupBindingKey,
        pendingMessageId: inbound.messageId,
        requesterOpenId: inbound.senderOpenId,
        autoRoute: draft,
      }), inbound.rootId, inbound.chatType)
      return
    }

    if (inbound.chatType === 'group' && !inbound.explicitlyMentioned) {
      if (inbound.hasNonBotMention) return
      const mentionMode = runtime.bot.groupMentionMode ?? 'always'
      const mayContinue = mentionMode === 'bound' && Boolean(binding)
        || mentionMode === 'topic' && Boolean(binding && inbound.rootId)
      if (!mayContinue) return
    }
    if (!inbound.prompt) return

    const commandMatch = inbound.prompt.match(/^\/(\w+)(?:\s+([\s\S]+))?$/u)
    const command = commandMatch?.[1]?.toLowerCase() ?? ''
    const commandArgument = commandMatch?.[2]?.trim() ?? ''
    const managementCommands = new Set(['archive', 'mode', 'new', 'normal', 'permission', 'project', 'rename', 'sessions', 'status', 'stop', 'switch', 'unbind', 'yolo'])
    const knownCommands = new Set([...managementCommands, 'answer', 'help'])
    if (command === 'help') {
      await runtime.transport.replyCard(inbound.messageId, buildBotHelpCard({
        projectLabel: binding?.projectLabel,
        sessionTitle: binding?.threadTitle,
        collaborationMode: binding?.collaborationMode ?? 'default',
        permissionMode: binding?.permissionMode ?? 'yolo',
      }), Boolean(inbound.rootId))
      return
    }
    if (inbound.prompt.startsWith('/') && (!command || !knownCommands.has(command))) {
      await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, `未知命令${command ? ` /${command}` : ''}。发送 /help 查看可用命令。`, inbound.rootId, inbound.chatType)
      return
    }

    if (command === 'answer') {
      const parsed = commandArgument.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/u)
      if (!parsed) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '用法：/answer 请求ID 问题ID 你的答案', inbound.rootId, inbound.chatType)
        return
      }
      const [, requestId = '', questionId = '', rawAnswer = ''] = parsed
      const answer = rawAnswer.trim()
      const pending = this.pendingRequestCards.get(requestKey(inbound.botId, requestId))
      if (!pending || pending.kind !== 'user_input') {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '该问题已回答、已过期或不属于当前机器人。', inbound.rootId, inbound.chatType)
        return
      }
      if (!this.isOperatorAuthorized(runtime.bot, inbound.senderOpenId, pending.requesterOpenId)) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '只有请求发起者或机器人管理员可以回答。', inbound.rootId, inbound.chatType)
        return
      }
      const question = pending.questions.find((row) => row.id === questionId)
      if (!question) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '问题 ID 不存在，请按卡片中的命令格式重试。', inbound.rootId, inbound.chatType)
        return
      }
      if (!answer || answer.length > 2_000) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '答案不能为空，且不能超过 2000 个字符。', inbound.rootId, inbound.chatType)
        return
      }
      if (!question.isOther && question.options.length > 0 && !question.isSecret) {
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '该问题只接受卡片中的选项。', inbound.rootId, inbound.chatType)
        return
      }
      if (question.isSecret) {
        if (inbound.chatType !== 'p2p') {
          await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '敏感答案只能在与机器人私聊中发送。', inbound.rootId, inbound.chatType)
          return
        }
        const unanswered = pending.questions.filter((row) => row.id !== question.id && !pending.selections[row.id])
        if (unanswered.length > 0) {
          await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, `请先回答其他问题：${unanswered.map((row) => row.header || row.question || row.id).join('、')}，最后再发送敏感答案。`, '', inbound.chatType)
          return
        }
        if (!this.dependencies.serverRequests) {
          await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '问题答复通道尚未连接。', '', inbound.chatType)
          return
        }
        const submitted = { ...pending.selections, [question.id]: answer }
        const answers = Object.fromEntries(Object.entries(submitted).map(([id, value]) => [id, { answers: [value] }]))
        await this.dependencies.serverRequests.respond({ requestId: pending.requestId, result: { answers } })
        pending.selections = { ...pending.selections, [question.id]: '[REDACTED]' }
        await this.persistRequestCard(pending, 'completed')
        this.pendingRequestCards.delete(requestKey(inbound.botId, requestId))
        await runtime.transport.updateCard(pending.messageId, buildResolvedRequestCard({
          title: pending.title,
          summary: pending.summary,
          outcome: 'answered',
          operatorOpenId: inbound.senderOpenId,
          resolvedAtIso: this.now().toISOString(),
          answers: Object.fromEntries(pending.questions.map((row) => [row.header || row.id, pending.selections[row.id] ?? ''])),
        })).catch((error) => this.log('warn', `[feishu:${inbound.botId}] failed to freeze secret answer card: ${String(error)}`))
        await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '敏感答案已提交，内容不会显示在卡片或诊断页面中。', '', inbound.chatType)
        return
      }
      pending.selections = { ...pending.selections, [question.id]: answer }
      await this.persistRequestCard(pending, 'streaming')
      await runtime.transport.updateCard(pending.messageId, buildUserInputCard({
        bindingKey: pending.binding.bindingKey,
        requestId: pending.requestId,
        requesterOpenId: pending.requesterOpenId,
        questions: pending.questions,
        selections: pending.selections,
      })).catch((error) => this.log('warn', `[feishu:${inbound.botId}] failed to update custom answer card: ${String(error)}`))
      await this.replyTextWithFallback(runtime, inbound.messageId, inbound.chatId, '已记录自定义答案，请在原卡片中提交。', inbound.rootId, inbound.chatType)
      return
    }
    if (binding && managementCommands.has(command) && !this.isOperatorAuthorized(runtime.bot, inbound.senderOpenId, binding.senderOpenId)) {
      await runtime.transport.replyText(inbound.messageId, '只有 Session 绑定者或机器人管理员可以执行管理命令。', Boolean(inbound.rootId))
      return
    }

    if (command === 'unbind') {
      if (binding) await this.dependencies.store.deleteBinding(inbound.botId, inbound.bindingKey)
      await runtime.transport.replyText(inbound.messageId, binding ? '已解除当前 Session 绑定。' : '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
      return
    }

    if (command === 'status') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。发送消息即可开始选择项目。', Boolean(inbound.rootId))
        return
      }
      const active = this.activeTurnsByThread.get(binding.threadId)
      const queuedCount = this.queuedTurnsByThread.get(binding.threadId)?.length ?? 0
      const externalBusy = !active && queuedCount === 0
        && Boolean(await this.dependencies.turns.isThreadBusy?.(binding.threadId))
      await runtime.transport.replyCard(inbound.messageId, buildSessionStatusCard({
        projectLabel: binding.projectLabel,
        sessionTitle: binding.threadTitle,
        threadId: binding.threadId,
        state: active ? 'running' : queuedCount > 0 ? 'queued' : externalBusy ? 'external' : 'idle',
        queuedCount,
        collaborationMode: binding.collaborationMode ?? 'default',
        permissionMode: binding.permissionMode ?? 'yolo',
        bindingKey: binding.bindingKey,
        requesterOpenId: binding.senderOpenId,
        webUrl: this.dependencies.webThreadUrl?.(binding.threadId),
      }), Boolean(inbound.rootId))
      return
    }

    if (command === 'mode') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
        return
      }
      if (!commandArgument) {
        await runtime.transport.replyText(inbound.messageId, `当前模式：${binding.collaborationMode ?? 'default'}。用法：/mode plan 或 /mode default`, Boolean(inbound.rootId))
        return
      }
      const collaborationMode = commandArgument.toLowerCase()
      if (collaborationMode !== 'plan' && collaborationMode !== 'default') {
        await runtime.transport.replyText(inbound.messageId, '用法：/mode plan 或 /mode default', Boolean(inbound.rootId))
        return
      }
      binding = { ...binding, collaborationMode }
      await this.dependencies.store.upsertBinding(binding)
      await runtime.transport.replyText(inbound.messageId, collaborationMode === 'plan'
        ? '已切换到 Plan 模式。后续消息可以发起 request_user_input 交互卡；使用 /mode default 可切回。'
        : '已切换到 Default 模式。', Boolean(inbound.rootId))
      return
    }

    if (command === 'permission' || command === 'yolo' || command === 'normal') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
        return
      }
      const requested = command === 'yolo' || command === 'normal' ? command : commandArgument.toLowerCase()
      if (!requested) {
        await runtime.transport.replyText(inbound.messageId, `当前权限：${(binding.permissionMode ?? 'yolo').toUpperCase()}。用法：/permission yolo 或 /permission normal`, Boolean(inbound.rootId))
        return
      }
      if (requested !== 'yolo' && requested !== 'normal') {
        await runtime.transport.replyText(inbound.messageId, '用法：/permission yolo 或 /permission normal', Boolean(inbound.rootId))
        return
      }
      binding = { ...binding, permissionMode: requested }
      await this.dependencies.store.upsertBinding(binding)
      await runtime.transport.replyText(inbound.messageId, requested === 'yolo'
        ? '已切换到 YOLO。后续飞书消息将不再请求操作审批，并使用完整工作区权限。'
        : '已切换到 Normal。后续飞书消息将恢复默认审批与沙箱策略。', Boolean(inbound.rootId))
      return
    }

    if (command === 'stop') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
        return
      }
      const active = this.activeTurnsByThread.get(binding.threadId)
      if (!active) {
        const externalTurnId = await this.dependencies.turns.findActiveTurnId?.(binding.threadId)
        if (externalTurnId) {
          try {
            await this.dependencies.turns.stopTurn?.({ threadId: binding.threadId, turnId: externalTurnId })
          } catch (error) {
            // The Web client can finish one turn and start another between the
            // read and interrupt RPCs. Re-read once so /stop targets the
            // authoritative current turn instead of failing on a stale id.
            const refreshedTurnId = await this.dependencies.turns.findActiveTurnId?.(binding.threadId)
            if (!refreshedTurnId || refreshedTurnId === externalTurnId) throw error
            await this.dependencies.turns.stopTurn?.({ threadId: binding.threadId, turnId: refreshedTurnId })
          }
          await runtime.transport.replyText(inbound.messageId, '已停止当前 Session 中由 Web 或其他入口启动的任务。', Boolean(inbound.rootId))
          return
        }
        await runtime.transport.replyText(inbound.messageId, '当前 Session 没有正在运行的回复。', Boolean(inbound.rootId))
        return
      }
      active.stopRequested = true
      try {
        await this.dependencies.turns.stopTurn?.({ threadId: binding.threadId, turnId: active.turnId })
      } catch (error) {
        active.stopRequested = false
        throw error
      }
      active.state = 'stopped'
      await this.patchActiveTurn(active, true)
      return
    }

    if (command === 'new' && binding) {
      const started = await this.dependencies.catalog.startSession({ cwd: binding.cwd, projectKey: binding.projectKey })
      binding = { ...binding, threadId: started.threadId, threadTitle: started.title || 'Untitled session' }
      await this.dependencies.store.upsertBinding(binding)
      await runtime.transport.replyCard(inbound.messageId, buildBoundSessionCard({
        projectLabel: binding.projectLabel,
        sessionTitle: binding.threadTitle,
        threadId: binding.threadId,
        bindingKey: binding.bindingKey,
        webUrl: this.dependencies.webThreadUrl?.(binding.threadId),
        requesterOpenId: binding.senderOpenId,
        permissionMode: binding.permissionMode ?? 'yolo',
      }), Boolean(inbound.rootId))
      return
    }

    if (command === 'rename') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
        return
      }
      if (!commandArgument) {
        await runtime.transport.replyText(inbound.messageId, '用法：/rename 新名称', Boolean(inbound.rootId))
        return
      }
      if (!this.dependencies.catalog.renameSession) {
        await runtime.transport.replyText(inbound.messageId, '当前网关不支持重命名 Session。', Boolean(inbound.rootId))
        return
      }
      await this.dependencies.catalog.renameSession({ threadId: binding.threadId, title: commandArgument })
      binding = { ...binding, threadTitle: commandArgument }
      await this.dependencies.store.upsertBinding(binding)
      await runtime.transport.replyText(inbound.messageId, `Session 已重命名为“${commandArgument}”。`, Boolean(inbound.rootId))
      return
    }

    if (command === 'archive') {
      if (!binding) {
        await runtime.transport.replyText(inbound.messageId, '当前对话尚未绑定 Session。', Boolean(inbound.rootId))
        return
      }
      if (!this.dependencies.catalog.archiveSession) {
        await runtime.transport.replyText(inbound.messageId, '当前网关不支持归档 Session。', Boolean(inbound.rootId))
        return
      }
      await this.dependencies.catalog.archiveSession({ threadId: binding.threadId })
      await this.dependencies.store.deleteBinding(inbound.botId, inbound.bindingKey)
      await runtime.transport.replyText(inbound.messageId, `Session“${binding.threadTitle}”已归档并解除绑定。`, Boolean(inbound.rootId))
      return
    }

    if ((command === 'sessions' || command === 'switch') && binding) {
      const projects = await this.dependencies.catalog.listProjects()
      const project = projects.find((row) => row.projectKey === binding?.projectKey)
      if (!project) {
        await runtime.transport.replyText(inbound.messageId, '绑定项目已隐藏或不存在，请使用 /project 重新选择。', Boolean(inbound.rootId))
        return
      }
      if (command === 'switch' && commandArgument) {
        const numericIndex = /^\d+$/u.test(commandArgument) ? Number(commandArgument) - 1 : -1
        const session = project.sessions.find((row) => row.threadId === commandArgument)
          ?? (numericIndex >= 0 ? project.sessions[numericIndex] : undefined)
          ?? project.sessions.find((row) => row.title === commandArgument)
        if (!session) {
          await runtime.transport.replyText(inbound.messageId, '没有找到该 Session。使用 /sessions 查看可选列表。', Boolean(inbound.rootId))
          return
        }
        binding = { ...binding, threadId: session.threadId, threadTitle: session.title || session.preview || session.threadId }
        await this.dependencies.store.upsertBinding(binding)
        await runtime.transport.replyCard(inbound.messageId, buildBoundSessionCard({
          projectLabel: binding.projectLabel,
          sessionTitle: binding.threadTitle,
          threadId: binding.threadId,
          bindingKey: binding.bindingKey,
          webUrl: this.dependencies.webThreadUrl?.(binding.threadId),
          requesterOpenId: binding.senderOpenId,
          permissionMode: binding.permissionMode ?? 'yolo',
        }), Boolean(inbound.rootId))
        return
      }
      const pending: FeishuPendingInbound = { ...inbound, prompt: '', createdAtIso: this.now().toISOString() }
      await this.dependencies.store.savePendingMessage(pending)
      await runtime.transport.replyCard(inbound.messageId, buildSessionSelectionCard({
        project,
        sessions: project.sessions,
        bindingKey: binding.bindingKey,
        pendingMessageId: inbound.messageId,
        requesterOpenId: binding.senderOpenId,
      }), Boolean(inbound.rootId))
      return
    }

    const isProjectSelectionCommand = command === 'project' || (!binding && (command === 'sessions' || command === 'switch'))
    if (isProjectSelectionCommand) binding = null

    if (!binding) {
      const pending: FeishuPendingInbound = {
        ...inbound,
        prompt: isProjectSelectionCommand ? '' : inbound.prompt,
        createdAtIso: this.now().toISOString(),
      }
      await this.dependencies.store.savePendingMessage(pending)
      const projects = await this.dependencies.catalog.listProjects()
      await this.replyCardWithFallback(runtime, inbound.messageId, inbound.chatId, buildProjectSelectionCard({
        projects,
        bindingKey: inbound.bindingKey,
        pendingMessageId: inbound.messageId,
        requesterOpenId: inbound.senderOpenId,
      }), inbound.rootId, inbound.chatType)
      return
    }
    await this.dependencies.store.touchBinding(inbound.botId, inbound.bindingKey)
    await this.enqueueMessage(binding.bindingKey, () => this.deliverPrompt(
      runtime,
      binding,
      inbound.messageId,
      inbound.prompt,
      inbound.resources,
      inbound.senderOpenId,
    ))
  }

  private async deliverPrompt(
    runtime: Runtime,
    binding: FeishuSessionBinding,
    sourceMessageId: string,
    prompt: string,
    resources: FeishuMessageResource[] = [],
    requesterOpenId = binding.senderOpenId,
  ): Promise<void> {
    if (!prompt.trim()) return
    const durableTurn = await this.dependencies.lifecycle?.createTurn({
      botId: binding.botId,
      bindingKey: binding.bindingKey,
      inboundMessageId: sourceMessageId,
      sessionId: binding.threadId,
      prompt,
      status: 'queued',
    })
    if (durableTurn && ['completed', 'failed', 'cancelled'].includes(durableTurn.status)) return
    if (durableTurn?.cardId && this.dependencies.lifecycle) {
      const existingCard = await this.dependencies.lifecycle.findCard(durableTurn.cardId)
      if (existingCard?.messageId) return
    }
    const cardMessageId = await this.replyCardWithFallback(runtime, sourceMessageId, binding.chatId, buildStreamingReplyCard({
      state: 'queued',
      projectLabel: binding.projectLabel,
      sessionTitle: binding.threadTitle,
      threadId: binding.threadId,
      webUrl: this.dependencies.webThreadUrl?.(binding.threadId),
    }), binding.rootId, binding.chatType)
    const active: ActiveTurnCard = {
      botId: binding.botId,
      binding,
      messageId: cardMessageId,
      turnId: '',
      content: '',
      state: 'queued',
      error: '',
      patchTimer: null,
      sourceMessageId,
      resources,
      requesterOpenId,
      startedAtIso: this.now().toISOString(),
      durableTurnId: durableTurn?.id,
      durableCardId: durableTurn ? (durableTurn.cardId ?? `turn:${durableTurn.id}`) : undefined,
      cardVersion: 0,
      stopRequested: false,
      preparedContent: '',
      replyImages: [],
      replyImageFingerprints: new Set(),
      replyImageUploads: [],
      replyPreparation: null,
      replyImageFailures: [],
    }
    await this.persistActiveCard(active)
    if (active.durableTurnId && active.durableCardId) {
      await this.dependencies.lifecycle?.updateTurn(active.durableTurnId, { cardId: active.durableCardId })
    }
    if (durableTurn?.status === 'running' && durableTurn.turnId) {
      active.turnId = durableTurn.turnId
      active.state = 'running'
      active.content = durableTurn.responseText
      if (!this.activeTurnsByThread.has(binding.threadId)) this.activeTurnsByThread.set(binding.threadId, active)
      return
    }
    if (this.activeTurnsByThread.has(binding.threadId)) {
      const queue = this.queuedTurnsByThread.get(binding.threadId) ?? []
      queue.push({ active, prompt, sourceMessageId, resources })
      this.queuedTurnsByThread.set(binding.threadId, queue)
      return
    }
    let externallyBusy = this.externalBusyThreads.has(binding.threadId)
    if (!externallyBusy && this.dependencies.turns.isThreadBusy) {
      try {
        externallyBusy = await this.dependencies.turns.isThreadBusy(binding.threadId)
      } catch (error) {
        // A newly created app-server thread is intentionally unreadable until
        // its first turn materializes it. More generally, a failed advisory
        // busy check must not strand a durable Feishu turn forever: turn/start
        // is authoritative and will report an active-turn conflict if needed.
        this.log('warn', `Unable to read Codex thread busy state; attempting the turn directly: ${String(error)}`)
      }
    }
    if (externallyBusy) {
      this.externalBusyThreads.add(binding.threadId)
      const queue = this.queuedTurnsByThread.get(binding.threadId) ?? []
      queue.push({ active, prompt, sourceMessageId, resources })
      this.queuedTurnsByThread.set(binding.threadId, queue)
      return
    }
    this.activeTurnsByThread.set(binding.threadId, active)
    await this.startPreparedTurn(active, prompt, sourceMessageId, resources)
  }

  private async deliverPendingMessages(runtime: Runtime, binding: FeishuSessionBinding, first: FeishuPendingInbound): Promise<void> {
    let pending: FeishuPendingInbound | null = first
    while (pending) {
      await this.deliverPrompt(runtime, binding, pending.messageId, pending.prompt, pending.resources, pending.senderOpenId)
      await this.dependencies.store.deletePendingMessage(binding.botId, pending.messageId)
      pending = await this.dependencies.store.peekPendingMessage(binding.botId, binding.bindingKey)
    }
  }

  private async restorePendingDeliveries(): Promise<void> {
    const bindings = await this.dependencies.store.listBindings()
    for (const binding of bindings) {
      const runtime = this.runtimes.get(binding.botId)
      if (!runtime) continue
      const claimToken = randomUUID()
      const pending = await this.dependencies.store.claimPendingMessage(binding.botId, binding.bindingKey, claimToken)
      if (!pending) continue
      try {
        // A bound conversation may have a new /project or /sessions picker in
        // progress. Only drain when the persisted selection intent proves this
        // exact binding was committed for the pending message.
        if (pending.sessionSelection?.createdThreadId !== binding.threadId) continue
        await this.deliverPendingMessages(runtime, binding, pending)
      } finally {
        await this.dependencies.store.releasePendingMessageClaim(binding.botId, claimToken)
      }
    }
  }

  private async startPreparedTurn(
    active: ActiveTurnCard,
    prompt: string,
    sourceMessageId: string,
    resources: FeishuMessageResource[] = [],
  ): Promise<void> {
    try {
      const prepared = await this.prepareTurnAttachments(active.botId, sourceMessageId, prompt, resources)
      const result = await this.dependencies.turns.startTurn({
        threadId: active.binding.threadId,
        prompt: prepared.prompt,
        localImagePaths: prepared.localImagePaths,
        source: 'feishu',
        metadata: {
          feishuBotId: active.binding.botId,
          feishuBindingKey: active.binding.bindingKey,
          feishuMessageId: sourceMessageId,
          feishuSenderOpenId: active.requesterOpenId,
        },
        collaborationMode: active.binding.collaborationMode ?? 'default',
        permissionMode: active.binding.permissionMode ?? 'yolo',
      })
      active.turnId = result.turnId
      // Notifications can overtake the turn/start RPC response. Do not revive
      // a turn that already reached a terminal state while the RPC was in
      // flight; its terminal patch has already released the shared queue.
      if (['completed', 'failed', 'stopped'].includes(active.state)) return
      active.state = 'running'
      if (active.durableTurnId) {
        await this.dependencies.lifecycle?.updateTurn(active.durableTurnId, {
          turnId: result.turnId,
          status: 'running',
        })
      }
      this.scheduleStreamPatch(active)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/active|in.?progress|already.+turn|conflict/iu.test(message)) {
        active.state = 'queued'
        active.error = ''
        this.externalBusyThreads.add(active.binding.threadId)
        if (this.activeTurnsByThread.get(active.binding.threadId) === active) {
          this.activeTurnsByThread.delete(active.binding.threadId)
        }
        const queue = this.queuedTurnsByThread.get(active.binding.threadId) ?? []
        queue.unshift({ active, prompt, sourceMessageId, resources })
        this.queuedTurnsByThread.set(active.binding.threadId, queue)
        if (active.durableTurnId) await this.dependencies.lifecycle?.updateTurn(active.durableTurnId, { status: 'queued' })
        await this.persistActiveCard(active)
        return
      }
      active.state = 'failed'
      active.error = message
      if (active.durableTurnId) {
        await this.dependencies.lifecycle?.updateTurn(active.durableTurnId, {
          turnId: active.turnId,
          status: 'failed',
          lastError: active.error,
        })
      }
      await this.patchActiveTurn(active, true)
    }
  }

  private async startNextQueuedTurn(threadId: string): Promise<void> {
    if (this.activeTurnsByThread.has(threadId)) return
    if (this.externalBusyThreads.has(threadId)) return
    let externallyBusy = false
    if (this.dependencies.turns.isThreadBusy) {
      try {
        externallyBusy = await this.dependencies.turns.isThreadBusy(threadId)
      } catch (error) {
        this.log('warn', `Unable to read queued Codex thread busy state; attempting the turn directly: ${String(error)}`)
      }
    }
    if (externallyBusy) {
      this.externalBusyThreads.add(threadId)
      return
    }
    const queue = this.queuedTurnsByThread.get(threadId)
    const next = queue?.shift()
    if (!next) {
      this.queuedTurnsByThread.delete(threadId)
      return
    }
    if (!queue?.length) this.queuedTurnsByThread.delete(threadId)
    this.activeTurnsByThread.set(threadId, next.active)
    await this.startPreparedTurn(next.active, next.prompt, next.sourceMessageId, next.resources)
  }

  private async prepareTurnAttachments(
    botId: string,
    sourceMessageId: string,
    prompt: string,
    resources: FeishuMessageResource[],
  ): Promise<{ prompt: string; localImagePaths: string[] }> {
    if (resources.length === 0) return { prompt, localImagePaths: [] }
    const runtime = this.runtimes.get(botId)
    const localImagePaths: string[] = []
    const fileNotes: string[] = []
    const failureNotes: string[] = []
    for (const resource of resources) {
      const displayName = resource.name.replace(/[\r\n\t]+/gu, ' ').trim() || resource.type
      try {
        if (resource.downloadUnsupportedReason) throw new Error(resource.downloadUnsupportedReason)
        if (resource.type === 'sticker') throw new Error('飞书 API 暂不支持下载表情资源')
        if (!runtime?.transport.downloadResource) throw new Error('当前飞书连接不支持下载附件')
        const downloaded = await runtime.transport.downloadResource(resource.messageId?.trim() || sourceMessageId, resource)
        if (downloaded.type === 'image') localImagePaths.push(downloaded.path)
        else fileNotes.push(`- ${displayName}: ${downloaded.path}`)
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/gu, ' ').trim()
        failureNotes.push(`- ${displayName}: ${message || '未知错误'}`)
        this.log('warn', `Failed to download Feishu ${resource.type} ${resource.key}: ${message}`)
      }
    }
    const additions: string[] = []
    if (fileNotes.length > 0) additions.push(`已下载的飞书附件（本地绝对路径）：\n${fileNotes.join('\n')}`)
    if (failureNotes.length > 0) additions.push(`飞书附件下载失败（正文仍已发送）：\n${failureNotes.join('\n')}`)
    return {
      prompt: [prompt.trim(), ...additions].filter(Boolean).join('\n\n'),
      localImagePaths,
    }
  }

  private async restoreDurableLifecycle(): Promise<void> {
    const lifecycle = this.dependencies.lifecycle
    if (!lifecycle) return
    // The store returns newest first. Reverse to restore FIFO, then stably put
    // running rows before queued rows so a same-millisecond timestamp tie can
    // never start a queued turn before re-establishing the authoritative active
    // turn for that thread. SQLite rowid is the store's deterministic tie-break.
    const turns = (await lifecycle.listTurns({ limit: 500 }))
      .filter((turn) => turn.status === 'queued' || turn.status === 'running')
      .reverse()
      .sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running'))
    const queuedThreads = new Set<string>()
    for (const turn of turns) {
      const binding = await this.dependencies.store.findBinding(turn.botId, turn.bindingKey)
      const card = turn.cardId ? await lifecycle.findCard(turn.cardId) : null
      if (!binding || !card?.messageId) {
        await lifecycle.updateTurn(turn.id, {
          status: 'failed',
          lastError: '无法恢复飞书任务：Session 绑定或消息卡片已不存在',
        })
        continue
      }
      const state = asRecord(card.state)
      const sourceMessageId = readString(state?.sourceMessageId) || turn.inboundMessageId
      const requesterOpenId = readString(state?.requesterOpenId)
      if (!requesterOpenId) {
        await lifecycle.updateTurn(turn.id, {
          status: 'failed',
          lastError: '无法恢复飞书任务：缺少原始请求者身份',
        })
        continue
      }
      const resources = Array.isArray(state?.resources)
        ? state.resources.filter((item): item is FeishuMessageResource => Boolean(asRecord(item)?.key && asRecord(item)?.name))
        : []
      const replyImages = Array.isArray(state?.replyImages)
        ? state.replyImages.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({
            imageKey: readString(item.imageKey),
            alt: readString(item.alt) || 'AI 生成图片',
            fingerprint: readString(item.fingerprint),
          }))
          .filter((item) => item.imageKey && item.fingerprint)
        : []
      const replyImageFailures = Array.isArray(state?.replyImageFailures)
        ? state.replyImageFailures.filter((item): item is string => typeof item === 'string').slice(0, 9)
        : []
      const active: ActiveTurnCard = {
        botId: turn.botId,
        binding,
        messageId: card.messageId,
        turnId: turn.turnId,
        content: turn.responseText || readString(state?.content),
        state: turn.status === 'running' ? 'running' : 'queued',
        error: turn.lastError || readString(state?.error),
        patchTimer: null,
        sourceMessageId,
        resources,
        requesterOpenId,
        startedAtIso: readString(state?.startedAtIso) || turn.createdAtIso,
        durableTurnId: turn.id,
        durableCardId: card.id,
        cardVersion: card.version,
        stopRequested: turn.status === 'cancelled',
        preparedContent: readString(state?.preparedContent),
        replyImages,
        replyImageFingerprints: new Set(replyImages.map((image) => image.fingerprint)),
        replyImageUploads: [],
        replyPreparation: null,
        replyImageFailures,
      }
      if (turn.status === 'running' && turn.turnId && this.dependencies.turns.readTurnState) {
        try {
          const authoritative = await this.dependencies.turns.readTurnState(turn.sessionId, turn.turnId)
          if (authoritative.status !== 'running') {
            active.content = authoritative.responseText || active.content
            active.error = authoritative.error || (authoritative.status === 'missing' ? 'Codex 运行态已失效' : '')
            active.state = authoritative.status === 'failed' || authoritative.status === 'missing'
              ? 'failed'
              : authoritative.status === 'cancelled'
                ? 'stopped'
                : 'completed'
            await lifecycle.updateTurn(turn.id, {
              status: active.state === 'failed' ? 'failed' : active.state === 'stopped' ? 'cancelled' : 'completed',
              responseText: active.content,
              lastError: active.error,
            })
            await this.prepareActiveReply(active)
            await this.persistActiveCard(active)
            const runtime = this.runtimes.get(active.botId)
            await runtime?.transport.updateCard(active.messageId, buildStreamingReplyCard({
              state: active.state,
              content: active.preparedContent || active.content,
              error: active.error,
              projectLabel: active.binding.projectLabel,
              sessionTitle: active.binding.threadTitle,
              threadId: active.binding.threadId,
              webUrl: this.dependencies.webThreadUrl?.(active.binding.threadId),
            })).catch((error) => this.log('warn', `Failed to reconcile Feishu card ${active.messageId}: ${String(error)}`))
            continue
          }
        } catch (error) {
          this.log('warn', `Failed to reconcile Codex turn ${turn.turnId}; keeping it active: ${String(error)}`)
        }
      }
      if (turn.status === 'running' && !this.activeTurnsByThread.has(turn.sessionId)) {
        this.activeTurnsByThread.set(turn.sessionId, active)
        continue
      }
      const queue = this.queuedTurnsByThread.get(turn.sessionId) ?? []
      queue.push({ active, prompt: turn.prompt, sourceMessageId, resources })
      this.queuedTurnsByThread.set(turn.sessionId, queue)
      queuedThreads.add(turn.sessionId)
    }
    for (const threadId of queuedThreads) {
      if (!this.activeTurnsByThread.has(threadId)) await this.startNextQueuedTurn(threadId)
    }
  }

  private async persistActiveCard(active: ActiveTurnCard): Promise<void> {
    if (!active.durableCardId || !this.dependencies.lifecycle) return
    active.cardVersion += 1
    const terminal = ['completed', 'failed', 'stopped'].includes(active.state)
    const status: StoredFeishuCard['status'] = active.state === 'failed'
      ? 'failed'
      : active.state === 'stopped'
        ? 'cancelled'
        : terminal
          ? 'completed'
          : active.state === 'queued'
            ? 'creating'
            : 'streaming'
    const state: DurableTurnCardState = {
      kind: 'turn',
      binding: active.binding,
      sourceMessageId: active.sourceMessageId,
      resources: active.resources,
      streamState: active.state,
      content: active.content,
      preparedContent: active.preparedContent || undefined,
      replyImages: active.replyImages.length > 0 ? active.replyImages : undefined,
      replyImageFailures: active.replyImageFailures.length > 0 ? active.replyImageFailures : undefined,
      error: active.error,
      requesterOpenId: active.requesterOpenId,
      startedAtIso: active.startedAtIso,
    }
    await this.dependencies.lifecycle.upsertCard({
      id: active.durableCardId,
      botId: active.botId,
      bindingKey: active.binding.bindingKey,
      messageId: active.messageId,
      purpose: 'turn',
      status,
      version: active.cardVersion,
      state,
    })
  }

  private async persistRequestCard(pending: PendingRequestCard, status: StoredFeishuCard['status']): Promise<void> {
    if (!this.dependencies.lifecycle) return
    const id = `request:${pending.botId}:${pending.requestId}`
    const previous = await this.dependencies.lifecycle.findCard(id)
    await this.dependencies.lifecycle.upsertCard({
      id,
      botId: pending.botId,
      bindingKey: pending.binding.bindingKey,
      messageId: pending.messageId,
      purpose: pending.kind,
      status,
      version: (previous?.version ?? 0) + 1,
      state: pending,
    })
  }

  private async restoreDurableRequests(): Promise<void> {
    const lifecycle = this.dependencies.lifecycle
    if (!lifecycle) return
    const cards = await lifecycle.listCards({ limit: 500 })
    const staleBefore = this.now().getTime() - 24 * 60 * 60_000
    for (const card of cards) {
      if (!['approval', 'user_input'].includes(card.purpose) || !['creating', 'streaming'].includes(card.status)) continue
      const state = asRecord(card.state)
      const requestId = readString(state?.requestId)
      const requesterOpenId = readString(state?.requesterOpenId)
      const bindingKey = readString(asRecord(state?.binding)?.bindingKey || card.bindingKey)
      const binding = await this.dependencies.store.findBinding(card.botId, bindingKey)
      const requestStillPending = requestId && this.dependencies.serverRequests?.isPending
        ? await this.dependencies.serverRequests.isPending(requestId)
        : false
      if (!requestId || !requesterOpenId || !binding || !card.messageId || !requestStillPending || Date.parse(card.updatedAtIso) < staleBefore) {
        await lifecycle.upsertCard({
          id: card.id,
          botId: card.botId,
          bindingKey: card.bindingKey,
          messageId: card.messageId,
          purpose: card.purpose,
          status: 'failed',
          version: card.version + 1,
          state: { ...state, invalidatedAtIso: this.now().toISOString(), reason: 'request expired during restart' },
        })
        if (card.messageId) {
          const runtime = this.runtimes.get(card.botId)
          await runtime?.transport.updateCard(card.messageId, buildResolvedRequestCard({
            title: readString(state?.title) || '请求已失效',
            summary: readString(state?.summary),
            outcome: 'resolved',
            operatorOpenId: '',
            resolvedAtIso: this.now().toISOString(),
          })).catch(() => undefined)
        }
        continue
      }
      const questions = Array.isArray(state?.questions)
        ? state.questions.filter((question): question is FeishuUserInputQuestion => Boolean(asRecord(question)?.id))
        : []
      const rawSelections = asRecord(state?.selections) ?? {}
      const selections = Object.fromEntries(Object.entries(rawSelections).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      const pending: PendingRequestCard = {
        requestId,
        botId: card.botId,
        binding,
        messageId: card.messageId,
        requesterOpenId,
        kind: card.purpose === 'approval' ? 'approval' : 'user_input',
        title: readString(state?.title),
        summary: readString(state?.summary),
        questions,
        selections,
      }
      this.pendingRequestCards.set(requestKey(card.botId, requestId), pending)
    }
  }

  private scheduleStreamPatch(active: ActiveTurnCard): void {
    if (active.patchTimer) return
    active.patchTimer = setTimeout(() => {
      active.patchTimer = null
      void this.patchActiveTurn(active, false)
    }, this.dependencies.streamPatchMs ?? 350)
    active.patchTimer.unref?.()
  }

  private async patchActiveTurn(active: ActiveTurnCard, terminal: boolean): Promise<void> {
    if (terminal && active.patchTimer) { clearTimeout(active.patchTimer); active.patchTimer = null }
    if (terminal) await this.prepareActiveReply(active)
    const runtime = this.runtimes.get(active.botId)
    if (active.durableTurnId) {
      const status: StoredFeishuTurn['status'] = active.state === 'failed'
        ? 'failed'
        : active.state === 'stopped'
          ? 'cancelled'
          : active.state === 'completed'
            ? 'completed'
            : active.state === 'queued'
              ? 'queued'
              : 'running'
      await this.dependencies.lifecycle?.updateTurn(active.durableTurnId, {
        turnId: active.turnId,
        status,
        responseText: active.content,
        lastError: active.error,
      })
    }
    await this.persistActiveCard(active)
    try {
      await runtime?.transport.updateCard(active.messageId, buildStreamingReplyCard({
        state: active.state,
        content: active.preparedContent || active.content,
        error: active.error,
        projectLabel: active.binding.projectLabel,
        sessionTitle: active.binding.threadTitle,
        threadId: active.binding.threadId,
        webUrl: this.dependencies.webThreadUrl?.(active.binding.threadId),
      }), { version: active.cardVersion, terminal })
    } catch (error) {
      this.log('warn', `Failed to update Feishu stream card ${active.messageId}: ${String(error)}`)
    } finally {
      // Card delivery is best effort. A failed patch must never leave the shared
      // Codex thread permanently busy and block every queued Feishu message.
      if (terminal && this.activeTurnsByThread.get(active.binding.threadId) === active) {
        this.activeTurnsByThread.delete(active.binding.threadId)
        void this.startNextQueuedTurn(active.binding.threadId)
      }
    }
  }

  private enqueueMessage(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.messageQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(work).finally(() => {
      if (this.messageQueues.get(key) === current) this.messageQueues.delete(key)
    })
    this.messageQueues.set(key, current)
    return current
  }

  private async freezeExternallyResolvedRequest(requestId: string): Promise<void> {
    const pending = Array.from(this.pendingRequestCards.values()).find((row) => row.requestId === requestId)
    if (!pending) return
    const runtime = this.runtimes.get(pending.botId)
    if (!runtime) return
    try {
      await this.persistRequestCard(pending, 'completed')
      this.pendingRequestCards.delete(requestKey(pending.botId, requestId))
      await runtime.transport.updateCard(pending.messageId, buildResolvedRequestCard({
        title: pending.title,
        summary: pending.summary,
        outcome: 'resolved',
        operatorOpenId: '',
        resolvedAtIso: this.now().toISOString(),
      }))
    } catch (error) {
      this.log('warn', `Failed to freeze resolved Feishu request card ${pending.messageId}: ${String(error)}`)
    }
  }

  private isOperatorAuthorized(bot: FeishuBotDefinition, operatorOpenId: string, requesterOpenId: string): boolean {
    if (!operatorOpenId) return false
    return operatorOpenId === requesterOpenId || bot.allowedOpenIds.includes(operatorOpenId)
  }

  private isInboundAuthorized(bot: FeishuBotDefinition, inbound: NormalizedInbound): boolean {
    if (!inbound.senderOpenId) return false
    if (!bot.allowAllUsers && !bot.allowedOpenIds.includes(inbound.senderOpenId)) return false
    const allowedChatIds = bot.allowedChatIds ?? []
    if (inbound.chatType === 'group' && allowedChatIds.length > 0 && !allowedChatIds.includes(inbound.chatId)) return false
    return true
  }

  private async processAccessRequest(runtime: Runtime, inbound: NormalizedInbound): Promise<void> {
    const bot = runtime.bot
    // A group-chat restriction is a hard boundary, not an invitation flow.
    const allowedChatIds = bot.allowedChatIds ?? []
    if (inbound.chatType === 'group' && allowedChatIds.length > 0 && !allowedChatIds.includes(inbound.chatId)) return
    // Never react to ambient group traffic from an unauthorized member.
    if (inbound.chatType === 'group' && !inbound.explicitlyMentioned) return
    // A message that also names another user/app is not an unambiguous request to this bot.
    if (inbound.hasNonBotMention) return
    if (bot.allowAllUsers || bot.allowedOpenIds.includes(inbound.senderOpenId)) return
    const ownerOpenId = bot.allowedOpenIds[0]
    if (!ownerOpenId || !runtime.transport.sendUserCard || !this.dependencies.access) return
    if (!await this.dependencies.store.claimEvent(bot.botId, inbound.eventKey)) return
    try {
      const notify = async () => {
        await runtime.transport.sendUserCard!(ownerOpenId, buildAccessRequestCard({
          requesterOpenId: inbound.senderOpenId,
          chatId: inbound.chatId,
          chatType: inbound.chatType,
          requestToken: signAccessRequest(bot, inbound, this.now().getTime()),
        }))
        await this.replyTextWithFallback(
          runtime,
          inbound.messageId,
          inbound.chatId,
          '当前账号尚未加入机器人白名单，已向管理员发送访问申请。批准后请重试。',
          inbound.rootId,
          inbound.chatType,
        )
      }
      if (runtime.transport.withDeliveryScope) {
        await runtime.transport.withDeliveryScope(`${bot.botId}:access-request:${inbound.eventKey}`, notify)
      } else {
        await notify()
      }
      await this.dependencies.store.completeEvent?.(bot.botId, inbound.eventKey)
    } catch (error) {
      await this.dependencies.store.failEvent?.(
        bot.botId,
        inbound.eventKey,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  private async replyCardWithFallback(
    runtime: Runtime,
    sourceMessageId: string,
    chatId: string,
    card: FeishuCard,
    rootId: string,
    chatType: 'p2p' | 'group',
  ): Promise<string> {
    if (chatType === 'p2p' && !rootId) return runtime.transport.sendCard(chatId, card)
    try {
      return await runtime.transport.replyCard(sourceMessageId, card, Boolean(rootId))
    } catch (error) {
      if (!(error instanceof FeishuPermanentDeliveryError)
        || !/230011|230110|withdraw|deleted|撤回|删除/iu.test(error.message)) throw error
      if (rootId && rootId !== sourceMessageId) {
        try {
          return await runtime.transport.replyCard(rootId, card, true)
        } catch (rootError) {
          if (!(rootError instanceof FeishuPermanentDeliveryError)
            || !/230011|230110|withdraw|deleted|撤回|删除/iu.test(rootError.message)) throw rootError
        }
      }
      this.log('warn', `[feishu:${runtime.bot.botId}] reply source ${sourceMessageId} unavailable; falling back to chat send`)
      return runtime.transport.sendCard(chatId, card)
    }
  }

  private async replyTextWithFallback(
    runtime: Runtime,
    sourceMessageId: string,
    chatId: string,
    message: string,
    rootId: string,
    chatType: 'p2p' | 'group',
  ): Promise<string> {
    if (chatType === 'p2p' && !rootId) return runtime.transport.sendText(chatId, message)
    try {
      return await runtime.transport.replyText(sourceMessageId, message, Boolean(rootId))
    } catch (error) {
      if (!(error instanceof FeishuPermanentDeliveryError)
        || !/230011|230110|withdraw|deleted|撤回|删除/iu.test(error.message)) throw error
      if (rootId && rootId !== sourceMessageId) {
        try {
          return await runtime.transport.replyText(rootId, message, true)
        } catch (rootError) {
          if (!(rootError instanceof FeishuPermanentDeliveryError)
            || !/230011|230110|withdraw|deleted|撤回|删除/iu.test(rootError.message)) throw rootError
        }
      }
      this.log('warn', `[feishu:${runtime.bot.botId}] reply source ${sourceMessageId} unavailable; falling back to chat text`)
      return runtime.transport.sendText(chatId, message)
    }
  }

  private schedule(work: () => void): void {
    if (this.dependencies.schedule) this.dependencies.schedule(work)
    else setImmediate(work)
  }

  private now(): Date { return this.dependencies.now?.() ?? new Date() }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    this.dependencies.logger?.[level](message)
  }
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs))
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createFeishuBotService(dependencies: FeishuBotServiceDependencies): FeishuBotService {
  return new FeishuBotService(dependencies)
}
