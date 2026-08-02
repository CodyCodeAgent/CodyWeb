import { computed, ref, watch } from 'vue'
import { fetchUserSetting, writeUserSetting } from '../api/codexSettingsClient'
import { DESKTOP_SETTING_KEYS, DESKTOP_STORAGE_KEYS } from '../composables/desktopSettingsKeys'
import { BUILT_IN_SKINS } from './skins'
import {
  getBuiltInSkin,
  getLayoutPreset,
  normalizeAccentColor,
  normalizeThemeDensity,
  normalizeThemePreferences,
  normalizeWorkspaceThemePreferences,
  parseSkinPack,
  resolveThemeTokens,
  serializeSkinPack,
  themeTokensToCssVariables,
} from './themeRegistry'
import type { LayoutPresetId, SkinPack, ThemeDensity, ThemePreferences, WorkspaceThemePreferences } from './tokens'
import { DEFAULT_THEME_PREFERENCES } from './tokens'

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function hasDocument(): boolean {
  return typeof document !== 'undefined'
}

function loadImportedSkins(): SkinPack[] {
  if (!hasWindow()) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_STORAGE_KEYS.themeImportedSkins) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        try {
          return parseSkinPack(JSON.stringify(item))
        } catch {
          return null
        }
      })
      .filter((item): item is SkinPack => Boolean(item))
      .slice(0, 20)
  } catch {
    return []
  }
}

function loadPreferences(skins: SkinPack[]): ThemePreferences {
  if (!hasWindow()) return DEFAULT_THEME_PREFERENCES
  try {
    return normalizeThemePreferences(JSON.parse(window.localStorage.getItem(DESKTOP_STORAGE_KEYS.theme) ?? 'null'), {
      skinIds: skins.map((skin) => skin.id),
    })
  } catch {
    return DEFAULT_THEME_PREFERENCES
  }
}

function savePreferences(nextPreferences: ThemePreferences): void {
  if (!hasWindow()) return
  window.localStorage.setItem(DESKTOP_STORAGE_KEYS.theme, JSON.stringify(nextPreferences))
}

function saveImportedSkins(nextSkins: SkinPack[]): void {
  if (!hasWindow()) return
  window.localStorage.setItem(DESKTOP_STORAGE_KEYS.themeImportedSkins, JSON.stringify(nextSkins.slice(0, 20)))
}

async function readRemoteSetting<T>(key: string): Promise<T | null> {
  if (!hasWindow()) return null
  try {
    const setting = await fetchUserSetting<T>(key)
    return setting?.value ?? null
  } catch {
    return null
  }
}

async function saveRemoteSetting(key: string, value: unknown, label = 'theme settings'): Promise<void> {
  if (!hasWindow()) return
  try {
    await writeUserSetting(key, value)
    themePersistenceError.value = ''
  } catch {
    themePersistenceError.value = `Could not save ${label}; check the local settings database.`
  }
}

function preferredSystemSkinId(): string {
  if (!hasWindow() || !window.matchMedia('(prefers-color-scheme: dark)').matches) return 'light-pro'
  return 'control-tower'
}

const initialImportedSkins = loadImportedSkins()
const importedSkins = ref<SkinPack[]>(initialImportedSkins)
const preferences = ref<ThemePreferences>(loadPreferences(initialImportedSkins))
const workspacePreferences = ref<WorkspaceThemePreferences | null>(null)
const themePersistenceError = ref('')
let preferenceChangeVersion = 0

function allSkins(): SkinPack[] {
  const builtInIds = new Set(BUILT_IN_SKINS.map((skin) => skin.id))
  const importedById = new Map(importedSkins.value.filter((skin) => !builtInIds.has(skin.id)).map((skin) => [skin.id, skin]))
  return [
    ...BUILT_IN_SKINS.filter((skin) => !importedById.has(skin.id)),
    ...importedSkins.value,
  ]
}

function findSkin(skinId: string): SkinPack {
  return allSkins().find((skin) => skin.id === skinId) ?? getBuiltInSkin(DEFAULT_THEME_PREFERENCES.skinId) ?? BUILT_IN_SKINS[0]
}

function applyWorkspaceOverrides(
  basePreferences: ThemePreferences,
  override: WorkspaceThemePreferences | null,
): ThemePreferences {
  if (!override) return basePreferences
  const next: ThemePreferences = { ...basePreferences }
  if (override.skinId && allSkins().some((skin) => skin.id === override.skinId)) {
    next.skinId = override.skinId
  }
  if (override.accentColor) next.accentColor = override.accentColor
  if (override.density) next.density = override.density
  if (override.layoutPresetId) next.layoutPresetId = override.layoutPresetId
  if (override.followSystem !== null) next.followSystem = override.followSystem
  return next
}

