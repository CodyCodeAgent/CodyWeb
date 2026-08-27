import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFeishuAuditLog,
  claimFeishuEvent,
  claimFeishuInboundEvent,
  claimFeishuOutbox,
  claimPendingFeishuMessage,
  cleanupFeishuOperationalData,
  completeFeishuInboundEvent,
  createFeishuTurn,
  deleteFeishuBot,
  deleteFeishuBinding,
  deleteFeishuAutoRoute,
  deletePendingFeishuMessage,
  enqueueFeishuOutbox,
  failFeishuInboundEvent,
  findFeishuBinding,
  findFeishuBot,
  grantFeishuBotUserAccess,
  findFeishuCard,
  findFeishuTurn,
  listFeishuAuditLogs,
  listFeishuBindings,
  listFeishuAutoRoutes,
  listFeishuBots,
  listFeishuCards,
  listFeishuOutbox,
  listFeishuTurns,
  markFeishuOutboxSent,
  publicFeishuBotConfig,
  readFeishuBotConfig,
  retryFeishuOutbox,
  requeueFailedFeishuOutbox,
  releasePendingFeishuMessageClaim,
  savePendingFeishuMessage,
  setFeishuAutoRouteScenarioPackage,
  takePendingFeishuMessage,
  touchFeishuBinding,
  touchFeishuAutoRoute,
  updateFeishuAutoRouteDefinition,
  updateFeishuBotRuntime,
  updateFeishuTurn,
  upsertFeishuBinding,
  upsertFeishuAutoRoute,
  upsertFeishuBot,
  upsertFeishuCard,
} from './feishuBotStore'
import { withLocalDatabase } from './localDatabase'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-feishu-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  delete process.env.CODY_WEB_UI_SETTINGS_DB
  await rm(tempDir, { recursive: true, force: true })
})

async function bot(id: string, appId = `cli_${id}`) {
  return upsertFeishuBot({
    id,
    name: `${id} bot`,
    appId,
    appSecret: `secret-${id}`,
    platform: 'feishu',
    tenantId: `tenant-${id}`,
    tenantName: `${id} enterprise`,
    enabled: true,
    allowedOpenIds: [' ou_a ', 'ou_a', 'ou_b'],
    allowedChatIds: [' oc_a ', 'oc_a', 'oc_b'],
    defaultProjectKey: `/repo/${id}`,
  })
}

