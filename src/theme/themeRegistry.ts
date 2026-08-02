import { BUILT_IN_SKINS } from './skins'
import type {
  LayoutPreset,
  LayoutPresetId,
  SkinPack,
  ThemeDensity,
  ThemePreferences,
  ThemeTokens,
  WorkspaceThemePreferences,
} from './tokens'
import { DEFAULT_SKIN_RECIPES, DEFAULT_THEME_PREFERENCES, SKIN_API_VERSION } from './tokens'

const MAX_SKIN_PACKAGE_BYTES = 1_500_000
const MAX_SKIN_ASSET_BYTES = 512_000
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/iu
const RECIPE_VALUES = {
  chrome: ['native', 'glossy', 'terminal'],
  navigation: ['native', 'classic', 'pill'],
  panel: ['native', 'beveled', 'glass'],
  control: ['native', 'beveled', 'outline'],
  message: ['native', 'bubble', 'rail'],
  composer: ['native', 'beveled', 'glass'],
  backdrop: ['solid', 'aero-grid', 'grid', 'image'],
} as const

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'chat-focus',
    name: 'Chat Focus',
    description: 'Conversation and composer first.',
  },
  {
    id: 'review-focus',
    name: 'Review Focus',
    description: 'Diff, validation, and approvals first.',
  },
  {
    id: 'ops-dashboard',
    name: 'Ops Dashboard',
    description: 'Workspace health and task supervision first.',
  },
  {
    id: 'ide-mode',
    name: 'IDE Mode',
    description: 'Files, terminal, git, and preview first.',
  },
  {
    id: 'mobile-review',
    name: 'Mobile Review',
    description: 'Status, approvals, and summaries first.',
  },
]

export function getBuiltInSkin(skinId: string): SkinPack | null {
  return BUILT_IN_SKINS.find((skin) => skin.id === skinId) ?? null
}

export function getLayoutPreset(layoutPresetId: string): LayoutPreset {
  return LAYOUT_PRESETS.find((preset) => preset.id === layoutPresetId) ?? LAYOUT_PRESETS[2]
}

export function normalizeThemeDensity(value: unknown): ThemeDensity {
  return value === 'compact' || value === 'comfortable' || value === 'spacious' ? value : 'comfortable'
}

function isColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.test(value.trim())
}

export function normalizeAccentColor(value: string): string {
  const normalized = value.trim()
  return normalized && isColor(normalized) ? normalized : ''
}

export function normalizeThemePreferences(
  value: unknown,
  options: { skinIds?: string[] } = {},
): ThemePreferences {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const knownSkinIds = new Set([
    ...BUILT_IN_SKINS.map((skin) => skin.id),
    ...(options.skinIds ?? []),
  ])
  const skinId = typeof row.skinId === 'string' && knownSkinIds.has(row.skinId)
    ? row.skinId
    : DEFAULT_THEME_PREFERENCES.skinId
  const layoutPresetId = typeof row.layoutPresetId === 'string'
    ? getLayoutPreset(row.layoutPresetId).id
    : DEFAULT_THEME_PREFERENCES.layoutPresetId
  return {
    skinId,
    accentColor: typeof row.accentColor === 'string' ? normalizeAccentColor(row.accentColor) : '',
    density: normalizeThemeDensity(row.density),
    layoutPresetId: layoutPresetId as LayoutPresetId,
    followSystem: row.followSystem === true,
  }
}

export function normalizeWorkspaceThemePreferences(value: unknown): WorkspaceThemePreferences {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const density = typeof row.density === 'string' &&
    (row.density === 'compact' || row.density === 'comfortable' || row.density === 'spacious')
    ? row.density
    : ''
  const layoutPresetId = typeof row.layoutPresetId === 'string' &&
    LAYOUT_PRESETS.some((preset) => preset.id === row.layoutPresetId)
    ? row.layoutPresetId as WorkspaceThemePreferences['layoutPresetId']
    : ''
  return {
    skinId: typeof row.skinId === 'string' ? row.skinId.trim() : '',
    accentColor: typeof row.accentColor === 'string' ? normalizeAccentColor(row.accentColor) : '',
    density,
    layoutPresetId,
    followSystem: typeof row.followSystem === 'boolean' ? row.followSystem : null,
  }
}