const availableSkins = computed(() => allSkins())
const effectivePreferences = computed(() => applyWorkspaceOverrides(preferences.value, workspacePreferences.value))
const resolvedSkin = computed(() => findSkin(
  effectivePreferences.value.followSystem ? preferredSystemSkinId() : effectivePreferences.value.skinId,
))
const resolvedTokens = computed(() => resolveThemeTokens(resolvedSkin.value, effectivePreferences.value))
const activeLayoutPreset = computed(() => getLayoutPreset(effectivePreferences.value.layoutPresetId))
const isDarkTheme = computed(() => resolvedSkin.value.isDark)
const isActiveSkinImported = computed(() => importedSkins.value.some((skin) => skin.id === resolvedSkin.value.id))
const themeRootClass = computed(() => (isDarkTheme.value ? 'app-dark' : ''))
const themeAttributes = computed(() => ({
  'data-theme-skin': resolvedSkin.value.id,
  'data-skin-api': String(resolvedSkin.value.manifest.schemaVersion),
  'data-skin-recipe-chrome': resolvedSkin.value.recipes.chrome,
  'data-skin-recipe-navigation': resolvedSkin.value.recipes.navigation,
  'data-skin-recipe-panel': resolvedSkin.value.recipes.panel,
  'data-skin-recipe-control': resolvedSkin.value.recipes.control,
  'data-skin-recipe-message': resolvedSkin.value.recipes.message,
  'data-skin-recipe-composer': resolvedSkin.value.recipes.composer,
  'data-skin-recipe-backdrop': resolvedSkin.value.recipes.backdrop,
  'data-skin-chrome-label': resolvedSkin.value.manifest.chromeLabel ?? '',
  'data-skin-has-background': resolvedSkin.value.assets?.background ? 'true' : 'false',
  'data-skin-has-brand': resolvedSkin.value.assets?.brandMark ? 'true' : 'false',
  'data-theme-density': effectivePreferences.value.density,
  'data-layout-preset': effectivePreferences.value.layoutPresetId,
}))

function applyCurrentTheme(): void {
  if (!hasDocument()) return
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeTokensToCssVariables(resolvedTokens.value))) {
    root.style.setProperty(name, value)
  }
  root.dataset.themeSkin = resolvedSkin.value.id
  root.dataset.skinApi = String(resolvedSkin.value.manifest.schemaVersion)
  root.dataset.skinRecipeChrome = resolvedSkin.value.recipes.chrome
  root.dataset.skinRecipeNavigation = resolvedSkin.value.recipes.navigation
  root.dataset.skinRecipePanel = resolvedSkin.value.recipes.panel
  root.dataset.skinRecipeControl = resolvedSkin.value.recipes.control
  root.dataset.skinRecipeMessage = resolvedSkin.value.recipes.message
  root.dataset.skinRecipeComposer = resolvedSkin.value.recipes.composer
  root.dataset.skinRecipeBackdrop = resolvedSkin.value.recipes.backdrop
  root.dataset.skinChromeLabel = resolvedSkin.value.manifest.chromeLabel ?? ''
  root.dataset.skinHasBackground = resolvedSkin.value.assets?.background ? 'true' : 'false'
  root.dataset.skinHasBrand = resolvedSkin.value.assets?.brandMark ? 'true' : 'false'
  root.dataset.themeDensity = effectivePreferences.value.density
  root.dataset.layoutPreset = effectivePreferences.value.layoutPresetId
  root.style.colorScheme = resolvedSkin.value.isDark ? 'dark' : 'light'
  const backgroundAsset = resolvedSkin.value.assets?.background
  const brandAsset = resolvedSkin.value.assets?.brandMark
  root.style.setProperty('--skin-background-image', backgroundAsset ? `url("${backgroundAsset}")` : 'none')
  root.style.setProperty('--skin-background-fit', resolvedSkin.value.background?.fit ?? 'cover')
  root.style.setProperty('--skin-background-position', resolvedSkin.value.background?.position ?? 'center')
  root.style.setProperty('--skin-brand-image', brandAsset ? `url("${brandAsset}")` : 'none')
}

function normalizeKnownPreferences(nextPreferences: ThemePreferences): ThemePreferences {
  return normalizeThemePreferences(nextPreferences, {
    skinIds: allSkins().map((skin) => skin.id),
  })
}

function commitPreferences(nextPreferences: ThemePreferences): void {
  preferenceChangeVersion += 1
  preferences.value = normalizeKnownPreferences(nextPreferences)
}

function updatePreferences(nextPreferences: ThemePreferences): void {
  commitPreferences(nextPreferences)
}

function hydratePreferences(nextPreferences: unknown): void {
  preferences.value = normalizeThemePreferences(nextPreferences, {
    skinIds: allSkins().map((skin) => skin.id),
  })
}

function setSkin(skinId: string): void {
  const skin = findSkin(skinId)
  commitPreferences({
    ...preferences.value,
    skinId: skin.id,
    followSystem: false,
  })
}

function setAccentColor(value: string): void {
  commitPreferences({
    ...preferences.value,
    accentColor: normalizeAccentColor(value),
  })
}

