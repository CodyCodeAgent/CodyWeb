import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFeishuIntegration } from './feishuIntegration'
import {
  deadLetterFeishuOutbox,
  enqueueFeishuOutbox,
  findFeishuBot,
  listFeishuAuditLogs,
  retryFeishuOutbox,
} from './feishuBotStore'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-feishu-integration-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  delete process.env.CODY_WEB_UI_SETTINGS_DB
  await rm(tempDir, { recursive: true, force: true })
})

function integration() {
  return createFeishuIntegration({
    owner: {
      start: vi.fn(async () => ({ threadId: 'thread-test' })),
      submitUntilStarted: vi.fn(async () => ({ threadId: 'thread-test', turnId: 'turn-test' })),
      runEphemeral: vi.fn(async () => ({ assistantText: '', terminalEvent: { type: 'turn.completed', data: {} } })),
      read: vi.fn(async () => []), interrupt: vi.fn(async () => true), listSkills: vi.fn(async () => []),
      listCollaborationModes: vi.fn(async () => []), readConfig: vi.fn(async () => ({ config: { model: null, model_reasoning_effort: null, developer_instructions: null } })), renameThread: vi.fn(async () => undefined), archiveThread: vi.fn(async () => undefined),
      respondApproval: vi.fn(async () => undefined), respondQuestion: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined),
    } as never,
    respondToServerRequest: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    catalogSync: { refreshForRead: vi.fn(async () => undefined) } as never,
    isServerRequestPending: vi.fn(() => false),
  })
}

describe('Feishu integration management audit', () => {
  it('records safe bot mutations without retaining credentials', async () => {
    const value = integration()
    const created = await value.routes.createBot({
      name: 'Team bot',
      appId: 'cli_sensitive_identifier',
      appSecret: 'test-secret',
      platform: 'feishu',
      enabled: false,
      allowAllUsers: false,
      allowedOpenIds: ['ou_one'],
      groupMentionMode: 'always',
    })
    await value.routes.updateBot(created.id, {
      appSecret: 'replacement-secret',
      enabled: false,
      platform: 'lark',
      allowedOpenIds: ['ou_one', 'ou_two'],
      groupMentionMode: 'bound',
    })
    await expect(value.routes.reconnectBot(created.id)).rejects.toThrow('Enable the Feishu bot')
    await expect(value.routes.diagnoseBot(created.id)).resolves.toMatchObject({
      botId: created.id,
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'enabled', status: 'fail' }),
        expect.objectContaining({ id: 'runtime', status: 'fail' }),
      ]),
    })
    await expect(value.routes.deleteBot(created.id, 'keep')).resolves.toEqual({ removed: true, remoteDisabled: false })
    expect(await findFeishuBot(created.id)).toBeNull()

    const audits = await listFeishuAuditLogs({ limit: 20 })
    expect(audits.map((row) => [row.action, row.success])).toEqual(expect.arrayContaining([
      ['bot.create', true],
      ['bot.update', true],
      ['bot.reconnect', false],
      ['bot.diagnose', false],
      ['bot.delete', true],
    ]))
    const serialized = JSON.stringify(audits)
    expect(serialized).not.toContain('super-sensitive-secret')
    expect(serialized).not.toContain('replacement-secret')
    expect(serialized).not.toContain('cli_sensitive_identifier')
    expect(serialized).not.toContain('ou_one')
    expect(audits.find((row) => row.action === 'bot.update')?.metadata).toMatchObject({
      enabled: false,
      platform: 'lark',
      groupMentionMode: 'bound',
      allowedOpenIdCount: 2,
      credentialChanged: true,
    })
  })

  it('reports retryable failures separately from terminal dead letters', async () => {
    const value = integration()
    const created = await value.routes.createBot({
      name: 'Diagnostics bot', appId: 'cli_diagnostics', appSecret: 'secret', platform: 'feishu', enabled: false, allowAllUsers: false,
      allowedOpenIds: [], groupMentionMode: 'always',
    })
    const retrying = await enqueueFeishuOutbox({
      botId: created.id, kind: 'message.create', targetId: 'chat', payload: { text: 'retry' },
    })
    const terminal = await enqueueFeishuOutbox({
      botId: created.id, kind: 'message.create', targetId: 'chat', payload: { text: 'dead' },
    })
    await retryFeishuOutbox(retrying.id, 'temporary')
    await deadLetterFeishuOutbox(terminal.id, 'permanent')

    const diagnostics = await value.routes.getDiagnostics(created.id)
    expect(diagnostics.counts.outbox).toMatchObject({ failed: 1, deadLettered: 1 })
    expect(diagnostics.recentFailedDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ error: 'temporary', deadLetteredAtIso: null }),
      expect.objectContaining({ error: 'permanent', deadLetteredAtIso: expect.any(String) }),
    ]))
  })
})
