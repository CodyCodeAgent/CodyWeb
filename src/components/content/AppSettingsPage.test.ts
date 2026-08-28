// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestLocalStorage } from '../../test/localStorage'
import AppSettingsPage from './AppSettingsPage.vue'

const settingsClientMock = vi.hoisted(() => ({
  fetchUserSetting: vi.fn(),
  writeUserSetting: vi.fn(),
}))
const catalogClientMock = vi.hoisted(() => ({
  fetchCatalogStatus: vi.fn(),
  syncCatalogNow: vi.fn(),
}))

vi.mock('../../api/codexSettingsClient', () => settingsClientMock)
vi.mock('../../api/codexCatalogClient', () => catalogClientMock)

const globalStubs = {
  FeishuBotPanel: { template: '<div data-testid="feishu-panel">Feishu panel</div>' },
  WorkspaceThemePanel: { template: '<div data-testid="theme-panel">Theme panel</div>' },
  AgentTasksPanel: { template: '<div data-testid="agent-tasks-panel">Agent tasks</div>' },
  BackgroundTasksPanel: { template: '<div data-testid="background-tasks-panel">Background tasks</div>' },
}

beforeEach(() => {
  installTestLocalStorage()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/settings')
  settingsClientMock.fetchUserSetting.mockResolvedValue(null)
  settingsClientMock.writeUserSetting.mockResolvedValue({ key: 'token-flame-widget', value: {}, updatedAtIso: new Date().toISOString() })
  catalogClientMock.fetchCatalogStatus.mockResolvedValue({
    name: 'catalog-sync', running: false, runCount: 1, successCount: 1, failureCount: 0,
    lastStartedAtIso: null, lastSuccessAtIso: null, lastFailureAtIso: null,
    lastDurationMs: null, lastError: '', nextRunAtIso: null,
  })
  catalogClientMock.syncCatalogNow.mockResolvedValue(null)
})

afterEach(() => vi.clearAllMocks())

describe('AppSettingsPage', () => {
  it('shows one focused settings area and switches sections from grouped navigation', async () => {
    const wrapper = mount(AppSettingsPage, { global: { stubs: globalStubs } })
    await flushPromises()

    expect(wrapper.find('[data-testid="theme-panel"]').exists()).toBe(true)
    expect(wrapper.find('#settings-about').exists()).toBe(false)
    expect(wrapper.get('[data-section="appearance"]').attributes('aria-current')).toBe('page')

    await wrapper.get('[data-section="about"]').trigger('click')
    expect(wrapper.find('[data-testid="theme-panel"]').exists()).toBe(false)
    expect(wrapper.find('#settings-about').exists()).toBe(true)
    expect(window.location.hash).toBe('#settings-about')
  })

  it('filters settings and uses the URL hash as a deep link', async () => {
    window.history.replaceState({}, '', '/settings#settings-language')
    const wrapper = mount(AppSettingsPage, { global: { stubs: globalStubs } })
    await flushPromises()

    expect(wrapper.find('#settings-language').exists()).toBe(true)
    await wrapper.get('.app-settings-search input').setValue('catalog')
    await flushPromises()

    expect(wrapper.findAll('.app-settings-nav-group button')).toHaveLength(1)
    expect(wrapper.get('[data-section="catalog"]').attributes('aria-current')).toBe('page')
    expect(wrapper.find('#settings-catalog').exists()).toBe(true)

    await wrapper.get('.app-settings-search input').setValue('definitely-missing')
    expect(wrapper.find('.app-settings-no-results').exists()).toBe(true)
    await wrapper.get('.app-settings-no-results button').trigger('click')
    expect(wrapper.findAll('.app-settings-nav-group button')).toHaveLength(7)
  })
})
