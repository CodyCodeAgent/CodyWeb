// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestLocalStorage } from '../../test/localStorage'
import { useTheme } from '../../theme/useTheme'
import WorkspaceThemePanel from './WorkspaceThemePanel.vue'

const settingsClientMock = vi.hoisted(() => ({
  fetchUserSetting: vi.fn().mockResolvedValue(null),
  writeUserSetting: vi.fn().mockResolvedValue({ key: '', value: null, updatedAtIso: '' }),
}))

vi.mock('../../api/codexSettingsClient', () => settingsClientMock)

beforeEach(() => {
  installTestLocalStorage()
  window.localStorage.clear()
  const theme = useTheme()
  theme.setSkin('qq-2007')
  theme.setColorMode('light')
})

describe('WorkspaceThemePanel color modes', () => {
  it('switches variants without changing the selected skin', async () => {
    const wrapper = mount(WorkspaceThemePanel)
    const theme = useTheme()

    await wrapper.get('[data-testid="theme-color-mode-select"]').setValue('dark')

    expect(theme.preferences.value.skinId).toBe('qq-2007')
    expect(theme.preferences.value.colorMode).toBe('dark')
    expect(theme.activeSkin.value).toMatchObject({ id: 'qq-2007', colorMode: 'dark', isDark: true })
    expect(wrapper.get('[data-testid="theme-summary"]').text()).toContain('QQ 2007')
  })

  it('keeps skin selection available while following the system', async () => {
    const theme = useTheme()
    theme.setColorMode('system')
    const wrapper = mount(WorkspaceThemePanel)

    expect(wrapper.get('[data-testid="theme-skin-select"]').attributes('disabled')).toBeUndefined()
    expect((wrapper.get('[data-testid="theme-color-mode-select"]').element as HTMLSelectElement).value).toBe('system')
  })
})
