import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeishuCard } from './feishuCards'
import type { FeishuMessageResource } from './feishuMessageParser'
import type {
  FeishuBotDefinition,
  FeishuTransport,
  FeishuTransportHandlers,
  FeishuTransportState,
} from './feishuBotService'
import {
  claimFeishuOutbox,
  enqueueFeishuOutbox,
  listFeishuAuditLogs,
  listFeishuOutbox,
  retryFeishuOutbox,
} from './feishuBotStore'
import { FEISHU_OUTBOX_KINDS, FeishuReliableTransport } from './feishuReliableTransport'
import { withLocalDatabase } from './localDatabase'

let tempDir = ''
let transports: FeishuReliableTransport[] = []

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-feishu-outbox-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
  transports = []
})

afterEach(async () => {
  for (const transport of transports) transport.close()
  delete process.env.CODY_WEB_UI_SETTINGS_DB
  await rm(tempDir, { recursive: true, force: true })
})

class FakeTransport implements FeishuTransport {
  state: FeishuTransportState = 'idle'
  failNextText = false
  readonly calls: Array<{ method: string; target: string; value: unknown; replyInThread?: boolean }> = []
  readonly downloads: Array<{ messageId: string; resource: FeishuMessageResource }> = []
  readonly providerUuids: string[] = []
  nextTextError: Error | null = null
  failNextUpdate = false

  async start(handlers: FeishuTransportHandlers): Promise<void> {
    this.state = 'connected'
    handlers.onState('connected')
  }

  close(): void { this.state = 'idle' }
  getState(): FeishuTransportState { return this.state }

  async sendText(chatId: string, text: string, providerUuid?: string): Promise<string> {
    this.calls.push({ method: 'sendText', target: chatId, value: text })
    if (providerUuid) this.providerUuids.push(providerUuid)
    if (this.nextTextError) { const error = this.nextTextError; this.nextTextError = null; throw error }
    if (this.failNextText) { this.failNextText = false; throw new Error('temporary network error') }
    return `remote-${this.calls.length}`
  }

  async replyText(messageId: string, text: string, replyInThread = false): Promise<string> {
    this.calls.push({ method: 'replyText', target: messageId, value: text, replyInThread })
    return `remote-${this.calls.length}`
  }

  async sendCard(chatId: string, card: FeishuCard): Promise<string> {
    this.calls.push({ method: 'sendCard', target: chatId, value: card })
    return `remote-${this.calls.length}`
  }

  async sendUserCard(openId: string, card: FeishuCard): Promise<string> {
    this.calls.push({ method: 'sendUserCard', target: openId, value: card })
    return `remote-${this.calls.length}`
  }

  async replyCard(messageId: string, card: FeishuCard, replyInThread = false): Promise<string> {
    this.calls.push({ method: 'replyCard', target: messageId, value: card, replyInThread })
    return `remote-${this.calls.length}`
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    this.calls.push({ method: 'updateCard', target: messageId, value: card })
    if (this.failNextUpdate) { this.failNextUpdate = false; throw new Error('temporary patch outage') }
  }

  async downloadResource(messageId: string, resource: FeishuMessageResource) {
    this.downloads.push({ messageId, resource })
    return { ...resource, path: `/tmp/${resource.name}`, sizeBytes: 42 }
  }
}

const bot: FeishuBotDefinition = {
  botId: 'reliable-bot', appId: 'cli_test', appSecret: 'secret', enabled: true, allowedOpenIds: [],
}

function reliable(inner: FakeTransport): FeishuReliableTransport {
  const value = new FeishuReliableTransport(bot, inner, { pumpIntervalMs: 60_000, logger: { warn: vi.fn(), error: vi.fn() } })
  transports.push(value)
  return value
}

const handlers: FeishuTransportHandlers = {
  onMessage: vi.fn(), onCardAction: vi.fn(), onState: vi.fn(),
}

