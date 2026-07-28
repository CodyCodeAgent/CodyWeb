import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { FeishuCard } from './feishuCards.js'
import type { FeishuDownloadedResource } from './feishuAttachments.js'
import type { FeishuMessageResource } from './feishuMessageParser.js'
import type { FeishuImageUpload } from './feishuReplyImages.js'
import type {
  FeishuBotDefinition,
  FeishuTransport,
  FeishuTransportHandlers,
  FeishuTransportState,
} from './feishuBotService.js'
import {
  appendFeishuAuditLog,
  claimFeishuOutbox,
  deadLetterFeishuOutbox,
  enqueueFeishuOutbox,
  markFeishuOutboxSent,
  retryFeishuOutbox,
  supersedeFeishuCardUpdates,
  isFeishuCardUpdateCurrent,
  type FeishuOutboxItem,
} from './feishuBotStore.js'

export const FEISHU_OUTBOX_KINDS = {
  sendText: 'transport.send_text',
  replyText: 'transport.reply_text',
  sendCard: 'transport.send_card',
  replyCard: 'transport.reply_card',
  updateCard: 'transport.update_card',
  sendUserCard: 'transport.send_user_card',
} as const

type FeishuOutboxKind = typeof FEISHU_OUTBOX_KINDS[keyof typeof FEISHU_OUTBOX_KINDS]

type DeliveryResult = { remoteMessageId: string | null }

export class FeishuPermanentDeliveryError extends Error {
  readonly code = 'FEISHU_PERMANENT_DELIVERY'
  constructor(message: string, readonly outboxId: string) {
    super(message)
    this.name = 'FeishuPermanentDeliveryError'
  }
}

export type FeishuReliableTransportStore = {
  enqueue(input: {
    id?: string
    botId: string
    kind: FeishuOutboxKind
    targetId: string
    payload: unknown
    dedupeKey?: string | null
  }): Promise<FeishuOutboxItem>
  claim(input: { botId: string; limit: number; leaseMs: number }): Promise<FeishuOutboxItem[]>
  markSent(id: string, remoteMessageId?: string | null): Promise<boolean>
  retry(id: string, error: string, availableAtIso: string): Promise<boolean>
  deadLetter(id: string, error: string): Promise<boolean>
  supersedeCardUpdates(input: { botId: string; targetId: string; keepId: string; cardVersion: number }): Promise<string[]>
  isCardUpdateCurrent(item: FeishuOutboxItem): Promise<boolean>
  audit(input: {
    botId: string
    action: string
    targetType: string
    targetId: string
    success: boolean
    metadata: unknown
    error?: string
  }): Promise<unknown>
}

const sqliteStore: FeishuReliableTransportStore = {
  enqueue: (input) => enqueueFeishuOutbox(input),
  claim: (input) => claimFeishuOutbox(input),
  markSent: (id, remoteMessageId) => markFeishuOutboxSent(id, remoteMessageId),
  retry: (id, error, availableAtIso) => retryFeishuOutbox(id, error, availableAtIso),
  deadLetter: (id, error) => deadLetterFeishuOutbox(id, error),
  supersedeCardUpdates: (input) => supersedeFeishuCardUpdates(input),
  isCardUpdateCurrent: (item) => isFeishuCardUpdateCurrent(item),
  audit: (input) => appendFeishuAuditLog(input),
}

type Waiter = {
  resolve: (value: DeliveryResult) => void
  reject: (error: Error) => void
}

type DeliveryScope = {
  key: string
  sequence: number
}

type ReliableTransportOptions = {
  store?: FeishuReliableTransportStore
  retryBaseMs?: number
  retryMaxMs?: number
  pumpIntervalMs?: number
  leaseMs?: number
  batchSize?: number
  now?: () => Date
  logger?: Pick<Console, 'warn' | 'error'>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Feishu outbox payload')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Feishu outbox string field')
  return value
}

function boolean(value: unknown): boolean {
  return value === true
}

/**
 * Adds a SQLite-backed, leased outbox to a Feishu transport.
 *
 * Calls made by the live service are attempted immediately so their original
 * return contract is preserved. Failed and in-flight calls remain durable and
 * are reclaimed by the periodic pump (including after a process restart).
 */