describe('feishuBotStore bots', () => {
  it('supports multiple bot configs, secret redaction, and runtime independently', async () => {
    const alpha = await bot('alpha')
    const beta = await bot('beta')

    expect(alpha).toMatchObject({
      id: 'alpha', botId: 'alpha', name: 'alpha bot', status: 'connecting',
      platform: 'feishu', tenantId: 'tenant-alpha', tenantName: 'alpha enterprise',
      connectionState: 'connecting', allowAllUsers: false, allowedOpenIds: ['ou_a', 'ou_b'],
      allowedChatIds: ['oc_a', 'oc_b'], p2pMode: 'topic',
    })
    expect(beta.appSecret).toBe('secret-beta')
    await withLocalDatabase((db) => {
      const stored = db.prepare('SELECT app_secret AS secret FROM feishu_bots WHERE bot_id = ?').get('beta') as { secret: string }
      expect(stored.secret).not.toContain('secret-beta')
      expect(stored.secret).toMatch(/^cody-credential:v1:/)
    })
    expect((await listFeishuBots()).map((value) => value.id)).toEqual(['alpha', 'beta'])

    const publicAlpha = publicFeishuBotConfig(alpha)
    expect(publicAlpha.secretConfigured).toBe(true)
    expect(publicAlpha.hasAppSecret).toBe(true)
    expect(publicAlpha).not.toHaveProperty('appSecret')

    const connected = await updateFeishuBotRuntime({
      botId: 'alpha', status: 'connected', botOpenId: 'ou_bot', botName: 'Alpha Robot',
      lastHeartbeatAtIso: '2026-07-18T01:00:00.000Z',
    })
    expect(connected).toMatchObject({
      status: 'connected', connectionState: 'connected', botOpenId: 'ou_bot', botName: 'Alpha Robot',
      lastHeartbeatAtIso: '2026-07-18T01:00:00.000Z',
    })
    expect(connected.lastConnectedAtIso).not.toBeNull()
    expect((await findFeishuBot('beta'))?.status).toBe('connecting')

    const preserved = await upsertFeishuBot({
      id: 'alpha', name: 'renamed', appId: 'cli_alpha', enabled: false,
      allowAllUsers: true, allowedOpenIds: [],
    })
    expect(preserved.appSecret).toBe('secret-alpha')
    expect(preserved).toMatchObject({ platform: 'feishu', tenantId: 'tenant-alpha', tenantName: 'alpha enterprise' })
    expect(preserved.allowAllUsers).toBe(true)
    expect(preserved.allowedChatIds).toEqual(['oc_a', 'oc_b'])
    expect(preserved.p2pMode).toBe('topic')
    expect(preserved.status).toBe('disconnected')

    await expect(deleteFeishuBot('beta')).resolves.toBe(true)
    await expect(findFeishuBot('beta')).resolves.toBeNull()
  })

  it('persists the private-chat mode and defaults legacy configs to topic mode', async () => {
    await bot('routing')
    await expect(findFeishuBot('routing')).resolves.toMatchObject({ p2pMode: 'topic' })
    await upsertFeishuBot({ id: 'routing', appId: 'cli_routing', enabled: true, p2pMode: 'chat' })
    await expect(findFeishuBot('routing')).resolves.toMatchObject({ p2pMode: 'chat' })
  })

  it('keeps the original single-bot API useful', async () => {
    const initial = await readFeishuBotConfig()
    expect(initial).toMatchObject({ id: 'default', enabled: false, status: 'disconnected' })
    await updateFeishuBotRuntime({ connectionState: 'reconnecting', lastError: 'network' })
    expect(await readFeishuBotConfig()).toMatchObject({ status: 'connecting', lastError: 'network' })

    await expect(claimFeishuEvent('event-once')).resolves.toBe(true)
    await expect(claimFeishuEvent('event-once')).resolves.toBe(false)
  })

  it('persists exact access grants atomically without enabling broad access', async () => {
    await bot('access')
    await upsertFeishuBot({ id: 'access', appId: 'cli_access', enabled: true, allowAllUsers: true })

    await grantFeishuBotUserAccess('access', 'ou_guest')
    await grantFeishuBotUserAccess('access', 'ou_guest')

    await expect(findFeishuBot('access')).resolves.toMatchObject({
      allowAllUsers: false,
      allowedOpenIds: ['ou_a', 'ou_b', 'ou_guest'],
      appSecret: 'secret-access',
    })
  })
})