describe('FeishuReliableTransport', () => {
  it('persists live sends before dispatch and does not redeliver completed items', async () => {
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)

    await expect(transport.sendText('chat-1', 'hello')).resolves.toBe('remote-1')
    expect(await listFeishuOutbox({ botId: bot.botId })).toMatchObject([{
      kind: FEISHU_OUTBOX_KINDS.sendText,
      targetId: 'chat-1',
      status: 'sent',
      attempts: 1,
      remoteMessageId: 'remote-1',
    }])

    await transport.flush()
    await transport.flush()
    expect(inner.calls).toHaveLength(1)
    expect(await listFeishuAuditLogs({ botId: bot.botId })).toMatchObject([{
      action: 'delivery.sent', success: true, targetId: 'remote-1',
    }])
  })

  it('recovers expired in-flight work when a new transport starts', async () => {
    await enqueueFeishuOutbox({
      botId: bot.botId,
      kind: FEISHU_OUTBOX_KINDS.replyCard,
      targetId: 'source-message',
      payload: { card: { header: { title: 'Recovered' } }, replyInThread: true },
    })
    await claimFeishuOutbox({ botId: bot.botId, leaseMs: 60_000 })
    await withLocalDatabase((db) => {
      db.prepare("UPDATE feishu_outbox SET lease_expires_at_iso = '2000-01-01T00:00:00.000Z' WHERE bot_id = ?").run(bot.botId)
    })

    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)
    await transport.flush()

    expect(inner.calls).toEqual([{
      method: 'replyCard',
      target: 'source-message',
      value: { header: { title: 'Recovered' } },
      replyInThread: true,
    }])
    expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.status).toBe('sent')
  })

  it('keeps the live call pending while retaining the operation for exponential-backoff retry', async () => {
    const inner = new FakeTransport()
    inner.failNextText = true
    const transport = reliable(inner)
    await transport.start(handlers)

    const delivery = transport.sendText('chat-2', 'retry me')
    await vi.waitFor(async () => {
      expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.status).toBe('failed')
    })
    const failed = (await listFeishuOutbox({ botId: bot.botId }))[0]
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'temporary network error' })
    expect(new Date(failed!.availableAtIso).getTime()).toBeGreaterThan(new Date(failed!.updatedAtIso).getTime())

    // Make the scheduled retry due without sleeping, as a restarted process would see it.
    await retryFeishuOutbox(failed!.id, failed!.lastError, '2000-01-01T00:00:00.000Z')
    await transport.flush()
    await expect(delivery).resolves.toBe('remote-2')
    expect(inner.calls.filter((call) => call.method === 'sendText')).toHaveLength(2)
    expect((await listFeishuOutbox({ botId: bot.botId }))[0]).toMatchObject({
      status: 'sent', attempts: 2, remoteMessageId: 'remote-2', lastError: '',
    })
  })

  it('deduplicates a retried inbound scope and resolves all callers from one logical outbox item', async () => {
    const inner = new FakeTransport()
    inner.failNextText = true
    const transport = reliable(inner)
    await transport.start(handlers)

    const first = transport.withDeliveryScope('bot:event-1', () => transport.sendText('chat', 'same event'))
    await vi.waitFor(async () => {
      expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.status).toBe('failed')
    })
    const second = transport.withDeliveryScope('bot:event-1', () => transport.sendText('chat', 'same event'))
    await vi.waitFor(async () => {
      expect(await listFeishuOutbox({ botId: bot.botId })).toHaveLength(1)
    })
    const item = (await listFeishuOutbox({ botId: bot.botId }))[0]!
    expect(item.dedupeKey).toContain('bot:event-1:0:transport.send_text:chat')

    await retryFeishuOutbox(item.id, item.lastError, '2000-01-01T00:00:00.000Z')
    await transport.flush()
    await expect(Promise.all([first, second])).resolves.toEqual(['remote-2', 'remote-2'])
    expect(inner.calls.filter((call) => call.method === 'sendText')).toHaveLength(2)
    expect(await listFeishuOutbox({ botId: bot.botId })).toHaveLength(1)
  })

  it('does not deduplicate identical content from different inbound events', async () => {
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)

    await transport.withDeliveryScope('bot:event-a', () => transport.sendText('chat', 'repeatable text'))
    await transport.withDeliveryScope('bot:event-b', () => transport.sendText('chat', 'repeatable text'))

    expect(inner.calls.filter((call) => call.method === 'sendText')).toHaveLength(2)
    const items = await listFeishuOutbox({ botId: bot.botId })
    expect(items).toHaveLength(2)
    expect(new Set(items.map((item) => item.dedupeKey)).size).toBe(2)
  })

  it('durably maps replies, cards and patches to their original transport operations', async () => {
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)

    await transport.replyText('m1', 'thread reply', true)
    await transport.sendCard('chat', { card: 1 })
    await transport.replyCard('m2', { card: 2 }, false)
    await transport.updateCard('m3', { card: 3 })

    expect(inner.calls).toEqual([
      { method: 'replyText', target: 'm1', value: 'thread reply', replyInThread: true },
      { method: 'sendCard', target: 'chat', value: { card: 1 } },
      { method: 'replyCard', target: 'm2', value: { card: 2 }, replyInThread: false },
      { method: 'updateCard', target: 'm3', value: { card: 3 } },
    ])
    expect(await listFeishuOutbox({ botId: bot.botId, status: 'sent' })).toHaveLength(4)
  })

  it('durably delivers private approval cards by verified open id', async () => {
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)
    await transport.sendUserCard('ou_requester', { private: true })
    expect(inner.calls).toEqual([{ method: 'sendUserCard', target: 'ou_requester', value: { private: true } }])
    expect((await listFeishuOutbox({ botId: bot.botId }))[0]).toMatchObject({
      kind: FEISHU_OUTBOX_KINDS.sendUserCard, targetId: 'ou_requester', status: 'sent',
    })
  })

  it('passes read-only attachment downloads straight through without creating outbox work', async () => {
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)
    const resource: FeishuMessageResource = { type: 'image', key: 'img_1', name: 'diagram.png' }

    await expect(transport.downloadResource('om_source', resource)).resolves.toEqual({
      ...resource,
      path: '/tmp/diagram.png',
      sizeBytes: 42,
    })
    expect(inner.downloads).toEqual([{ messageId: 'om_source', resource }])
    expect(await listFeishuOutbox({ botId: bot.botId })).toEqual([])
  })

  it('reuses the provider uuid after an ambiguous remote success', async () => {
    const inner = new FakeTransport()
    const remoteIds = new Map<string, string>()
    let first = true
    inner.sendText = vi.fn(async (_chatId: string, _text: string, providerUuid?: string) => {
      expect(providerUuid).toMatch(/^cw_[a-f0-9]{40}$/u)
      const existing = remoteIds.get(providerUuid!)
      if (existing) return existing
      remoteIds.set(providerUuid!, 'remote-once')
      if (first) { first = false; throw Object.assign(new Error('socket closed after remote accepted'), { code: 'ECONNRESET' }) }
      return 'remote-once'
    })
    const transport = reliable(inner)
    await transport.start(handlers)

    const delivery = transport.withDeliveryScope('event-ambiguous', () => transport.sendText('chat', 'once'))
    await vi.waitFor(async () => expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.status).toBe('failed'))
    const item = (await listFeishuOutbox({ botId: bot.botId }))[0]!
    await retryFeishuOutbox(item.id, item.lastError, '2000-01-01T00:00:00.000Z')
    await transport.flush()

    await expect(delivery).resolves.toBe('remote-once')
    expect(inner.sendText).toHaveBeenCalledTimes(2)
    const uuids = vi.mocked(inner.sendText).mock.calls.map((call) => call[2])
    expect(uuids[0]).toBe(uuids[1])
    expect(remoteIds.size).toBe(1)
  })

  it('dead-letters permanent Feishu errors and rejects the live caller', async () => {
    const inner = new FakeTransport()
    inner.nextTextError = Object.assign(new Error('message was withdrawn (230011)'), { code: 230011 })
    const transport = reliable(inner)
    await transport.start(handlers)

    await expect(transport.sendText('chat', 'cannot deliver')).rejects.toThrow('Permanent Feishu delivery failure')
    const item = (await listFeishuOutbox({ botId: bot.botId }))[0]!
    expect(item).toMatchObject({ status: 'failed', attempts: 1 })
    expect(item.deadLetteredAtIso).not.toBeNull()
    expect(await listFeishuAuditLogs({ botId: bot.botId })).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'delivery.dead_lettered', success: false }),
    ]))
    await transport.flush()
    expect(inner.calls.filter((call) => call.method === 'sendText')).toHaveLength(1)
  })

  it('does not emit an unhandled rejection when a detached delivery permanently fails', async () => {
    const inner = new FakeTransport()
    inner.sendUserCard = vi.fn(async () => {
      throw Object.assign(new Error('Request failed with status code 400'), { status: 400 })
    })
    const transport = reliable(inner)
    await transport.start(handlers)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      const delivery = transport.sendUserCard('ou_owner', { access: 'request' })
      await vi.waitFor(async () => {
        expect((await listFeishuOutbox({ botId: bot.botId }))[0]).toMatchObject({
          kind: FEISHU_OUTBOX_KINDS.sendUserCard,
          status: 'failed',
          attempts: 1,
        })
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })

      expect(unhandled).toEqual([])
      await expect(delivery).rejects.toThrow('Permanent Feishu HTTP 400 delivery failure')
      expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.deadLetteredAtIso).not.toBeNull()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('supersedes an old failed card patch so it cannot overwrite a terminal version', async () => {
    const inner = new FakeTransport()
    inner.failNextUpdate = true
    const transport = reliable(inner)
    await transport.start(handlers)

    const oldPatch = transport.updateCard('card-stream', { text: 'running-old' }, { version: 2 })
    await vi.waitFor(async () => {
      expect((await listFeishuOutbox({ botId: bot.botId }))[0]?.status).toBe('failed')
    })
    const terminalPatch = transport.updateCard('card-stream', { text: 'completed-final' }, { version: 3, terminal: true })
    await expect(Promise.all([oldPatch, terminalPatch])).resolves.toEqual([undefined, undefined])
    await transport.flush()

    const updates = inner.calls.filter((call) => call.method === 'updateCard')
    expect(updates.map((call) => call.value)).toEqual([{ text: 'running-old' }, { text: 'completed-final' }])
    const items = await listFeishuOutbox({ botId: bot.botId })
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.status === 'sent')).toBe(true)
  })

  it('allocates the next card version from SQLite after restart', async () => {
    const old = await enqueueFeishuOutbox({
      botId: bot.botId,
      kind: FEISHU_OUTBOX_KINDS.updateCard,
      targetId: 'card-restart',
      payload: { card: { text: 'old' }, cardVersion: 3, providerUuid: 'cw_old' },
      availableAtIso: '2999-01-01T00:00:00.000Z',
    })
    const inner = new FakeTransport()
    const transport = reliable(inner)
    await transport.start(handlers)
    await transport.updateCard('card-restart', { text: 'new after restart' })

    const items = await listFeishuOutbox({ botId: bot.botId })
    const newer = items.find((item) => item.id !== old.id)!
    expect((newer.payload as { cardVersion: number }).cardVersion).toBe(4)
    expect(items.find((item) => item.id === old.id)?.status).toBe('sent')
    expect(inner.calls.filter((call) => call.method === 'updateCard').map((call) => call.value))
      .toEqual([{ text: 'new after restart' }])
  })
})
