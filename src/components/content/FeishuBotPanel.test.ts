// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FeishuBotPanel from './FeishuBotPanel.vue'

const api = vi.hoisted(() => ({
  fetchFeishuBots: vi.fn(),
  fetchFeishuBindings: vi.fn(),
  fetchFeishuAutoRoutes: vi.fn(async () => []),
  fetchFeishuDiagnostics: vi.fn(),
  diagnoseFeishuBot: vi.fn(),
  createFeishuBot: vi.fn(),
  deleteFeishuBot: vi.fn(),
  updateFeishuBot: vi.fn(),
  reconnectFeishuBot: vi.fn(),
  removeFeishuBinding: vi.fn(),
  removeFeishuAutoRoute: vi.fn(),
  setFeishuAutoRouteEnabled: vi.fn(),
  setFeishuAutoRouteScenarioPackage: vi.fn(),
  retryFeishuDelivery: vi.fn(),
  startFeishuQrSetup: vi.fn(),
  fetchFeishuQrSetup: vi.fn(),
  fetchFeishuQrSetups: vi.fn(async () => []),
  cancelFeishuQrSetup: vi.fn(),
  confirmFeishuQrSetupIdentity: vi.fn(),
  retryFeishuQrSetup: vi.fn(),
  fetchFeishuOpenPlatformSession: vi.fn(async () => ({ configured: false, valid: false, account: null, error: null })),
  clearFeishuOpenPlatformSession: vi.fn(async () => true),
  fetchFeishuOpenPlatformApps: vi.fn(async () => []),
  adoptFeishuOpenPlatformApp: vi.fn(),
}))
const promptApi = vi.hoisted(() => ({
  fetchPromptTemplates: vi.fn(async () => []),
}))
const transport = vi.hoisted(() => ({
  isRemotePlainHttpLocation: vi.fn(() => false),
}))

vi.mock('../../api/codexFeishuClient', () => api)
vi.mock('../../api/codexPromptLibraryClient', () => promptApi)
vi.mock('../../composables/feishuTransport', () => transport)

const bot = {
  id: 'bot-1', name: 'Team bot', appId: 'cli_team', secretConfigured: true, enabled: true,
  platform: 'feishu', tenantId: 't_team', tenantName: 'Example Enterprise',
  allowAllUsers: false,
  allowedOpenIds: ['ou_admin'], status: 'connected', lastConnectedAtIso: '2026-07-18T01:00:00.000Z', lastHeartbeatAtIso: '2026-07-18T01:01:00.000Z',
  groupMentionMode: 'always',
  p2pMode: 'topic',
  lastError: null, createdAtIso: '', updatedAtIso: '',
}

const binding = {
  id: 'binding-1', botId: 'bot-1', botName: 'Team bot', scopeType: 'topic', chatId: 'oc_chat',
  threadId: 'thread-1', projectCwd: '/repo', projectName: 'CodyWeb', sessionId: 'session-1',
  sessionTitle: 'Ship Feishu', userOpenId: 'ou_user', createdAtIso: '', updatedAtIso: '', lastMessageAtIso: null,
}

const diagnostics = {
  botId: 'bot-1', generatedAtIso: '2026-07-18T01:00:00.000Z',
  counts: {
    outbox: { pending: 1, sending: 0, sent: 8, failed: 2, deadLettered: 1 },
    turns: { queued: 0, running: 1, completed: 7, failed: 1, cancelled: 0 },
    cards: { creating: 0, streaming: 1, completed: 7, failed: 0, cancelled: 0 },
    audit: { success: 5, failed: 1 },
  },
  recentFailedDeliveries: [{
    id: 'outbox-1', kind: 'card.update', attempts: 3, error: 'rate limited', updatedAtIso: '2026-07-18T00:59:00.000Z',
    deadLetteredAtIso: '2026-07-18T00:59:00.000Z',
  }],
  recentTurns: [{ status: 'running', error: '', updatedAtIso: '2026-07-18T00:58:00.000Z' }],
  recentCards: [{ purpose: 'answer', status: 'streaming', version: 2, updatedAtIso: '2026-07-18T00:58:00.000Z' }],
  recentAuditLogs: [{ action: 'binding.create', success: true, error: '', createdAtIso: '2026-07-18T00:57:00.000Z' }],
}

