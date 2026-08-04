import { describe, expect, it } from 'vitest'
import { BUILT_IN_SKINS } from './skins'
import {
  contrastingTextColor,
  contrastRatio,
  getBuiltInSkin,
  getLayoutPreset,
  normalizeThemePreferences,
  normalizeWorkspaceThemePreferences,
  parseSkinPack,
  resolveSkinPack,
  resolveThemeTokens,
  serializeSkinPack,
  supportedSkinColorModes,
  themeTokensToCssVariables,
} from './themeRegistry'

describe('theme registry', () => {
  it('registers the expected built-in skin packs', () => {
    expect(BUILT_IN_SKINS.map((skin) => skin.id)).toEqual([
      'codex-classic',
      'control-tower',
      'cyber-ops',
      'light-pro',
      'qq-2007',
      'terminal',
      'mobile-focus',
    ])
    for (const skin of BUILT_IN_SKINS) {
      expect(supportedSkinColorModes(skin), skin.id).toEqual(['light', 'dark'])
    }
    const qq = getBuiltInSkin('qq-2007')!
    expect(resolveSkinPack(qq, 'light')).toMatchObject({ id: 'qq-2007', isDark: false, syntaxTheme: 'light' })
    expect(resolveSkinPack(qq, 'dark')).toMatchObject({ id: 'qq-2007', isDark: true, syntaxTheme: 'dark' })
    expect(resolveSkinPack(qq, 'dark').recipes).toEqual(resolveSkinPack(qq, 'light').recipes)
  })

  it('normalizes stored preferences to safe defaults', () => {
    expect(normalizeThemePreferences({
      skinId: 'missing',
      accentColor: 'not-a-color',
      density: 'huge',
      layoutPresetId: 'unknown',
      followSystem: true,
    })).toEqual({
      skinId: 'control-tower',
      accentColor: '',
      density: 'comfortable',
      layoutPresetId: 'ops-dashboard',
      colorMode: 'system',
    })
  })

  it('allows imported skin ids when normalizing stored preferences', () => {
    expect(normalizeThemePreferences({
      skinId: 'custom-ops',
      accentColor: '#abcdef',
      density: 'compact',
      layoutPresetId: 'mobile-review',
      colorMode: 'dark',
    }, { skinIds: ['custom-ops'] })).toMatchObject({
      skinId: 'custom-ops',
      accentColor: '#abcdef',
      density: 'compact',
      layoutPresetId: 'mobile-review',
    })
  })

  it('normalizes workspace theme overrides without inventing missing fields', () => {
    expect(normalizeWorkspaceThemePreferences({
      skinId: 'cyber-ops',
      accentColor: '#22d3ee',
      density: 'compact',
      layoutPresetId: 'review-focus',
      colorMode: 'dark',
    })).toEqual({
      skinId: 'cyber-ops',
      accentColor: '#22d3ee',
      density: 'compact',
      layoutPresetId: 'review-focus',
      colorMode: 'dark',
    })

    expect(normalizeWorkspaceThemePreferences({
      accentColor: 'not-a-color',
      density: 'huge',
      layoutPresetId: 'unknown',
    })).toEqual({
      skinId: '',
      accentColor: '',
      density: '',
      layoutPresetId: '',
      colorMode: '',
    })
  })

  it('resolves accent overrides into CSS variables', () => {
    const skin = getBuiltInSkin('light-pro')
    expect(skin).not.toBeNull()

    const tokens = resolveThemeTokens(resolveSkinPack(skin!, 'light'), {
      skinId: 'light-pro',
      colorMode: 'light',
      accentColor: '#123456',
      density: 'spacious',
      layoutPresetId: 'ide-mode',
    })
    const variables = themeTokensToCssVariables(tokens)

    expect(tokens.color.accent).toBe('#123456')
    expect(tokens.density).toBe('spacious')
    expect(variables['--color-accent']).toBe('#123456')
    expect(variables['--color-on-accent']).toBe('#ffffff')
    expect(variables['--density-scale']).toBe('1.12')
  })

  it('chooses readable foregrounds for bright and dark semantic colors', () => {
    expect(contrastingTextColor('#facc15')).toBe('#0b0e13')
    expect(contrastingTextColor('#1d4ed8')).toBe('#ffffff')
  })

  it('keeps every built-in skin readable across core and action surfaces', () => {
    for (const skin of BUILT_IN_SKINS) {
      for (const mode of supportedSkinColorModes(skin)) {
        const { color } = resolveSkinPack(skin, mode).tokens
        expect(contrastRatio(color.text, color.background), `${skin.id}/${mode}: text/background`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(color.text, color.panel), `${skin.id}/${mode}: text/panel`).toBeGreaterThanOrEqual(4.5)

        for (const semanticColor of [color.accent, color.danger, color.warning, color.success, color.info]) {
          expect(contrastRatio(contrastingTextColor(semanticColor), semanticColor), `${skin.id}/${mode}: action foreground`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps dark skin CSS variable palettes distinct', () => {
    const controlTower = getBuiltInSkin('control-tower')
    const terminal = getBuiltInSkin('terminal')
    expect(controlTower).not.toBeNull()
    expect(terminal).not.toBeNull()

    const basePreferences = {
      skinId: 'control-tower',
      accentColor: '',
      density: 'comfortable',
      layoutPresetId: 'ops-dashboard',
      colorMode: 'dark',
    } as const
    const controlVariables = themeTokensToCssVariables(resolveThemeTokens(resolveSkinPack(controlTower!, 'dark'), basePreferences))
    const terminalVariables = themeTokensToCssVariables(resolveThemeTokens(resolveSkinPack(terminal!, 'dark'), {
      ...basePreferences,
      skinId: 'terminal',
    }))

    expect(controlVariables['--color-background']).not.toBe(terminalVariables['--color-background'])
    expect(controlVariables['--color-panel']).not.toBe(terminalVariables['--color-panel'])
    expect(controlVariables['--color-accent']).not.toBe(terminalVariables['--color-accent'])
    expect(controlVariables['--color-code-background']).toBe(controlVariables['--color-terminal-background'])
    expect(terminalVariables['--color-code-background']).toBe('#000000')
  })

  it('round-trips skin JSON and validates malformed imports', () => {
    const skin = getBuiltInSkin('terminal')
    expect(skin).not.toBeNull()

    expect(parseSkinPack(serializeSkinPack(skin!))).toMatchObject({
      id: 'terminal',
      name: 'Terminal',
    })
    expect(() => parseSkinPack('{}')).toThrow('id is invalid.')
  })

  it('round-trips portable identity avatar assets', () => {
    const skin = getBuiltInSkin('terminal')
    expect(skin).not.toBeNull()
    const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const parsed = parseSkinPack(serializeSkinPack({
      ...skin!,
      recipes: { ...skin!.recipes, identity: 'avatars' },
      assets: { assistantAvatar: avatar, userAvatar: avatar },
    }))
    expect(parsed.recipes.identity).toBe('avatars')
    expect(parsed.assets?.assistantAvatar).toMatch(/^data:image\/png;base64,/u)
    expect(parsed.assets?.userAvatar).toMatch(/^data:image\/png;base64,/u)
  })

  it('upgrades legacy color-only skins to a single-mode Skin API v2 package', () => {
    const source = resolveSkinPack(getBuiltInSkin('light-pro')!, 'light')
    const legacy: Record<string, unknown> = {
      id: source.id,
      name: source.name,
      description: source.description,
      isDark: source.isDark,
      tokens: source.tokens,
      syntaxTheme: source.syntaxTheme,
      terminalTheme: source.terminalTheme,
      chartPalette: source.chartPalette,
      background: source.background,
    }
    const parsed = parseSkinPack(JSON.stringify(legacy))
    expect(parsed.manifest).toMatchObject({ schemaVersion: 2, version: '1.0.0', author: 'Imported' })
    expect(parsed.defaultColorMode).toBe('light')
    expect(supportedSkinColorModes(parsed)).toEqual(['light'])
    expect(parsed.recipes).toMatchObject({
      chrome: 'native',
      navigation: 'native',
      panel: 'native',
      control: 'native',
      message: 'native',
      identity: 'none',
      composer: 'native',
      backdrop: 'solid',
    })
  })

  it('rejects executable, remote, oversized, and unsupported skin capabilities', () => {
    const base = JSON.parse(serializeSkinPack(getBuiltInSkin('qq-2007')!)) as Record<string, unknown>
    expect(() => parseSkinPack(JSON.stringify({ ...base, recipes: { ...(base.recipes as object), chrome: 'javascript' } })))
      .toThrow('recipes.chrome is not supported.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, assets: { background: 'https://example.com/skin.png' } })))
      .toThrow('must be a stored CodyWeb asset or an embedded PNG, JPEG, or WebP data URL.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, assets: { brandMark: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })))
      .toThrow('must be a stored CodyWeb asset or an embedded PNG, JPEG, or WebP data URL.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, manifest: { ...(base.manifest as object), schemaVersion: 3 } })))
      .toThrow('Unsupported skin schema version: 3.')
    expect(() => parseSkinPack(' '.repeat(1_500_001))).toThrow('Skin package exceeds 1.5 MB.')
  })

  it('accepts a bounded embedded raster asset and selects the image backdrop recipe', () => {
    const base = JSON.parse(serializeSkinPack(getBuiltInSkin('light-pro')!)) as Record<string, unknown>
    const parsed = parseSkinPack(JSON.stringify({
      ...base,
      assets: { background: 'data:image/png;base64,iVBORw0KGgo=' },
    }))
    expect(parsed.assets?.background).toMatch(/^data:image\/png;base64,/u)
    expect(parsed.recipes.backdrop).toBe('image')
  })

  it('returns ops dashboard for unknown layout presets', () => {
    expect(getLayoutPreset('missing').id).toBe('ops-dashboard')
  })
})