export function resolveThemeTokens(skin: SkinPack, preferences: ThemePreferences): ThemeTokens {
  return {
    ...skin.tokens,
    color: {
      ...skin.tokens.color,
      accent: preferences.accentColor || skin.tokens.color.accent,
    },
    density: preferences.density,
  }
}

function parseHexColor(value: string): [number, number, number] | null {
  const normalized = value.trim().replace(/^#/u, '')
  const expanded = normalized.length === 3
    ? normalized.split('').map((character) => `${character}${character}`).join('')
    : normalized
  if (!/^[0-9a-f]{6}$/iu.test(expanded)) return null
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number]
}

function luminance(color: [number, number, number]): number {
  const channels = color.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundColor = parseHexColor(foreground)
  const backgroundColor = parseHexColor(background)
  if (!foregroundColor || !backgroundColor) return 1
  const lighter = Math.max(luminance(foregroundColor), luminance(backgroundColor))
  const darker = Math.min(luminance(foregroundColor), luminance(backgroundColor))
  return (lighter + 0.05) / (darker + 0.05)
}

export function contrastingTextColor(background: string): '#0b0e13' | '#ffffff' {
  const parsed = parseHexColor(background)
  if (!parsed) return '#ffffff'
  const backgroundLuminance = luminance(parsed)
  const darkContrast = (backgroundLuminance + 0.05) / 0.05
  const lightContrast = 1.05 / (backgroundLuminance + 0.05)
  return darkContrast >= lightContrast ? '#0b0e13' : '#ffffff'
}

export function themeTokensToCssVariables(tokens: ThemeTokens): Record<string, string> {
  return {
    '--color-background': tokens.color.background,
    '--color-surface': tokens.color.surface,
    '--color-panel': tokens.color.panel,
    '--color-elevated': tokens.color.elevated,
    '--color-text': tokens.color.text,
    '--color-text-muted': tokens.color.textMuted,
    '--color-border': tokens.color.border,
    '--color-accent': tokens.color.accent,
    '--color-danger': tokens.color.danger,
    '--color-warning': tokens.color.warning,
    '--color-success': tokens.color.success,
    '--color-info': tokens.color.info,
    '--color-on-accent': contrastingTextColor(tokens.color.accent),
    '--color-on-danger': contrastingTextColor(tokens.color.danger),
    '--color-on-warning': contrastingTextColor(tokens.color.warning),
    '--color-on-success': contrastingTextColor(tokens.color.success),
    '--color-on-info': contrastingTextColor(tokens.color.info),
    '--color-code-background': tokens.color.codeBackground,
    '--color-terminal-background': tokens.color.terminalBackground,
    '--font-sans': tokens.font.sans,
    '--font-mono': tokens.font.mono,
    '--space-xs': tokens.spacing.xs,
    '--space-sm': tokens.spacing.sm,
    '--space-md': tokens.spacing.md,
    '--space-lg': tokens.spacing.lg,
    '--radius-sm': tokens.radius.sm,
    '--radius-md': tokens.radius.md,
    '--radius-lg': tokens.radius.lg,
    '--shadow-panel': tokens.shadow.panel,
    '--shadow-floating': tokens.shadow.floating,
    '--shadow-focus': tokens.shadow.focus,
    '--motion-fast': tokens.motion.fast,
    '--motion-normal': tokens.motion.normal,
    '--motion-slow': tokens.motion.slow,
    '--density-scale': tokens.density === 'compact' ? '0.9' : tokens.density === 'spacious' ? '1.12' : '1',
  }
}