export class FeishuReliableTransport implements FeishuTransport {
  private readonly store: FeishuReliableTransportStore
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly pumpIntervalMs: number
  private readonly leaseMs: number
  private readonly batchSize: number
  private readonly now: () => Date
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly deliveryScope = new AsyncLocalStorage<DeliveryScope>()
  private readonly cardVersions = new Map<string, number>()
  private pumpPromise: Promise<void> | null = null
  private pumpTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly bot: FeishuBotDefinition,
    private readonly inner: FeishuTransport,
    options: ReliableTransportOptions = {},
  ) {
    this.store = options.store ?? sqliteStore
    this.retryBaseMs = Math.max(250, options.retryBaseMs ?? 1_000)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 5 * 60_000)
    this.pumpIntervalMs = Math.max(250, options.pumpIntervalMs ?? 2_000)
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 60_000)
    this.batchSize = Math.min(100, Math.max(1, options.batchSize ?? 20))
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? console
  }

  getBotIdentity(): Promise<{ openId: string; name: string }> {
    if (!this.inner.getBotIdentity) return Promise.resolve({ openId: this.bot.botOpenId ?? '', name: this.bot.botName ?? '' })
    return this.inner.getBotIdentity()
  }

  getChatMode(chatId: string, options?: { forceRefresh?: boolean }): Promise<'group' | 'topic' | 'p2p'> {
    return this.inner.getChatMode?.(chatId, options) ?? Promise.resolve('group')
  }

  getMessage(messageId: string, options?: { userCardContent?: boolean }): Promise<unknown> {
    if (!this.inner.getMessage) return Promise.reject(new Error('Feishu transport does not support message lookup'))
    return this.inner.getMessage(messageId, options)
  }

  async start(handlers: FeishuTransportHandlers): Promise<void> {
    this.closed = false
    await this.inner.start({
      ...handlers,
      onState: (state, error) => {
        handlers.onState(state, error)
        if (state === 'connected') this.schedulePump()
      },
    })
    this.startPumpTimer()
    this.schedulePump()
  }

  close(): void {
    this.closed = true
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    this.pumpTimer = null
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error('Feishu transport closed'))
    }
    this.waiters.clear()
    this.inner.close()
  }

  getState(): FeishuTransportState {
    return this.inner.getState()
  }

  sendText(chatId: string, text: string): Promise<string> {
    return this.observeCallerPromise(
      this.enqueueAndWait(FEISHU_OUTBOX_KINDS.sendText, chatId, { text })
        .then((result) => result.remoteMessageId ?? ''),
    )
  }

  replyText(messageId: string, text: string, replyInThread = false): Promise<string> {
    return this.observeCallerPromise(
      this.enqueueAndWait(FEISHU_OUTBOX_KINDS.replyText, messageId, { text, replyInThread })
        .then((result) => result.remoteMessageId ?? ''),
    )
  }

  sendCard(chatId: string, card: FeishuCard): Promise<string> {
    return this.observeCallerPromise(
      this.enqueueAndWait(FEISHU_OUTBOX_KINDS.sendCard, chatId, { card })
        .then((result) => result.remoteMessageId ?? ''),
    )
  }

  sendUserCard(openId: string, card: FeishuCard): Promise<string> {
    return this.observeCallerPromise(
      this.enqueueAndWait(FEISHU_OUTBOX_KINDS.sendUserCard, openId, { card })
        .then((result) => result.remoteMessageId ?? ''),
    )
  }

  replyCard(messageId: string, card: FeishuCard, replyInThread = false): Promise<string> {
    return this.observeCallerPromise(
      this.enqueueAndWait(FEISHU_OUTBOX_KINDS.replyCard, messageId, { card, replyInThread })
        .then((result) => result.remoteMessageId ?? ''),
    )
  }

  updateCard(messageId: string, card: FeishuCard, delivery?: { version?: number; terminal?: boolean }): Promise<void> {
    return this.observeCallerPromise(this.enqueueCardUpdate(messageId, card, delivery))
  }

  private async enqueueCardUpdate(
    messageId: string,
    card: FeishuCard,
    delivery?: { version?: number; terminal?: boolean },
  ): Promise<void> {
    const current = this.cardVersions.get(messageId) ?? 0
    const cardVersion = Math.max(current + 1, delivery?.version ?? 0)
    this.cardVersions.set(messageId, cardVersion)
    await this.enqueueAndWait(FEISHU_OUTBOX_KINDS.updateCard, messageId, {
      card,
      cardVersion,
      terminal: delivery?.terminal === true,
    })
  }

  /**
   * Preserve the rejection contract for callers while ensuring a forgotten or
   * detached delivery promise cannot become a process-fatal unhandled
   * rejection. The returned promise is unchanged, so awaited callers still
   * receive FeishuPermanentDeliveryError and can apply their normal fallback.
   */
  private observeCallerPromise<T>(operation: Promise<T>): Promise<T> {
    void operation.catch(() => undefined)
    return operation
  }

  /**
   * Gives every outbound operation inside one inbound event a stable identity.
   * Re-running the same event starts the sequence at zero again, so SQLite's
   * unique dedupe key returns the original logical delivery instead of adding
   * another one. Separate user events may still send identical content.
   */
  withDeliveryScope<T>(stableKey: string, work: () => Promise<T>): Promise<T> {
    return this.deliveryScope.run({ key: stableKey, sequence: 0 }, work)
  }

  downloadResource(messageId: string, resource: FeishuMessageResource): Promise<FeishuDownloadedResource> {
    if (!this.inner.downloadResource) return Promise.reject(new Error('Feishu transport does not support resource downloads'))
    return this.inner.downloadResource(messageId, resource)
  }

  uploadImage(image: FeishuImageUpload): Promise<string> {
    if (!this.inner.uploadImage) return Promise.reject(new Error('Feishu transport does not support image uploads'))
    return this.inner.uploadImage(image)
  }

  /** Runs one recovery pass now. Exposed for startup orchestration and tests. */
  async flush(): Promise<void> {
    await this.drain()
  }

  private async enqueueAndWait(kind: FeishuOutboxKind, targetId: string, payload: unknown): Promise<DeliveryResult> {
    if (this.closed) throw new Error('Feishu transport is closed')
    const id = randomUUID()
    const dedupeKey = this.nextDedupeKey(kind, targetId)
    const providerUuid = this.providerUuid(dedupeKey ?? id)
    const item = await this.store.enqueue({
      id,
      botId: this.bot.botId,
      kind,
      targetId,
      payload: { ...record(payload), providerUuid },
      dedupeKey,
    })
    if (kind === FEISHU_OUTBOX_KINDS.updateCard) {
      const row = record(item.payload)
      const cardVersion = typeof row.cardVersion === 'number' ? row.cardVersion : 0
      const supersededIds = await this.store.supersedeCardUpdates({ botId: this.bot.botId, targetId, keepId: item.id, cardVersion })
      for (const supersededId of supersededIds) {
        for (const waiter of this.waiters.get(supersededId) ?? []) waiter.resolve({ remoteMessageId: null })
        this.waiters.delete(supersededId)
      }
    }
    if (item.status === 'sent') return { remoteMessageId: item.remoteMessageId }
    const outcome = new Promise<DeliveryResult>((resolve, reject) => {
      const waiters = this.waiters.get(item.id) ?? []
      waiters.push({ resolve, reject })
      this.waiters.set(item.id, waiters)
    })
    this.schedulePump()
    return outcome
  }

  private nextDedupeKey(kind: FeishuOutboxKind, targetId: string): string | null {
    const scope = this.deliveryScope.getStore()
    if (!scope) return null
    const sequence = scope.sequence++
    return `delivery:${scope.key}:${String(sequence)}:${kind}:${targetId}`
  }

  private providerUuid(operationKey: string): string {
    return `cw_${createHash('sha256').update(`${this.bot.botId}:${operationKey}`).digest('hex').slice(0, 40)}`
  }

  private startPumpTimer(): void {
    if (this.pumpTimer) return
    this.pumpTimer = setInterval(() => this.schedulePump(), this.pumpIntervalMs)
    this.pumpTimer.unref?.()
  }

  private schedulePump(): void {
    if (this.closed) return
    void this.drain().catch((error) => {
      this.logger.error(`[feishu:${this.bot.botId}] outbox pump failed: ${String(error)}`)
    })
  }

  private drain(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise
    this.pumpPromise = this.runPump().finally(() => {
      this.pumpPromise = null
      // An enqueue can race with the final empty claim. A live waiter proves
      // that another immediate pass is required.
      if (this.waiters.size > 0 && !this.closed) queueMicrotask(() => this.schedulePump())
    })
    return this.pumpPromise
  }

  private async runPump(): Promise<void> {
    while (!this.closed) {
      const items = await this.store.claim({ botId: this.bot.botId, limit: this.batchSize, leaseMs: this.leaseMs })
      if (items.length === 0) return
      for (const item of items) {
        // Leave already-claimed work under its lease when shutdown races with
        // a batch. The next process will reclaim it after lease expiry.
        if (this.closed) return
        await this.deliver(item)
      }
      if (items.length < this.batchSize) return
    }
  }

  private async deliver(item: FeishuOutboxItem): Promise<void> {
    try {
      const remoteMessageId = await this.dispatch(item)
      const marked = await this.store.markSent(item.id, remoteMessageId)
      if (!marked) throw new Error(`Feishu outbox item disappeared before completion: ${item.id}`)
      for (const waiter of this.waiters.get(item.id) ?? []) waiter.resolve({ remoteMessageId })
      this.waiters.delete(item.id)
      await this.audit(item, true, remoteMessageId).catch((error) => {
        this.logger.warn(`[feishu:${this.bot.botId}] could not audit successful delivery: ${String(error)}`)
      })
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value))
      const terminalReason = this.terminalReason(error, item.attempts)
      if (terminalReason) {
        await this.store.deadLetter(item.id, terminalReason).catch((storeError) => {
          this.logger.error(`[feishu:${this.bot.botId}] could not dead-letter outbox item: ${String(storeError)}`)
        })
        for (const waiter of this.waiters.get(item.id) ?? []) {
          waiter.reject(new FeishuPermanentDeliveryError(terminalReason, item.id))
        }
        this.waiters.delete(item.id)
        await this.audit(item, false, null, terminalReason, true).catch(() => undefined)
        return
      }
      const availableAtIso = new Date(this.now().getTime() + this.retryDelayMs(item.attempts)).toISOString()
      await this.store.retry(item.id, error.message, availableAtIso).catch((storeError) => {
        this.logger.error(`[feishu:${this.bot.botId}] could not persist outbox retry: ${String(storeError)}`)
      })
      // A transient delivery failure is already durably owned by the outbox.
      // Keep live callers pending across retries instead of unwinding the
      // inbound handler and repeating side effects such as starting/stopping a
      // Codex turn. Shutdown remains the explicit cancellation boundary.
      await this.audit(item, false, null, error.message).catch((auditError) => {
        this.logger.warn(`[feishu:${this.bot.botId}] could not audit failed delivery: ${String(auditError)}`)
      })
    }
  }

  private terminalReason(error: Error, attempts: number): string | null {
    const detail = error as Error & { code?: string | number; status?: number; response?: { status?: number } }
    const message = error.message || String(error)
    const status = detail.status ?? detail.response?.status
    const codeText = String(detail.code ?? '')
    const combined = `${codeText} ${message}`
    const permanentFeishuCodes = ['230011', '230110', '234001', '234003', '234004']
    if (permanentFeishuCodes.some((code) => combined.includes(code))) return `Permanent Feishu delivery failure: ${message}`
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
      return `Permanent Feishu HTTP ${String(status)} delivery failure: ${message}`
    }
    const temporary = status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
      || /ECONN|ETIMEDOUT|EAI_AGAIN|ENET|socket|network|timeout|temporar|rate.?limit|429|\b5\d\d\b/iu.test(combined)
    if (!temporary && attempts >= 10) return `Feishu delivery abandoned after ${String(attempts)} attempts: ${message}`
    return null
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, Math.min(20, attempts - 1)))
  }

  private async dispatch(item: FeishuOutboxItem): Promise<string | null> {
    const payload = record(item.payload)
    const providerUuid = typeof payload.providerUuid === 'string' && payload.providerUuid
      ? payload.providerUuid
      : this.providerUuid(item.dedupeKey ?? item.id)
    switch (item.kind) {
      case FEISHU_OUTBOX_KINDS.sendText:
        return this.inner.sendText(item.targetId, string(payload.text), providerUuid)
      case FEISHU_OUTBOX_KINDS.replyText:
        return this.inner.replyText(item.targetId, string(payload.text), boolean(payload.replyInThread), providerUuid)
      case FEISHU_OUTBOX_KINDS.sendCard:
        return this.inner.sendCard(item.targetId, record(payload.card) as FeishuCard, providerUuid)
      case FEISHU_OUTBOX_KINDS.sendUserCard:
        if (!this.inner.sendUserCard) throw new Error('Feishu transport does not support private user cards')
        return this.inner.sendUserCard(item.targetId, record(payload.card) as FeishuCard, providerUuid)
      case FEISHU_OUTBOX_KINDS.replyCard:
        return this.inner.replyCard(item.targetId, record(payload.card) as FeishuCard, boolean(payload.replyInThread), providerUuid)
      case FEISHU_OUTBOX_KINDS.updateCard:
        if (!await this.store.isCardUpdateCurrent(item)) return null
        await this.inner.updateCard(item.targetId, record(payload.card) as FeishuCard)
        return null
      default:
        throw new Error(`Unsupported Feishu outbox kind: ${item.kind}`)
    }
  }

  private audit(
    item: FeishuOutboxItem,
    success: boolean,
    remoteMessageId: string | null,
    error = '',
    deadLettered = false,
  ): Promise<unknown> {
    return this.store.audit({
      botId: this.bot.botId,
      action: success ? 'delivery.sent' : deadLettered ? 'delivery.dead_lettered' : 'delivery.retry_scheduled',
      targetType: 'feishu_message',
      targetId: remoteMessageId || item.targetId,
      success,
      metadata: { outboxId: item.id, kind: item.kind, attempts: item.attempts, availableAtIso: item.availableAtIso, deadLettered },
      error,
    })
  }
}