describe('feishuBotStore bindings and pending messages', () => {
  it('persists one idempotent fixed-session auto route and cleans up its synthetic binding', async () => {
    await bot('routes')
    const input = {
      botId: 'routes', chatId: 'oc_alerts', name: '差异播报', sourceSenderId: 'ou_alert_bot',
      sourceSenderType: 'app' as const, cardTitle: '【平台】差异播报', requiredKeywords: ['任务ID', '校验结果'],
      fingerprintKey: 'fingerprint-1', instruction: '分析根因', projectKey: '/repo', projectCwd: '/repo',
      projectName: 'Repo', sessionId: 'session-1', sessionTitle: 'Alert triage', createdByOpenId: 'ou_owner',
    }
    const first = await upsertFeishuAutoRoute(input)
    const updated = await upsertFeishuAutoRoute({ ...input, sessionId: 'session-2', sessionTitle: 'Persistent triage' })
    expect(updated.id).toBe(first.id)
    expect(updated.bindingKey).toBe(first.bindingKey)
    expect(await listFeishuAutoRoutes({ botId: 'routes', chatId: 'oc_alerts', enabled: true })).toMatchObject([
      { sessionId: 'session-2', matchCount: 0, requiredKeywords: ['任务ID', '校验结果'] },
    ])
    await expect(updateFeishuAutoRouteDefinition({
      id: updated.id, requiredKeywords: ['任务ID'], instruction: '仅定位差异根因',
    })).resolves.toMatchObject({ requiredKeywords: ['任务ID'], instruction: '仅定位差异根因', fingerprintKey: 'fingerprint-1' })
    await expect(setFeishuAutoRouteScenarioPackage(updated.id, 'scenario-alert-triage')).resolves.toMatchObject({
      id: updated.id, scenarioPackageId: 'scenario-alert-triage',
    })
    await upsertFeishuBinding({
      botId: 'routes', bindingKey: updated.bindingKey, chatId: 'oc_alerts', chatType: 'group',
      projectCwd: '/repo', projectName: 'Repo', sessionId: 'session-2', sessionTitle: 'Persistent triage',
    })
    await expect(touchFeishuAutoRoute(updated.id)).resolves.toBe(true)
    expect((await listFeishuAutoRoutes({ botId: 'routes' }))[0]).toMatchObject({ matchCount: 1 })
    await expect(deleteFeishuAutoRoute(updated.id)).resolves.toBe(true)
    await expect(findFeishuBinding(updated.bindingKey, 'routes')).resolves.toBeNull()
  })

  it('isolates the same conversation key by bot and maps to shared Codex sessions', async () => {
    await bot('alpha')
    await bot('beta')
    await upsertFeishuBinding({
      botId: 'alpha', bindingKey: 'chat-1:topic-1', scopeType: 'topic', chatId: 'chat-1',
      rootId: 'topic-1', projectCwd: '/repo/shared', projectName: 'Shared',
      sessionId: 'session-1', sessionTitle: 'Existing session', collaborationMode: 'plan', userOpenId: 'ou_user',
    })
    await upsertFeishuBinding({
      botId: 'beta', bindingKey: 'chat-1:topic-1', scopeType: 'topic', chatId: 'chat-1',
      rootId: 'topic-1', projectCwd: '/repo/other', projectName: 'Other',
      sessionId: 'session-2', sessionTitle: 'New session', userOpenId: 'ou_user',
    })

    expect(await findFeishuBinding('chat-1:topic-1', 'alpha')).toMatchObject({
      id: 'chat-1:topic-1', botId: 'alpha', botName: 'alpha bot', scopeType: 'topic',
      projectCwd: '/repo/shared', cwd: '/repo/shared', sessionId: 'session-1', threadId: 'session-1',
      collaborationMode: 'plan',
      permissionMode: 'yolo',
    })
    expect((await listFeishuBindings({ botId: 'beta' }))[0]).toMatchObject({ sessionId: 'session-2', permissionMode: 'yolo' })
    expect(await listFeishuBindings({ sessionId: 'session-1' })).toHaveLength(1)
    await expect(touchFeishuBinding('chat-1:topic-1', 'alpha')).resolves.toBe(true)
    expect((await findFeishuBinding('chat-1:topic-1', 'alpha'))?.lastMessageAtIso).not.toBeNull()

    await expect(deleteFeishuBinding('chat-1:topic-1', 'alpha')).resolves.toBe(true)
    await expect(findFeishuBinding('chat-1:topic-1', 'alpha')).resolves.toBeNull()
    await expect(findFeishuBinding('chat-1:topic-1', 'beta')).resolves.not.toBeNull()
  })

  it('queues multiple pending messages FIFO and deduplicates Feishu message ids', async () => {
    await bot('alpha')
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'binding', messageId: 'm1', prompt: 'one', payload: { n: 1 }, createdAtIso: '2026-01-01T00:00:00.000Z' })
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'binding', messageId: 'm2', prompt: 'two', payload: { n: 2 }, createdAtIso: '2026-01-01T00:00:01.000Z' })
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'binding', messageId: 'm1', prompt: 'one updated', payload: { n: 3 }, createdAtIso: '2026-01-01T00:00:02.000Z' })
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'binding', messageId: 'm3', prompt: 'delete exact', payload: { n: 4 }, createdAtIso: '2026-01-01T00:00:03.000Z' })
    await expect(deletePendingFeishuMessage('m3', 'alpha')).resolves.toBe(true)

    await expect(claimPendingFeishuMessage('binding', 'alpha', 'claim-a')).resolves.toMatchObject({ messageId: 'm1' })
    await expect(claimPendingFeishuMessage('binding', 'alpha', 'claim-b')).resolves.toBeNull()
    await withLocalDatabase((db) => {
      db.prepare("UPDATE feishu_pending_messages_v2 SET claim_expires_at_iso = '2000-01-01T00:00:00.000Z' WHERE claim_token = 'claim-a'").run()
    })
    await expect(claimPendingFeishuMessage('binding', 'alpha', 'claim-b')).resolves.toMatchObject({ messageId: 'm1' })
    await expect(releasePendingFeishuMessageClaim('claim-b', 'alpha')).resolves.toBe(true)

    await expect(takePendingFeishuMessage('binding', 'alpha')).resolves.toMatchObject({ messageId: 'm1', prompt: 'one updated', payload: { n: 3 } })
    await expect(takePendingFeishuMessage('binding', 'alpha')).resolves.toMatchObject({ messageId: 'm2' })
    await expect(takePendingFeishuMessage('binding', 'alpha')).resolves.toBeNull()
  })
})

