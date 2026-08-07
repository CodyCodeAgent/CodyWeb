import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptFeishuOpenPlatformApp,
  cancelFeishuQrSetup,
  confirmFeishuQrSetupIdentity,
  clearFeishuOpenPlatformSession,
  createFeishuBot,
  deleteFeishuBot,
  diagnoseFeishuBot,
  fetchFeishuDiagnostics,
  fetchFeishuBindings,
  fetchFeishuBots,
  fetchFeishuQrSetup,
  fetchFeishuQrSetups,
  fetchFeishuOpenPlatformSession,
  fetchFeishuOpenPlatformApps,
  reconnectFeishuBot,
  removeFeishuBinding,
  retryFeishuQrSetup,
  retryFeishuDelivery,
  startFeishuQrSetup,
  updateFeishuBot,
} from './codexFeishuClient'

const httpMock = vi.hoisted(() => ({ fetchCodexResultRecord: vi.fn() }))
vi.mock('./codexHttpClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codexHttpClient')>(),
  fetchCodexResultRecord: httpMock.fetchCodexResultRecord,
}))

afterEach(() => vi.clearAllMocks())

const bot = {
  id: 'bot-1', name: 'Release bot', appId: 'cli_a', secretConfigured: true, enabled: true,
  platform: 'feishu', tenantId: 't_1', tenantName: 'Example Enterprise',
  allowedOpenIds: ['ou_admin'], status: 'connected', lastConnectedAtIso: '2026-07-18T01:00:00.000Z', lastHeartbeatAtIso: '2026-07-18T01:01:00.000Z',
  groupMentionMode: 'always',
  lastError: null, createdAtIso: '2026-07-17T00:00:00.000Z', updatedAtIso: '2026-07-18T01:00:00.000Z',
}

