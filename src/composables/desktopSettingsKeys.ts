export const DESKTOP_STORAGE_KEYS = {
  autoRefreshEnabled: 'cody-web-ui.auto-refresh-enabled.v1',
  defaultNewThreadCwd: 'cody-web-ui.default-new-thread-cwd.v1',
  projectDisplayName: 'cody-web-ui.project-display-name.v1',
  projectOrder: 'cody-web-ui.project-order.v1',
  locale: 'cody-web-ui.locale.v1',
  readState: 'cody-web-ui.thread-read-state.v1',
  scrollState: 'cody-web-ui.thread-scroll-state.v1',
  selectedThread: 'cody-web-ui.selected-thread-id.v1',
  sidebarCollapsed: 'cody-web-ui.sidebar-collapsed.v1',
  theme: 'cody-web-ui.theme.v1',
  themeImportedSkins: 'cody-web-ui.theme.imported-skins.v1',
  turnPreferences: 'cody-web-ui.turn-preferences.v1',
} as const

export const DESKTOP_SETTING_KEYS = {
  defaultNewThreadCwd: 'desktop.default-new-thread-cwd.v1',
  locale: 'desktop.locale.v1',
  theme: 'theme.preferences.v1',
  themeImportedSkins: 'theme.imported-skins.v1',
  tokenFlameWidget: 'token-flame.widget.v1',
  codyGrowth: 'cody-growth.v1',
  promptLibrary: 'prompt-library.templates.v1',
  turnPreferences: 'desktop.turn-preferences.v1',
} as const

export type DesktopStorageKey = typeof DESKTOP_STORAGE_KEYS[keyof typeof DESKTOP_STORAGE_KEYS]
export type DesktopSettingKey = typeof DESKTOP_SETTING_KEYS[keyof typeof DESKTOP_SETTING_KEYS]