describe('feishuBotStore reliable delivery', () => {
  it('deduplicates completed inbound events and permits retry after failure', async () => {
    await bot('alpha')
    const first = await claimFeishuInboundEvent({
      botId: 'alpha', eventKey: 'event-1', eventType: 'im.message.receive_v1',
      messageId: 'm1', chatId: 'chat', payload: { text: 'hello' },
    })
    expect(first).toMatchObject({ status: 'processing', attempts: 1, payload: { text: 'hello' } })
    await expect(claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'event-1' })).resolves.toBeNull()

    await expect(failFeishuInboundEvent('event-1', 'temporary', 'alpha')).resolves.toBe(true)
    const retried = await claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'event-1', payload: { text: 'again' } })
    expect(retried).toMatchObject({ status: 'processing', attempts: 2, payload: { text: 'again' } })
    await expect(completeFeishuInboundEvent('event-1', 'alpha')).resolves.toBe(true)
    await expect(claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'event-1' })).resolves.toBeNull()

    await expect(claimFeishuInboundEvent({ botId: 'beta', eventKey: 'event-1' })).resolves.not.toBeNull()
  })

  it('provides a leased, retryable and idempotent outbox', async () => {
    await bot('alpha')
    const first = await enqueueFeishuOutbox({
      botId: 'alpha', bindingKey: 'binding', kind: 'message.create', targetId: 'chat',
      payload: { text: 'hello' }, dedupeKey: 'turn-1:final',
    })
    const duplicate = await enqueueFeishuOutbox({
      botId: 'alpha', kind: 'message.create', targetId: 'chat', payload: { text: 'duplicate' },
      dedupeKey: 'turn-1:final',
    })
    expect(duplicate.id).toBe(first.id)

    const claimed = await claimFeishuOutbox({ botId: 'alpha', limit: 10 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: first.id, status: 'sending', attempts: 1 })
    await expect(claimFeishuOutbox({ botId: 'alpha' })).resolves.toEqual([])

    await expect(retryFeishuOutbox(first.id, 'rate limited')).resolves.toBe(true)
    const retried = await claimFeishuOutbox({ botId: 'alpha' })
    expect(retried[0]).toMatchObject({ attempts: 2, lastError: 'rate limited' })
    await expect(retryFeishuOutbox(first.id, 'exhausted')).resolves.toBe(true)
    await expect(requeueFailedFeishuOutbox(first.id, 'beta')).resolves.toBe(false)
    await expect(requeueFailedFeishuOutbox(first.id, 'alpha')).resolves.toBe(true)
    expect((await claimFeishuOutbox({ botId: 'alpha' }))[0]).toMatchObject({ attempts: 1, lastError: '' })
    await expect(markFeishuOutboxSent(first.id, 'om_remote')).resolves.toBe(true)
    expect((await listFeishuOutbox({ botId: 'alpha', status: 'sent' }))[0]).toMatchObject({
      remoteMessageId: 'om_remote', status: 'sent', lastError: '',
    })
  })
})

