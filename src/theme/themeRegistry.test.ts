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
  resolveThemeTokens,
  serializeSkinPack,
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
    expect(getBuiltInSkin('control-tower')?.isDark).toBe(true)
    expect(getBuiltInSkin('qq-2007')).toMatchObject({ isDark: false, syntaxTheme: 'light' })
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
      followSystem: true,
    })
  })

  it('allows imported skin ids when normalizing stored preferences', () => {
    expect(normalizeThemePreferences({
      skinId: 'custom-ops',
      accentColor: '#abcdef',
      density: 'compact',
      layoutPresetId: 'mobile-review',
      followSystem: false,
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
      followSystem: false,
    })).toEqual({
      skinId: 'cyber-ops',
      accentColor: '#22d3ee',
      density: 'compact',
      layoutPresetId: 'review-focus',
      followSystem: false,
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
      followSystem: null,
    })
  })

  it('resolves accent overrides into CSS variables', () => {
    const skin = getBuiltInSkin('light-pro')
    expect(skin).not.toBeNull()

    const tokens = resolveThemeTokens(skin!, {
      skinId: 'light-pro',
      accentColor: '#123456',
      density: 'spacious',
      layoutPresetId: 'ide-mode',
      followSystem: false,
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
      const { color } = skin.tokens
      expect(contrastRatio(color.text, color.background), `${skin.id}: text/background`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(color.text, color.panel), `${skin.id}: text/panel`).toBeGreaterThanOrEqual(4.5)

      for (const semanticColor of [color.accent, color.danger, color.warning, color.success, color.info]) {
        expect(contrastRatio(contrastingTextColor(semanticColor), semanticColor), `${skin.id}: action foreground`).toBeGreaterThanOrEqual(4.5)
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
      followSystem: false,
    } as const
    const controlVariables = themeTokensToCssVariables(resolveThemeTokens(controlTower!, basePreferences))
    const terminalVariables = themeTokensToCssVariables(resolveThemeTokens(terminal!, {
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

  it('upgrades legacy color-only skins to Skin API v1 defaults', () => {
    const legacy = JSON.parse(serializeSkinPack(getBuiltInSkin('light-pro')!)) as Record<string, unknown>
    delete legacy.manifest
    delete legacy.recipes
    const parsed = parseSkinPack(JSON.stringify(legacy))
    expect(parsed.manifest).toMatchObject({ schemaVersion: 1, version: '1.0.0', author: 'Imported' })
    expect(parsed.recipes).toMatchObject({
      chrome: 'native',
      navigation: 'native',
      panel: 'native',
      control: 'native',
      message: 'native',
      composer: 'native',
      backdrop: 'solid',
    })
  })

  it('rejects executable, remote, oversized, and unsupported skin capabilities', () => {
    const base = JSON.parse(serializeSkinPack(getBuiltInSkin('qq-2007')!)) as Record<string, unknown>
    expect(() => parseSkinPack(JSON.stringify({ ...base, recipes: { ...(base.recipes as object), chrome: 'javascript' } })))
      .toThrow('recipes.chrome is not supported.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, assets: { background: 'https://example.com/skin.png' } })))
      .toThrow('must be an embedded PNG, JPEG, or WebP data URL.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, assets: { brandMark: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })))
      .toThrow('must be an embedded PNG, JPEG, or WebP data URL.')
    expect(() => parseSkinPack(JSON.stringify({ ...base, manifest: { ...(base.manifest as object), schemaVersion: 2 } })))
      .toThrow('Unsupported skin schema version: 2.')
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
