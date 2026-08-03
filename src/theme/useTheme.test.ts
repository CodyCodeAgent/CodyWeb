// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_STORAGE_KEYS } from '../composables/desktopSettingsKeys'
import { installTestLocalStorage } from '../test/localStorage'
import { getBuiltInSkin, serializeSkinPack } from './themeRegistry'

const settingsClientMock = vi.hoisted(() => ({
  fetchUserSetting: vi.fn().mockResolvedValue(null),
  writeUserSetting: vi.fn().mockResolvedValue({ key: '', value: null, updatedAtIso: '' }),
}))

vi.mock('../api/codexSettingsClient', () => settingsClientMock)

function importedSkinJson(id = 'custom-theme'): string {
  const skin = getBuiltInSkin('light-pro')
  if (!skin) throw new Error('Expected light-pro test skin.')
  return serializeSkinPack({
    ...skin,
    id,
    name: 'Custom Theme',
    manifest: { ...skin.manifest, author: 'Test' },
  })
}

async function freshTheme() {
  vi.resetModules()
  return (await import('./useTheme')).useTheme()
}

beforeEach(() => {
  installTestLocalStorage()
  window.localStorage.clear()
  settingsClientMock.fetchUserSetting.mockResolvedValue(null)
  settingsClientMock.writeUserSetting.mockResolvedValue({ key: '', value: null, updatedAtIso: '' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('imported theme persistence', () => {
  it('switches QQ light and dark variants without replacing the selected skin', async () => {
    const theme = await freshTheme()
    theme.setSkin('qq-2007')
    theme.setColorMode('light')
    const lightBackground = theme.activeTokens.value.color.background

    theme.toggleLightDark()

    expect(theme.preferences.value.skinId).toBe('qq-2007')
    expect(theme.preferences.value.colorMode).toBe('dark')
    expect(theme.activeSkin.value).toMatchObject({ id: 'qq-2007', colorMode: 'dark', isDark: true })
    expect(theme.activeSkin.value.recipes.identity).toBe('avatars')
    expect(theme.activeTokens.value.color.background).not.toBe(lightBackground)
  })

  it('migrates the legacy follow-system preference without changing its skin', async () => {
    window.localStorage.setItem(DESKTOP_STORAGE_KEYS.theme, JSON.stringify({
      skinId: 'qq-2007',
      followSystem: true,
      density: 'compact',
      layoutPresetId: 'ops-dashboard',
    }))

    const theme = await freshTheme()

    expect(theme.preferences.value.skinId).toBe('qq-2007')
    expect(theme.preferences.value.colorMode).toBe('system')
  })

  it('does not publish an imported skin when local persistence runs out of space', async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === DESKTOP_STORAGE_KEYS.themeImportedSkins) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      Storage.prototype.setItem.call(window.localStorage, key, value)
    })
    const theme = await freshTheme()

    expect(() => theme.importSkin(importedSkinJson())).toThrow('Quota exceeded')
    expect(theme.availableSkins.value.some((skin) => skin.id === 'custom-theme')).toBe(false)
    expect(theme.activeSkin.value.id).not.toBe('custom-theme')
    setItem.mockRestore()
  })

  it('keeps an installed skin when removing it cannot be persisted', async () => {
    const theme = await freshTheme()
    theme.importSkin(importedSkinJson())
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === DESKTOP_STORAGE_KEYS.themeImportedSkins) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      Storage.prototype.setItem.call(window.localStorage, key, value)
    })

    expect(() => theme.removeImportedSkin('custom-theme')).toThrow('Quota exceeded')
    expect(theme.availableSkins.value.some((skin) => skin.id === 'custom-theme')).toBe(true)
    expect(theme.activeSkin.value.id).toBe('custom-theme')
    setItem.mockRestore()
  })

  it('drops persisted packages that collide with built-in skin ids', async () => {
    const builtIn = getBuiltInSkin('qq-2007')
    if (!builtIn) throw new Error('Expected qq-2007 test skin.')
    window.localStorage.setItem(DESKTOP_STORAGE_KEYS.themeImportedSkins, JSON.stringify([
      { ...builtIn, name: 'Fake QQ' },
      JSON.parse(importedSkinJson()),
    ]))

    const theme = await freshTheme()
    expect(theme.availableSkins.value.filter((skin) => skin.id === 'qq-2007')).toHaveLength(1)
    expect(theme.availableSkins.value.find((skin) => skin.id === 'qq-2007')?.name).toBe(builtIn.name)
    theme.setSkin('qq-2007')
    expect(theme.isActiveSkinImported.value).toBe(false)
  })
})