describe('feishuBotStore operational records', () => {
  it('tracks turns, streaming cards and audit entries', async () => {
    await bot('alpha')
    const turn = await createFeishuTurn({
      botId: 'alpha', bindingKey: 'binding', inboundMessageId: 'm1',
      sessionId: 'session', prompt: 'fix it', status: 'running',
    })
    const duplicate = await createFeishuTurn({
      botId: 'alpha', bindingKey: 'binding', inboundMessageId: 'm1',
      sessionId: 'session', prompt: 'duplicate',
    })
    expect(duplicate.id).toBe(turn.id)

    await upsertFeishuCard({
      id: 'card-1', botId: 'alpha', bindingKey: 'binding', messageId: 'om_1',
      purpose: 'turn', status: 'streaming', version: 1, state: { text: 'working' },
    })
    await upsertFeishuCard({
      id: 'card-1', botId: 'alpha', purpose: 'turn', status: 'completed', version: 2,
      state: { text: 'done' },
    })
    expect(await findFeishuCard('card-1')).toMatchObject({ status: 'completed', version: 2, state: { text: 'done' } })
    expect(await listFeishuCards({ botId: 'alpha' })).toHaveLength(1)

    const completed = await updateFeishuTurn(turn.id, {
      turnId: 'codex-turn', status: 'completed', responseText: 'done', cardId: 'card-1',
    })
    expect(completed).toMatchObject({ status: 'completed', responseText: 'done', cardId: 'card-1' })
    expect(completed?.completedAtIso).not.toBeNull()
    await expect(findFeishuTurn(turn.id)).resolves.toEqual(completed)
    expect(await listFeishuTurns({ sessionId: 'session' })).toHaveLength(1)

    const audit = await appendFeishuAuditLog({
      botId: 'alpha', actorOpenId: 'ou_admin', action: 'binding.create',
      targetType: 'binding', targetId: 'binding', metadata: { sessionId: 'session' },
    })
    expect(audit).toMatchObject({ success: true, metadata: { sessionId: 'session' } })
    expect(await listFeishuAuditLogs({ botId: 'alpha', action: 'binding.create' })).toEqual([audit])
  })

  it('uses insertion order as a stable tie-break when turn timestamps are identical', async () => {
    await bot('alpha')
    const first = await createFeishuTurn({
      botId: 'alpha', bindingKey: 'binding', inboundMessageId: 'same-ms-1',
      sessionId: 'session', prompt: 'first', status: 'running',
    })
    const second = await createFeishuTurn({
      botId: 'alpha', bindingKey: 'binding', inboundMessageId: 'same-ms-2',
      sessionId: 'session', prompt: 'second', status: 'queued',
    })
    await withLocalDatabase((db) => {
      db.prepare("UPDATE feishu_turns SET created_at_iso = '2026-07-18T00:00:00.000Z' WHERE id IN (?, ?)")
        .run(first.id, second.id)
    })

    expect((await listFeishuTurns({ sessionId: 'session' })).map((turn) => turn.id)).toEqual([second.id, first.id])
  })

  it('cleans expired terminal history without deleting active work at retention boundaries', async () => {
    await bot('alpha')
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'old', messageId: 'old-pending', prompt: 'old', createdAtIso: '2025-01-01T00:00:00.000Z' })
    await savePendingFeishuMessage({ botId: 'alpha', bindingKey: 'new', messageId: 'new-pending', prompt: 'new', createdAtIso: '2026-07-18T00:00:00.000Z' })
    await claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'old-event' })
    await completeFeishuInboundEvent('old-event', 'alpha')
    await claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'active-event' })
    const sent = await enqueueFeishuOutbox({ botId: 'alpha', kind: 'send', targetId: 'chat', payload: {} })
    await claimFeishuOutbox({ botId: 'alpha' })
    await markFeishuOutboxSent(sent.id, 'remote')
    const activeOutbox = await enqueueFeishuOutbox({ botId: 'alpha', kind: 'pending', targetId: 'chat', payload: {} })
    const terminalTurn = await createFeishuTurn({ botId: 'alpha', bindingKey: 'b', sessionId: 's', status: 'queued' })
    await updateFeishuTurn(terminalTurn.id, { status: 'completed' })
    const activeTurn = await createFeishuTurn({ botId: 'alpha', bindingKey: 'b', sessionId: 's', status: 'running' })
    await upsertFeishuCard({ id: 'old-card', botId: 'alpha', purpose: 'turn', status: 'completed', version: 1 })
    await upsertFeishuCard({ id: 'active-card', botId: 'alpha', purpose: 'turn', status: 'streaming', version: 1 })
    await appendFeishuAuditLog({ botId: 'alpha', action: 'old', createdAtIso: '2025-01-01T00:00:00.000Z' })
    await withLocalDatabase((db) => {
      db.prepare("UPDATE feishu_inbound_events SET received_at_iso = '2025-01-01T00:00:00.000Z'").run()
      db.prepare("UPDATE feishu_outbox SET sent_at_iso = '2025-01-01T00:00:00.000Z', updated_at_iso = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(sent.id)
      db.prepare("UPDATE feishu_turns SET completed_at_iso = '2025-01-01T00:00:00.000Z', updated_at_iso = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(terminalTurn.id)
      db.prepare("UPDATE feishu_cards SET updated_at_iso = '2025-01-01T00:00:00.000Z' WHERE id = 'old-card'").run()
    })

    const result = await cleanupFeishuOperationalData(new Date('2026-07-19T00:00:00.000Z'))
    expect(result).toMatchObject({ pendingMessages: 1, inboundEvents: 1, sentOutbox: 1, turns: 1, cards: 1, auditLogs: 1 })
    expect((await listFeishuOutbox({ botId: 'alpha' })).map((item) => item.id)).toContain(activeOutbox.id)
    expect((await listFeishuTurns({ botId: 'alpha' })).map((item) => item.id)).toContain(activeTurn.id)
    expect((await listFeishuCards({ botId: 'alpha' })).map((item) => item.id)).toContain('active-card')
    expect(await takePendingFeishuMessage('new', 'alpha')).not.toBeNull()
    expect(await claimFeishuInboundEvent({ botId: 'alpha', eventKey: 'active-event' })).toBeNull()
  })
})