const connectivityReport = {
  botId: 'bot-1', ok: true, generatedAtIso: '2026-07-18T01:01:00.000Z', latencyMs: 24,
  checks: [
    { id: 'configuration', status: 'pass', message: 'configured' },
    { id: 'enabled', status: 'pass', message: 'enabled' },
    { id: 'runtime', status: 'pass', message: 'running' },
    { id: 'long_connection', status: 'pass', message: 'connected' },
    { id: 'credential_api', status: 'pass', message: 'authenticated' },
    { id: 'bot_identity', status: 'pass', message: 'matched' },
  ],
}

afterEach(() => {
  vi.clearAllMocks()
  promptApi.fetchPromptTemplates.mockResolvedValue([])
  vi.useRealTimers()
  transport.isRemotePlainHttpLocation.mockReturnValue(false)
  vi.unstubAllGlobals()
})

describe('FeishuBotPanel', () => {
  async function openManualCreate(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.get('.feishu-empty .feishu-primary-button').trigger('click')
    const manual = wrapper.findAll('.feishu-create-modes button').find((button) => button.text() === 'App ID / Secret')
    await manual?.trigger('click')
    await flushPromises()
  }

  it('shows a non-blocking warning for remote plain HTTP management', async () => {
    transport.isRemotePlainHttpLocation.mockReturnValue(true)
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    const warning = wrapper.get('.feishu-transport-warning')
    expect(warning.attributes('role')).toBe('status')
    expect(warning.text()).toContain('browser connection is not encrypted')
    expect(wrapper.text()).toContain('Add the first bot')
    wrapper.unmount()
  })

  it('shows connection health and shared session bindings', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([{ ...binding, scopeType: 'private' }])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Team bot')
    expect(wrapper.text()).toContain('Connected')
    expect(wrapper.text()).toContain('Example Enterprise')
    expect(wrapper.text()).toContain('Last verified heartbeat')
    expect(wrapper.text()).toContain('CodyWeb')
    expect(wrapper.text()).toContain('Ship Feishu')
    expect(wrapper.text()).toContain('Private topic')
    expect(wrapper.text()).toContain('thread-1')
    wrapper.unmount()
  })

  it('restores the current failed setup inline without exposing setup history', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuQrSetups.mockResolvedValueOnce([{
      id: 'job-failed', name: 'Recover me', status: 'failed', statusMessage: 'Configuration failed',
      qrDataUrl: null, qrExpiresAtIso: null,
      account: { userName: 'Alice', email: null, tenantName: 'Example tenant' },
      bot: { ...bot, enabled: false, status: 'error' }, warnings: [], error: 'Event callback is not active',
      canRetry: true, canCancel: false, canConfirmIdentity: false, createdAtIso: '', updatedAtIso: '2026-07-18T01:00:00.000Z',
    }] as never)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Event callback is not active')
    expect(wrapper.text()).toContain('Retry automatic configuration')
    expect(wrapper.find('.feishu-setup-history').exists()).toBe(false)
    expect(api.startFeishuQrSetup).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('creates a bot without leaking the secret back into the form', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.createFeishuBot.mockResolvedValue({ ...bot, platform: 'lark' })
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await openManualCreate(wrapper)
    const inputs = wrapper.findAll('.feishu-form-grid input')
    await inputs[0].setValue('Team bot')
    await inputs[1].setValue('cli_team')
    await wrapper.get('input[value="lark"]').setValue(true)
    await wrapper.get('.feishu-secret-input input').setValue('secret-value')
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    expect(api.createFeishuBot).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Team bot', appId: 'cli_team', appSecret: 'secret-value', platform: 'lark', enabled: false,
    }))
    expect((wrapper.get('.feishu-secret-input input').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('input[value="lark"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('Bot configuration saved.')
    wrapper.unmount()
  })

  it('defaults new bots off and confirms explicitly before enabling open access', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.createFeishuBot.mockResolvedValue({ ...bot, allowedOpenIds: [] })
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await openManualCreate(wrapper)
    expect((wrapper.get('.feishu-enabled-switch input').element as HTMLInputElement).checked).toBe(false)
    const inputs = wrapper.findAll('.feishu-form-grid input')
    await inputs[0].setValue('Open bot')
    await inputs[1].setValue('cli_open')
    await wrapper.get('.feishu-secret-input input').setValue('secret-value')
    await wrapper.get('.feishu-enabled-switch input').setValue(true)
    await wrapper.get('.feishu-open-access-field input').setValue(true)
    expect(wrapper.text()).toContain('every person who can reach this Feishu app')
    await wrapper.get('.feishu-form').trigger('submit')
    expect(api.createFeishuBot).not.toHaveBeenCalled()
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    expect(api.createFeishuBot).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, allowAllUsers: true, allowedOpenIds: [] }))
    expect(confirm).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('makes the first allow-list identity access administrator explicit', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('The first Open ID is the access-request administrator')
    expect(wrapper.text()).toContain('receives private approval cards')
    wrapper.unmount()
  })

  it('defaults group messages to mention-required and saves an explicit higher-noise mode', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.createFeishuBot.mockResolvedValue({ ...bot, groupMentionMode: 'bound' })
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await openManualCreate(wrapper)
    expect((wrapper.get('input[value="always"]').element as HTMLInputElement).checked).toBe(true)
    const inputs = wrapper.findAll('.feishu-form-grid input')
    await inputs[0].setValue('Group bot')
    await inputs[1].setValue('cli_group')
    await wrapper.get('.feishu-secret-input input').setValue('secret-value')
    await wrapper.get('input[value="bound"]').setValue(true)
    expect(wrapper.text()).toContain('High noise risk')
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    expect(api.createFeishuBot).toHaveBeenCalledWith(expect.objectContaining({ groupMentionMode: 'bound' }))
    wrapper.unmount()
  })

  it('defaults private chats to one topic per message and can save flat chat mode', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.createFeishuBot.mockResolvedValue({ ...bot, p2pMode: 'chat' })
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await openManualCreate(wrapper)
    const topic = wrapper.get('input[name="feishu-p2p-mode"][value="topic"]')
    expect((topic.element as HTMLInputElement).checked).toBe(true)
    const inputs = wrapper.findAll('.feishu-form-grid input')
    await inputs[0].setValue('Private bot')
    await inputs[1].setValue('cli_private')
    await wrapper.get('.feishu-secret-input input').setValue('secret-value')
    await wrapper.get('input[name="feishu-p2p-mode"][value="chat"]').setValue(true)
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    expect(api.createFeishuBot).toHaveBeenCalledWith(expect.objectContaining({ p2pMode: 'chat' }))
    wrapper.unmount()
  })

  it('uses one-scan QR setup as the default creation path', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    const job = {
      id: 'job-1', name: 'Scan bot', status: 'awaiting_scan', statusMessage: 'Please scan',
      qrDataUrl: 'data:image/png;base64,qr', qrExpiresAtIso: new Date(Date.now() + 10 * 60_000).toISOString(), account: null, bot: null,
      warnings: [], error: null, canRetry: false, canCancel: true, canConfirmIdentity: false, createdAtIso: '', updatedAtIso: '',
    }
    api.startFeishuQrSetup.mockResolvedValue(job)
    api.fetchFeishuQrSetup.mockResolvedValue(job)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await wrapper.get('.feishu-empty .feishu-primary-button').trigger('click')
    expect(wrapper.text()).toContain('Create a Feishu bot by QR code')
    expect(wrapper.text()).toContain('Scan once')
    await wrapper.get('.feishu-qr-name-field input').setValue('Scan bot')
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    expect(api.startFeishuQrSetup).toHaveBeenCalledWith({
      name: 'Scan bot', allowAllUsers: false, allowedOpenIds: [], groupMentionMode: 'always', p2pMode: 'topic',
      availability: { mode: 'creator', memberIds: [], groupIds: [] },
    })
    expect(wrapper.get('.feishu-qr-code').attributes('src')).toBe('data:image/png;base64,qr')
    expect(wrapper.text()).toContain('Step 1 of 3 · Waiting for scan or phone confirmation')
    expect(wrapper.text()).toContain('tap Confirm on your phone')
    expect(wrapper.text()).toContain('About 10 minutes remaining')
    wrapper.unmount()
  })

  it('shows persisted proof-by-proof setup evidence instead of a generic completed state', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    const checks = {
      credentialsSaved: true, accountVerified: true, botAbilityVerified: true, scopesVerified: true,
      messageEventVerified: true, cardCallbackVerified: true, eventLongConnectionVerified: true,
      callbackLongConnectionVerified: true, versionPublishedVerified: true, visibilityVerified: true,
      appEnabledVerified: true, sdkConnectionVerified: true, botIdentityVerified: true, liveProbeVerified: false,
    }
    const job = {
      id: 'job-proof', name: 'Proof bot', status: 'failed', statusMessage: 'Live probe needs attention',
      qrDataUrl: null, qrExpiresAtIso: null,
      account: { userName: 'Alice', email: null, tenantName: 'Example' }, bot,
      warnings: [], error: 'Live diagnostic failed', canRetry: true, canCancel: false, canConfirmIdentity: false,
      checks, createdAtIso: '', updatedAtIso: '2026-07-18T01:00:00.000Z',
    }
    api.fetchFeishuQrSetups.mockResolvedValueOnce([job] as never)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Verified setup evidence')
    expect(wrapper.text()).toContain('Live OpenAPI diagnostic')
    expect(wrapper.get('.feishu-setup-proofs header small').text()).toBe('7 / 8')
    expect(wrapper.findAll('.feishu-setup-proofs li[data-passed="true"]')).toHaveLength(7)
    wrapper.unmount()
  })

  it('adopts an exact existing App ID through the official scan flow', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    const job = {
      id: 'job-adopt', name: 'Recovered bot', status: 'awaiting_scan', statusMessage: 'Please scan',
      qrDataUrl: 'data:image/png;base64,adopt', qrExpiresAtIso: null, account: null, bot: null,
      warnings: [], error: null, canRetry: false, canCancel: true, canConfirmIdentity: false, createdAtIso: '', updatedAtIso: '',
    }
    api.adoptFeishuOpenPlatformApp.mockResolvedValue(job)
    api.fetchFeishuQrSetup.mockResolvedValue(job)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await wrapper.get('.feishu-empty .feishu-primary-button').trigger('click')
    await wrapper.get('.feishu-qr-name-field input').setValue('Recovered bot')
    await wrapper.get('.feishu-existing-apps summary').trigger('click')
    await wrapper.get('.feishu-existing-app-id input').setValue('cli_existing')
    await wrapper.get('.feishu-existing-app-id button').trigger('click')
    await flushPromises()
    expect(api.adoptFeishuOpenPlatformApp).toHaveBeenCalledWith({
      appId: 'cli_existing', name: 'Recovered bot', allowAllUsers: false, allowedOpenIds: [], groupMentionMode: 'always', p2pMode: 'topic',
      availability: { mode: 'creator', memberIds: [], groupIds: [] },
    })
    expect(wrapper.get('.feishu-qr-code').attributes('src')).toBe('data:image/png;base64,adopt')
    wrapper.unmount()
  })

  it('requires an explicit account and organization confirmation before app creation continues', async () => {
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    const confirmingJob = {
      id: 'job-confirm', name: 'Confirm bot', status: 'confirming_identity',
      statusMessage: 'Confirm account and organization', qrDataUrl: null, qrExpiresAtIso: null,
      account: { userName: 'Alice', email: 'alice@example.com', tenantName: 'Example Enterprise' },
      bot: null, warnings: [], error: null, canRetry: false, canCancel: true,
      canConfirmIdentity: true, createdAtIso: '', updatedAtIso: '2026-07-18T01:00:00.000Z',
    }
    api.fetchFeishuQrSetups.mockResolvedValue([confirmingJob] as never)
    api.confirmFeishuQrSetupIdentity.mockResolvedValue({
      ...confirmingJob, status: 'creating_app', statusMessage: 'Creating application',
      canCancel: false, canConfirmIdentity: false,
    })
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('Example Enterprise')
    expect(wrapper.text()).toContain('Confirm the account and organization before creating the app')
    const confirmButton = wrapper.findAll('.feishu-form-actions button').find((button) => button.text() === 'Confirm account and organization')
    expect(confirmButton?.exists()).toBe(true)
    await confirmButton?.trigger('click')
    await flushPromises()
    expect(api.confirmFeishuQrSetupIdentity).toHaveBeenCalledWith('job-confirm')
    expect(wrapper.text()).toContain('Creating application')
    wrapper.unmount()
  })

  it('automatically opens the bot when QR setup completes', async () => {
    vi.useFakeTimers()
    api.fetchFeishuBots.mockResolvedValue([])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuQrSetups.mockResolvedValue([])
    const waitingJob = {
      id: 'job-complete', name: 'Ready bot', status: 'awaiting_scan', statusMessage: 'Please scan',
      qrDataUrl: 'data:image/png;base64,qr', qrExpiresAtIso: null, account: null, bot: null,
      warnings: [], error: null, canRetry: false, canCancel: true, canConfirmIdentity: false,
      createdAtIso: '', updatedAtIso: '',
    }
    api.startFeishuQrSetup.mockResolvedValue(waitingJob)
    api.fetchFeishuQrSetup.mockResolvedValue({
      ...waitingJob,
      status: 'completed',
      statusMessage: 'Ready',
      qrDataUrl: null,
      bot: { ...bot, name: 'Ready bot' },
      canCancel: false,
    })
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await wrapper.get('.feishu-empty .feishu-primary-button').trigger('click')
    await wrapper.get('.feishu-qr-name-field input').setValue('Ready bot')
    await wrapper.get('.feishu-form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(wrapper.text()).toContain('Ready bot')
    expect(wrapper.text()).toContain('created automatically and is connecting')
    expect(wrapper.find('.feishu-qr-progress').exists()).toBe(false)
    expect(wrapper.find('.feishu-setup-history').exists()).toBe(false)
    wrapper.unmount()
  })

  it('reconnects bots and confirms before removing a binding', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([binding])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.reconnectFeishuBot.mockResolvedValue({ ...bot, status: 'connecting' })
    api.removeFeishuBinding.mockResolvedValue(undefined)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    const reconnectButton = wrapper.findAll('.feishu-form-actions button').find((button) => button.text() === 'Reconnect')
    await reconnectButton?.trigger('click')
    await flushPromises()
    expect(api.reconnectFeishuBot).toHaveBeenCalledWith('bot-1')
    await wrapper.get('.feishu-bindings .feishu-danger-button').trigger('click')
    await flushPromises()
    expect(api.removeFeishuBinding).toHaveBeenCalledWith('binding-1')
    expect(wrapper.find('.feishu-bindings .feishu-danger-button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows, pauses, and removes a fixed-session card route', async () => {
    const route = {
      id: 'route-1', botId: 'bot-1', chatId: 'oc_alerts', name: '差异播报', enabled: true,
      sourceSenderId: 'on_alert_bot', sourceSenderType: 'app', cardTitle: '【平台】差异播报',
      requiredKeywords: ['任务ID', '校验结果'], instruction: '分析根因', projectCwd: '/repo',
      projectName: 'CodyWeb', sessionId: 'thread-1', sessionTitle: 'Alert triage',
      scenarioPackageId: '', createdAtIso: '', updatedAtIso: '', lastMatchedAtIso: null, matchCount: 0,
    }
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([])
    api.fetchFeishuAutoRoutes.mockResolvedValue([route] as never)
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.setFeishuAutoRouteEnabled.mockResolvedValue({ ...route, enabled: false })
    api.setFeishuAutoRouteScenarioPackage.mockResolvedValue({ ...route, scenarioPackageId: 'scenario-alert' })
    promptApi.fetchPromptTemplates.mockResolvedValue([{
      id: 'scenario-alert', title: 'Alert investigation', description: 'Investigate alerts', content: 'Find the root cause.',
      primarySkill: { name: 'alert-triage', path: '/repo/.codex/skills/alert-triage/SKILL.md', displayName: 'Alert triage', description: '' },
      authoringMode: 'human', category: 'Troubleshooting', scope: 'workspace', workspaceCwd: '/repo',
      isFavorite: false, useCount: 0, lastUsedAtIso: '', createdAtIso: '', updatedAtIso: '',
    }] as never)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Card auto routes')
    expect(wrapper.text()).toContain('差异播报')
    expect(wrapper.text()).toContain('Alert triage')
    const packageSelect = wrapper.get('.feishu-auto-route-package select')
    await packageSelect.setValue('scenario-alert')
    await flushPromises()
    expect(api.setFeishuAutoRouteScenarioPackage).toHaveBeenCalledWith('route-1', 'scenario-alert')
    const switchButton = wrapper.get('.feishu-auto-route-actions [role="switch"]')
    expect(switchButton.attributes('aria-checked')).toBe('true')
    await switchButton.trigger('click')
    await flushPromises()
    expect(api.setFeishuAutoRouteEnabled).toHaveBeenCalledWith('route-1', false)
    await wrapper.get('.feishu-auto-route-actions .feishu-danger-button').trigger('click')
    await flushPromises()
    expect(api.removeFeishuAutoRoute).toHaveBeenCalledWith('route-1')
    wrapper.unmount()
  })

  it('shows safe health diagnostics and refreshes the selected bot', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([binding])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Health diagnostics')
    expect(wrapper.text()).toContain('card.update')
    expect(wrapper.text()).toContain('rate limited')
    expect(wrapper.text()).toContain('Retry scheduled')
    expect(wrapper.text()).toContain('Permanently stopped')
    expect(wrapper.text()).toContain('Message payloads, prompts, secrets, and approval contents are never returned.')
    await wrapper.get('.feishu-diagnostics-actions .feishu-secondary-button').trigger('click')
    await flushPromises()
    expect(api.fetchFeishuDiagnostics).toHaveBeenCalledWith('bot-1')
    await wrapper.get('.feishu-diagnostic-recents li .feishu-secondary-button').trigger('click')
    await flushPromises()
    expect(api.retryFeishuDelivery).toHaveBeenCalledWith('bot-1', 'outbox-1')
    expect(wrapper.text()).toContain('returned to the retry queue')
    wrapper.unmount()
  })

  it('runs a live diagnostic and renders every required connectivity proof', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([binding])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.diagnoseFeishuBot.mockResolvedValue(connectivityReport)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await wrapper.get('.feishu-live-diagnostic-button').trigger('click')
    await flushPromises()
    expect(api.diagnoseFeishuBot).toHaveBeenCalledWith('bot-1')
    expect(wrapper.text()).toContain('Live connectivity verified')
    expect(wrapper.text()).toContain('Event long connection')
    expect(wrapper.text()).toContain('Feishu credential API')
    expect(wrapper.text()).toContain('Bot identity match')
    expect(wrapper.findAll('.feishu-connectivity-report li')).toHaveLength(6)
    wrapper.unmount()
  })

  it('requires confirmation and preserves Codex sessions when deleting a bot', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([binding])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.deleteFeishuBot.mockResolvedValue({ remoteDisabled: false })
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    await wrapper.get('.feishu-delete-bot-button').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Shared Codex sessions will not be deleted'))
    expect(api.deleteFeishuBot).toHaveBeenCalledWith('bot-1', 'keep')
    expect(wrapper.text()).toContain('No Feishu bot configured')
    wrapper.unmount()
  })

  it('requires an explicit second confirmation before disabling the remote bot', async () => {
    api.fetchFeishuBots.mockResolvedValue([bot])
    api.fetchFeishuBindings.mockResolvedValue([binding])
    api.fetchFeishuDiagnostics.mockResolvedValue(diagnostics)
    api.deleteFeishuBot.mockResolvedValue({ remoteDisabled: true })
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const wrapper = mount(FeishuBotPanel)
    await flushPromises()
    const remoteOption = wrapper.get('input[name="feishu-delete-mode"][value="disable"]')
    await remoteOption.setValue(true)
    await wrapper.get('.feishu-delete-bot-button').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Disable the remote bot capability'))
    expect(api.deleteFeishuBot).toHaveBeenCalledWith('bot-1', 'disable')
    expect(wrapper.text()).toContain('remote Feishu bot was disabled')
    wrapper.unmount()
  })
})
