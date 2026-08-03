export type ThemeDensity = 'compact' | 'comfortable' | 'spacious'
export type ThemeColorMode = 'light' | 'dark' | 'system'
export type ResolvedThemeColorMode = Exclude<ThemeColorMode, 'system'>

export const SKIN_API_VERSION = 2 as const

export type SkinRecipes = {
  chrome: 'native' | 'glossy' | 'terminal'
  navigation: 'native' | 'classic' | 'pill'
  panel: 'native' | 'beveled' | 'glass'
  control: 'native' | 'beveled' | 'outline'
  message: 'native' | 'bubble' | 'rail'
  identity: 'none' | 'avatars'
  composer: 'native' | 'beveled' | 'glass'
  backdrop: 'solid' | 'aero-grid' | 'grid' | 'image'
}

export type SkinAssets = {
  background?: string
  brandMark?: string
  assistantAvatar?: string
  userAvatar?: string
}

export type SkinManifest = {
  schemaVersion: typeof SKIN_API_VERSION
  version: string
  author: string
  homepage?: string
  chromeLabel?: string
}

export type ThemeTokens = {
  color: {
    background: string
    surface: string
    panel: string
    elevated: string
    text: string
    textMuted: string
    border: string
    accent: string
    danger: string
    warning: string
    success: string
    info: string
    codeBackground: string
    terminalBackground: string
  }
  font: {
    sans: string
    mono: string
  }
  spacing: {
    xs: string
    sm: string
    md: string
    lg: string
  }
  radius: {
    sm: string
    md: string
    lg: string
  }
  shadow: {
    panel: string
    floating: string
    focus: string
  }
  motion: {
    fast: string
    normal: string
    slow: string
  }
  density: ThemeDensity
}

export type SkinVariant = {
  tokens: ThemeTokens
  syntaxTheme: 'light' | 'dark' | string
  terminalTheme: Record<string, string>
  chartPalette: string[]
  background?: {
    type: 'solid' | 'grid' | 'noise' | 'image' | 'animated'
    fit?: 'cover' | 'contain'
    position?: string
  }
}

export type SkinPack = {
  manifest: SkinManifest
  id: string
  name: string
  description: string
  defaultColorMode: ResolvedThemeColorMode
  variants: Partial<Record<ResolvedThemeColorMode, SkinVariant>>
  recipes: SkinRecipes
  assets?: SkinAssets
}

export type ResolvedSkinPack = Omit<SkinPack, 'defaultColorMode' | 'variants'> & SkinVariant & {
  colorMode: ResolvedThemeColorMode
  isDark: boolean
}

export const DEFAULT_SKIN_RECIPES: SkinRecipes = {
  chrome: 'native',
  navigation: 'native',
  panel: 'native',
  control: 'native',
  message: 'native',
  identity: 'none',
  composer: 'native',
  backdrop: 'solid',
}

export type LayoutPresetId = 'chat-focus' | 'review-focus' | 'ops-dashboard' | 'ide-mode' | 'mobile-review'

export type LayoutPreset = {
  id: LayoutPresetId
  name: string
  description: string
}

export type ThemePreferences = {
  skinId: string
  colorMode: ThemeColorMode
  accentColor: string
  density: ThemeDensity
  layoutPresetId: LayoutPresetId
}

export type WorkspaceThemePreferences = {
  skinId: string
  colorMode: ThemeColorMode | ''
  accentColor: string
  density: ThemeDensity | ''
  layoutPresetId: LayoutPresetId | ''
}

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  skinId: 'control-tower',
  colorMode: 'dark',
  accentColor: '',
  density: 'comfortable',
  layoutPresetId: 'ops-dashboard',
}