function setDensity(value: ThemeDensity): void {
  commitPreferences({
    ...preferences.value,
    density: normalizeThemeDensity(value),
  })
}

function setLayoutPreset(value: LayoutPresetId): void {
  commitPreferences({
    ...preferences.value,
    layoutPresetId: getLayoutPreset(value).id,
  })
}

function setFollowSystem(value: boolean): void {
  commitPreferences({
    ...preferences.value,
    followSystem: value,
  })
}

function setWorkspaceThemePreferences(value: unknown): void {
  const normalized = normalizeWorkspaceThemePreferences(value)
  const hasWorkspaceTheme =
    normalized.skinId ||
    normalized.accentColor ||
    normalized.density ||
    normalized.layoutPresetId ||
    normalized.followSystem !== null
  workspacePreferences.value = hasWorkspaceTheme ? normalized : null
}

function clearWorkspaceThemePreferences(): void {
  workspacePreferences.value = null
}

function toggleLightDark(): void {
  setSkin(isDarkTheme.value ? 'light-pro' : 'control-tower')
}

function resetTheme(): void {
  commitPreferences(DEFAULT_THEME_PREFERENCES)
}

function exportActiveSkin(): string {
  return serializeSkinPack(resolvedSkin.value)
}

function importSkin(value: string): SkinPack {
  const skin = parseSkinPack(value)
  if (BUILT_IN_SKINS.some((candidate) => candidate.id === skin.id)) {
    throw new Error(`Skin id "${skin.id}" is reserved by a built-in skin.`)
  }
  importedSkins.value = [
    ...importedSkins.value.filter((candidate) => candidate.id !== skin.id),
    skin,
  ]
  saveImportedSkins(importedSkins.value)
  void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, importedSkins.value.slice(0, 20), 'imported skins')
  setSkin(skin.id)
  return skin
}

function removeImportedSkin(skinId: string): void {
  if (BUILT_IN_SKINS.some((skin) => skin.id === skinId)) throw new Error('Built-in skins cannot be removed.')
  if (!importedSkins.value.some((skin) => skin.id === skinId)) return
  importedSkins.value = importedSkins.value.filter((skin) => skin.id !== skinId)
  saveImportedSkins(importedSkins.value)
  void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, importedSkins.value.slice(0, 20), 'imported skins')
  if (preferences.value.skinId === skinId) setSkin(DEFAULT_THEME_PREFERENCES.skinId)
}

async function hydrateThemeFromSettingsStore(): Promise<void> {
  const hydrationStartVersion = preferenceChangeVersion
  const remoteImportedSkins = await readRemoteSetting<unknown[]>(DESKTOP_SETTING_KEYS.themeImportedSkins)
  if (Array.isArray(remoteImportedSkins)) {
    importedSkins.value = remoteImportedSkins
      .map((item) => {
        try {
          return parseSkinPack(JSON.stringify(item))
        } catch {
          return null
        }
      })
      .filter((item): item is SkinPack => Boolean(item))
      .slice(0, 20)
    saveImportedSkins(importedSkins.value)
  } else if (importedSkins.value.length > 0) {
    void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, importedSkins.value.slice(0, 20), 'imported skins')
  }

  const remotePreferences = await readRemoteSetting<unknown>(DESKTOP_SETTING_KEYS.theme)
  if (remotePreferences) {
    if (preferenceChangeVersion !== hydrationStartVersion) {
      void saveRemoteSetting(DESKTOP_SETTING_KEYS.theme, preferences.value)
      return
    }
    hydratePreferences(remotePreferences)
    savePreferences(preferences.value)
  } else {
    void saveRemoteSetting(DESKTOP_SETTING_KEYS.theme, preferences.value)
  }
}

watch(preferences, (nextPreferences) => {
  savePreferences(nextPreferences)
  void saveRemoteSetting(DESKTOP_SETTING_KEYS.theme, nextPreferences)
  applyCurrentTheme()
}, { deep: true })

watch(workspacePreferences, () => {
  applyCurrentTheme()
}, { deep: true })

if (hasWindow()) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preferences.value.followSystem) applyCurrentTheme()
  })
  applyCurrentTheme()
  void hydrateThemeFromSettingsStore()
}

export function useTheme() {
  return {
    preferences,
    effectivePreferences,
    workspacePreferences,
    themePersistenceError,
    availableSkins,
    activeSkin: resolvedSkin,
    activeTokens: resolvedTokens,
    activeLayoutPreset,
    isDarkTheme,
    isActiveSkinImported,
    themeRootClass,
    themeAttributes,
    applyCurrentTheme,
    updatePreferences,
    setSkin,
    setAccentColor,
    setDensity,
    setLayoutPreset,
    setFollowSystem,
    setWorkspaceThemePreferences,
    clearWorkspaceThemePreferences,
    toggleLightDark,
    resetTheme,
    exportActiveSkin,
    importSkin,
    removeImportedSkin,
  }
}
