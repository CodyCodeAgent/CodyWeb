import type { UiConversationShareSnapshot, UiConversationShareThemeSnapshot } from '../types/codex.js'

export const FALLBACK_SHARE_THEME: UiConversationShareThemeSnapshot = {
  skinId: 'shared-default',
  skinName: 'CodyWeb',
  colorMode: 'light',
  colors: {
    background: '#f5f7fb', surface: '#ffffff', panel: '#ffffff', elevated: '#f8fafc',
    text: '#172033', textMuted: '#5f6d85', border: '#dce3ee', accent: '#1967d2', codeBackground: '#111827',
  },
  fonts: { sans: 'Inter, Arial, sans-serif', mono: 'SFMono-Regular, Consolas, monospace' },
  radii: { sm: '8px', md: '14px', lg: '20px' },
  recipes: { message: 'native', identity: 'none', panel: 'native', backdrop: 'solid' },
  background: null,
  assets: {},
}

export function conversationShareTheme(snapshot: UiConversationShareSnapshot): UiConversationShareThemeSnapshot {
  return snapshot.theme ?? FALLBACK_SHARE_THEME
}

export function cssVariables(theme: UiConversationShareThemeSnapshot): string {
  const backgroundImage = theme.assets.background ? `url("${theme.assets.background}")` : 'none'
  return [
    `--share-bg:${theme.colors.background}`,
    `--share-surface:${theme.colors.surface}`,
    `--share-panel:${theme.colors.panel}`,
    `--share-elevated:${theme.colors.elevated}`,
    `--share-text:${theme.colors.text}`,
    `--share-muted:${theme.colors.textMuted}`,
    `--share-border:${theme.colors.border}`,
    `--share-accent:${theme.colors.accent}`,
    `--share-code:${theme.colors.codeBackground}`,
    `--share-font:${theme.fonts.sans}`,
    `--share-mono:${theme.fonts.mono}`,
    `--share-radius-sm:${theme.radii.sm}`,
    `--share-radius-md:${theme.radii.md}`,
    `--share-radius-lg:${theme.radii.lg}`,
    `--share-background-image:${backgroundImage}`,
    `--share-background-fit:${theme.background?.fit ?? 'cover'}`,
    `--share-background-position:${theme.background?.position ?? 'center'}`,
    `--share-background-blur:${String(theme.background?.blur ?? 0)}px`,
    `--share-background-dim:${String(theme.background?.dim ?? 30)}%`,
    `--share-background-saturation:${String(theme.background?.saturation ?? 100)}%`,
  ].join(';')
}

function parseHex(value: string): [number, number, number] {
  const normalized = value.slice(1, 7)
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number]
}

export function mixHex(foreground: string, background: string, foregroundRatio: number): string {
  const foregroundColor = parseHex(foreground)
  const backgroundColor = parseHex(background)
  const ratio = Math.max(0, Math.min(1, foregroundRatio))
  const channels = foregroundColor.map((channel, index) => Math.round(channel * ratio + backgroundColor[index]! * (1 - ratio)))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}