describe('Feishu client', () => {
  it('normalizes the multi-bot list', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { bots: [bot, { ...bot, id: 'bot-2', status: 'unknown' }] }, status: 200 })
    await expect(fetchFeishuBots()).resolves.toMatchObject([
      { id: 'bot-1', status: 'connected', platform: 'feishu', tenantName: 'Example Enterprise', lastHeartbeatAtIso: '2026-07-18T01:01:00.000Z', allowedOpenIds: ['ou_admin'] },
      { id: 'bot-2', status: 'disconnected' },
    ])
    expect(httpMock.fetchCodexResultRecord).toHaveBeenCalledWith('/codex-api/feishu/bots', expect.anything())
  })

  it('creates, updates and reconnects a bot with the expected contract', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { bot }, status: 200 })
    const input = { name: 'Release bot', appId: 'cli_a', appSecret: 'secret', platform: 'lark' as const, enabled: true, allowedOpenIds: [], groupMentionMode: 'topic' as const }
    await createFeishuBot(input)
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bots', expect.objectContaining({
      init: expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    }))

    await updateFeishuBot('bot / 1', { enabled: false })
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bots/bot%20%2F%201', expect.objectContaining({
      init: expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    }))

    await reconnectFeishuBot('bot-1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bots/bot-1/reconnect', expect.objectContaining({
      init: expect.objectContaining({ method: 'POST' }),
    }))
  })

  it('deletes a bot using an encoded id', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { removed: true, remoteDisabled: false }, status: 200 })
    await deleteFeishuBot('bot / 1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bots/bot%20%2F%201?remoteAction=keep', expect.objectContaining({ init: { method: 'DELETE' } }))
  })

  it('runs and validates a live bot diagnostic', async () => {
    const checks = [
      { id: 'configuration', status: 'pass', message: 'configured' },
      { id: 'enabled', status: 'pass', message: 'enabled' },
      { id: 'runtime', status: 'pass', message: 'running' },
      { id: 'long_connection', status: 'pass', message: 'connected' },
      { id: 'credential_api', status: 'pass', message: 'authenticated' },
      { id: 'bot_identity', status: 'pass', message: 'matched' },
    ]
    httpMock.fetchCodexResultRecord.mockResolvedValue({
      result: { report: { botId: 'bot / 1', ok: true, generatedAtIso: '2026-07-18T01:00:00.000Z', latencyMs: 18, checks } },
      status: 200,
    })
    await expect(diagnoseFeishuBot('bot / 1')).resolves.toMatchObject({ ok: true, latencyMs: 18, checks })
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bots/bot%20%2F%201/diagnose', expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }))
  })

  it('starts, polls, confirms identity, cancels, and retries QR setup jobs', async () => {
    const job = {
      id: 'job-1', name: 'Cody', status: 'awaiting_scan', statusMessage: 'scan',
      qrDataUrl: 'data:image/png;base64,qr', qrExpiresAtIso: null, account: null, bot: null,
      warnings: [], error: null, canRetry: false, canCancel: true, canConfirmIdentity: false, createdAtIso: '', updatedAtIso: '',
    }
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { job }, status: 202 })
    await expect(startFeishuQrSetup({ name: 'Cody', allowedOpenIds: [], groupMentionMode: 'always' })).resolves.toMatchObject({
      id: 'job-1', status: 'awaiting_scan',
      checks: { credentialsSaved: false, accountVerified: false, liveProbeVerified: false },
    })
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/qr-setup', expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }))
    await fetchFeishuQrSetup('job / 1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/qr-setup/job%20%2F%201', expect.anything())
    await confirmFeishuQrSetupIdentity('job-1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/qr-setup/job-1/confirm', expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }))
    await cancelFeishuQrSetup('job-1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/qr-setup/job-1/cancel', expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }))
    await retryFeishuQrSetup('job-1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/qr-setup/job-1/retry', expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }))

    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { jobs: [job] }, status: 200 })
    await expect(fetchFeishuQrSetups()).resolves.toHaveLength(1)
  })

  it('normalizes structured setup errors into readable text', async () => {
    const job = {
      id: 'job-error', name: 'Cody', status: 'failed', statusMessage: 'failed',
      qrDataUrl: null, qrExpiresAtIso: null, account: null, bot: null,
      warnings: [], error: { message: 'Permission is pending' },
      canRetry: true, canCancel: false, canConfirmIdentity: false,
      createdAtIso: '', updatedAtIso: '',
    }
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { jobs: [job] }, status: 200 })
    await expect(fetchFeishuQrSetups()).resolves.toMatchObject([
      { id: 'job-error', error: 'Permission is pending' },
    ])
  })

  it('inspects and clears Open Platform authorization without exposing cookies', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { session: {
      configured: true, valid: true,
      account: { userName: 'Alice', email: 'alice@example.com', tenantName: 'Example' }, error: null,
    } }, status: 200 })
    await expect(fetchFeishuOpenPlatformSession()).resolves.toMatchObject({
      valid: true, account: { userName: 'Alice', tenantName: 'Example' },
    })
    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { cleared: true }, status: 200 })
    await expect(clearFeishuOpenPlatformSession()).resolves.toBe(true)
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/open-platform-session', expect.objectContaining({ init: { method: 'DELETE' } }))
  })

  it('lists and adopts existing Open Platform applications', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { apps: [{
      appId: 'cli_existing', name: 'Existing', description: 'Recovered app',
    }] }, status: 200 })
    await expect(fetchFeishuOpenPlatformApps()).resolves.toEqual([{
      appId: 'cli_existing', name: 'Existing', description: 'Recovered app',
    }])
    const job = {
      id: 'job-adopt', name: 'Existing', status: 'configuring', statusMessage: 'working',
      qrDataUrl: null, qrExpiresAtIso: null, account: null, bot: null,
      warnings: [], error: null, canRetry: false, canCancel: false, canConfirmIdentity: false, createdAtIso: '', updatedAtIso: '',
    }
    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { job }, status: 202 })
    await expect(adoptFeishuOpenPlatformApp({
      appId: 'cli_existing', name: 'Existing', allowedOpenIds: [], groupMentionMode: 'always',
    })).resolves.toMatchObject({ id: 'job-adopt', status: 'configuring' })
  })

  it('lists and removes bindings', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { bindings: [{
      id: 'binding-1', botId: 'bot-1', botName: 'Release bot', scopeType: 'topic', chatId: 'oc_chat',
      threadId: 'thread-1', projectCwd: '/repo', projectName: 'Repo', sessionId: 'session-1',
      sessionTitle: 'Fix CI', userOpenId: 'ou_user', createdAtIso: '', updatedAtIso: '', lastMessageAtIso: null,
    }] }, status: 200 })
    await expect(fetchFeishuBindings('bot-1')).resolves.toMatchObject([{ id: 'binding-1', scopeType: 'topic', projectName: 'Repo', permissionMode: 'yolo' }])
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bindings?botId=bot-1', expect.anything())

    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { removed: true }, status: 200 })
    await removeFeishuBinding('binding-1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/bindings/binding-1', expect.objectContaining({ init: { method: 'DELETE' } }))
  })

  it('rejects malformed collection responses', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { bots: null }, status: 200 })
    await expect(fetchFeishuBots()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reads a safe bot-filtered diagnostics summary', async () => {
    httpMock.fetchCodexResultRecord.mockResolvedValue({ result: { diagnostics: {
      botId: 'bot-1', generatedAtIso: '2026-07-18T01:00:00.000Z',
      counts: {
        outbox: { pending: 1, sending: 0, sent: 8, failed: 2, deadLettered: 1 },
        turns: { queued: 0, running: 1, completed: 7, failed: 1, cancelled: 0 },
        cards: { creating: 0, streaming: 1, completed: 7, failed: 1, cancelled: 0 },
        audit: { success: 5, failed: 1 },
      },
      recentFailedDeliveries: [{
        id: 'outbox-1', kind: 'card.update', attempts: 3, error: 'rate limited', updatedAtIso: '2026-07-18T00:59:00.000Z',
        deadLetteredAtIso: '2026-07-18T00:59:00.000Z',
      }],
      recentTurns: [{ status: 'running', error: '', updatedAtIso: '2026-07-18T00:58:00.000Z' }],
      recentCards: [{ purpose: 'answer', status: 'streaming', version: 2, updatedAtIso: '2026-07-18T00:58:00.000Z' }],
      recentAuditLogs: [{ action: 'binding.create', success: true, error: '', createdAtIso: '2026-07-18T00:57:00.000Z' }],
    } }, status: 200 })
    await expect(fetchFeishuDiagnostics('bot-1')).resolves.toMatchObject({
      botId: 'bot-1', counts: { outbox: { failed: 2 } }, recentFailedDeliveries: [{ attempts: 3 }],
    })
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith('/codex-api/feishu/diagnostics?botId=bot-1', expect.anything())

    httpMock.fetchCodexResultRecord.mockResolvedValueOnce({ result: { requeued: true }, status: 200 })
    await retryFeishuDelivery('bot / 1', 'outbox:1')
    expect(httpMock.fetchCodexResultRecord).toHaveBeenLastCalledWith(
      '/codex-api/feishu/bots/bot%20%2F%201/outbox/outbox%3A1/retry',
      expect.objectContaining({ init: expect.objectContaining({ method: 'POST' }) }),
    )
  })
})