export function serializeSkinPack(skin: SkinPack): string {
  return `${JSON.stringify(parseSkinPack(JSON.stringify(skin)), null, 2)}\n`
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function safeString(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value.trim()
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is not supported.`)
  return value as T
}

function colorValue(value: unknown, label: string): string {
  const color = safeString(value, label, 9)
  if (!isColor(color)) throw new Error(`${label} must be a hex color.`)
  return color
}

function cssValue(value: unknown, label: string, maxLength = 240): string {
  const result = safeString(value, label, maxLength)
  if (/[{};]|url\s*\(|@import|expression\s*\(/iu.test(result)) throw new Error(`${label} contains unsupported CSS.`)
  return result
}

function imageAsset(value: unknown, label: string): string {
  const asset = safeString(value, label, MAX_SKIN_ASSET_BYTES * 2)
  const match = DATA_IMAGE_PATTERN.exec(asset)
  if (!match) throw new Error(`${label} must be an embedded PNG, JPEG, or WebP data URL.`)
  const decodedBytes = Math.floor(match[1].length * 3 / 4) - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0)
  if (decodedBytes > MAX_SKIN_ASSET_BYTES) throw new Error(`${label} exceeds 500 KB.`)
  return asset
}

function normalizedTokens(value: unknown): ThemeTokens {
  const row = objectRow(value, 'tokens')
  const color = objectRow(row.color, 'tokens.color')
  const font = objectRow(row.font, 'tokens.font')
  const spacing = objectRow(row.spacing, 'tokens.spacing')
  const radius = objectRow(row.radius, 'tokens.radius')
  const shadow = objectRow(row.shadow, 'tokens.shadow')
  const motion = objectRow(row.motion, 'tokens.motion')
  return {
    color: {
      background: colorValue(color.background, 'tokens.color.background'),
      surface: colorValue(color.surface, 'tokens.color.surface'),
      panel: colorValue(color.panel, 'tokens.color.panel'),
      elevated: colorValue(color.elevated, 'tokens.color.elevated'),
      text: colorValue(color.text, 'tokens.color.text'),
      textMuted: colorValue(color.textMuted, 'tokens.color.textMuted'),
      border: colorValue(color.border, 'tokens.color.border'),
      accent: colorValue(color.accent, 'tokens.color.accent'),
      danger: colorValue(color.danger, 'tokens.color.danger'),
      warning: colorValue(color.warning, 'tokens.color.warning'),
      success: colorValue(color.success, 'tokens.color.success'),
      info: colorValue(color.info, 'tokens.color.info'),
      codeBackground: colorValue(color.codeBackground, 'tokens.color.codeBackground'),
      terminalBackground: colorValue(color.terminalBackground, 'tokens.color.terminalBackground'),
    },
    font: {
      sans: cssValue(font.sans, 'tokens.font.sans'),
      mono: cssValue(font.mono, 'tokens.font.mono'),
    },
    spacing: {
      xs: cssValue(spacing.xs, 'tokens.spacing.xs', 32),
      sm: cssValue(spacing.sm, 'tokens.spacing.sm', 32),
      md: cssValue(spacing.md, 'tokens.spacing.md', 32),
      lg: cssValue(spacing.lg, 'tokens.spacing.lg', 32),
    },
    radius: {
      sm: cssValue(radius.sm, 'tokens.radius.sm', 32),
      md: cssValue(radius.md, 'tokens.radius.md', 32),
      lg: cssValue(radius.lg, 'tokens.radius.lg', 32),
    },
    shadow: {
      panel: cssValue(shadow.panel, 'tokens.shadow.panel'),
      floating: cssValue(shadow.floating, 'tokens.shadow.floating'),
      focus: cssValue(shadow.focus, 'tokens.shadow.focus'),
    },
    motion: {
      fast: cssValue(motion.fast, 'tokens.motion.fast', 32),
      normal: cssValue(motion.normal, 'tokens.motion.normal', 32),
      slow: cssValue(motion.slow, 'tokens.motion.slow', 32),
    },
    density: normalizeThemeDensity(row.density),
  }
}

export function parseSkinPack(value: string): SkinPack {
  if (new TextEncoder().encode(value).byteLength > MAX_SKIN_PACKAGE_BYTES) throw new Error('Skin package exceeds 1.5 MB.')
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error('Skin package is not valid JSON.')
  }
  const row = objectRow(parsed, 'Skin package')
  const id = safeString(row.id, 'id', 64)
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(id)) throw new Error('id must use 2–64 lowercase letters, numbers, or hyphens.')
  const manifestRow = row.manifest === undefined ? {} : objectRow(row.manifest, 'manifest')
  const schemaVersion = manifestRow.schemaVersion ?? SKIN_API_VERSION
  if (schemaVersion !== SKIN_API_VERSION) throw new Error(`Unsupported skin schema version: ${String(schemaVersion)}.`)
  const recipesRow = row.recipes === undefined ? {} : objectRow(row.recipes, 'recipes')
  const assetsRow = row.assets === undefined ? null : objectRow(row.assets, 'assets')
  const backgroundRow = row.background === undefined ? null : objectRow(row.background, 'background')
  const terminalThemeRow = objectRow(row.terminalTheme, 'terminalTheme')
  const chartPalette = Array.isArray(row.chartPalette) ? row.chartPalette : []
  if (chartPalette.length < 1 || chartPalette.length > 12) throw new Error('chartPalette must contain 1–12 colors.')
  const homepage = manifestRow.homepage === undefined ? '' : safeString(manifestRow.homepage, 'manifest.homepage', 300)
  if (homepage && !/^https?:\/\//u.test(homepage)) throw new Error('manifest.homepage must use http or https.')
  const pack: SkinPack = {
    manifest: {
      schemaVersion: SKIN_API_VERSION,
      version: manifestRow.version === undefined ? '1.0.0' : safeString(manifestRow.version, 'manifest.version', 40),
      author: manifestRow.author === undefined ? 'Imported' : safeString(manifestRow.author, 'manifest.author', 100),
      ...(homepage ? { homepage } : {}),
      ...(manifestRow.chromeLabel === undefined ? {} : { chromeLabel: safeString(manifestRow.chromeLabel, 'manifest.chromeLabel', 24) }),
    },
    id,
    name: safeString(row.name, 'name', 80),
    description: safeString(row.description ?? '', 'description', 240, true),
    isDark: row.isDark === true,
    tokens: normalizedTokens(row.tokens),
    syntaxTheme: safeString(row.syntaxTheme, 'syntaxTheme', 40),
    terminalTheme: Object.fromEntries(Object.entries(terminalThemeRow).map(([key, entry]) => [
      safeString(key, 'terminalTheme key', 40),
      colorValue(entry, `terminalTheme.${key}`),
    ])),
    chartPalette: chartPalette.map((entry, index) => colorValue(entry, `chartPalette[${index}]`)),
    recipes: Object.fromEntries(Object.entries(RECIPE_VALUES).map(([key, allowed]) => [
      key,
      enumValue(recipesRow[key] ?? DEFAULT_SKIN_RECIPES[key as keyof typeof DEFAULT_SKIN_RECIPES], allowed, `recipes.${key}`),
    ])) as SkinPack['recipes'],
    ...(assetsRow ? { assets: {
      ...(assetsRow.background === undefined ? {} : { background: imageAsset(assetsRow.background, 'assets.background') }),
      ...(assetsRow.brandMark === undefined ? {} : { brandMark: imageAsset(assetsRow.brandMark, 'assets.brandMark') }),
    } } : {}),
    ...(backgroundRow ? { background: {
      type: enumValue(backgroundRow.type ?? 'solid', ['solid', 'grid', 'noise', 'image', 'animated'] as const, 'background.type'),
      ...(backgroundRow.fit === undefined ? {} : { fit: enumValue(backgroundRow.fit, ['cover', 'contain'] as const, 'background.fit') }),
      ...(backgroundRow.position === undefined ? {} : { position: safeString(backgroundRow.position, 'background.position', 40) }),
    } } : {}),
  }
  if (pack.assets?.background && pack.recipes.backdrop !== 'image') {
    pack.recipes.backdrop = 'image'
  }
  return pack
}
