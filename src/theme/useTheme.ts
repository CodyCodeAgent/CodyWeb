import { computed, ref, watch } from 'vue'
import { fetchUserSetting, writeUserSetting } from '../api/codexSettingsClient'
import { DESKTOP_SETTING_KEYS, DESKTOP_STORAGE_KEYS } from '../composables/desktopSettingsKeys'
import { BUILT_IN_SKINS } from './skins'
import { loadBuiltInSkinMaterials } from './skinMaterialRegistry'
import {
  getBuiltInSkin,
  getLayoutPreset,
  normalizeAccentColor,
  normalizeThemeDensity,
  normalizeThemePreferences,
  normalizeWorkspaceThemePreferences,
  parseSkinPack,
  resolveSkinPack,
  resolveThemeTokens,
  serializeSkinPack,
  supportedSkinColorModes,
  themeTokensToCssVariables,
} from './themeRegistry'
import type { LayoutPresetId, SkinAssets, SkinPack, ThemeColorMode, ThemeDensity, ThemePreferences, WorkspaceThemePreferences } from './tokens'
import { DEFAULT_THEME_PREFERENCES } from './tokens'

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function hasDocument(): boolean {
  return typeof document !== 'undefined'
}

const MAX_IMPORTED_SKINS = 20
const BUILT_IN_SKIN_IDS = new Set(BUILT_IN_SKINS.map((skin) => skin.id))

function isBuiltInSkinId(skinId: string): boolean {
  return BUILT_IN_SKIN_IDS.has(skinId)
}

function normalizeImportedSkins(value: unknown): SkinPack[] {
  if (!Array.isArray(value)) return []
  const skinsById = new Map<string, SkinPack>()
  for (const item of value) {
    try {
      const skin = parseSkinPack(JSON.stringify(item))
      if (isBuiltInSkinId(skin.id)) continue
      // Keep the most recently stored package when persisted data contains duplicates.
      skinsById.delete(skin.id)
      skinsById.set(skin.id, skin)
    } catch {
      // Ignore malformed persisted packages without hiding the remaining valid skins.
    }
  }
  return Array.from(skinsById.values()).slice(-MAX_IMPORTED_SKINS)
}

function loadImportedSkins(): SkinPack[] {
  if (!hasWindow()) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DESKTOP_STORAGE_KEYS.themeImportedSkins) ?? '[]') as unknown
    return normalizeImportedSkins(parsed)
  } catch {
    return []
  }
}

function loadPreferences(skins: SkinPack[]): ThemePreferences {
  if (!hasWindow()) return DEFAULT_THEME_PREFERENCES
  try {
    return normalizeThemePreferences(JSON.parse(window.localStorage.getItem(DESKTOP_STORAGE_KEYS.theme) ?? 'null'), {
      skins,
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
  window.localStorage.setItem(DESKTOP_STORAGE_KEYS.themeImportedSkins, JSON.stringify(nextSkins))
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

const initialImportedSkins = loadImportedSkins()
const importedSkins = ref<SkinPack[]>(initialImportedSkins)
const preferences = ref<ThemePreferences>(loadPreferences(initialImportedSkins))
const workspacePreferences = ref<WorkspaceThemePreferences | null>(null)
const loadedBuiltInMaterials = ref<Record<string, SkinAssets>>({})
const themePersistenceError = ref('')
const systemPrefersDark = ref(hasWindow() && window.matchMedia('(prefers-color-scheme: dark)').matches)
let preferenceChangeVersion = 0

function allSkins(): SkinPack[] {
  return [...BUILT_IN_SKINS, ...importedSkins.value.filter((skin) => !isBuiltInSkinId(skin.id))]
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
  if (override.colorMode) next.colorMode = override.colorMode
  return next
}

const availableSkins = computed(() => allSkins())
const effectivePreferences = computed(() => applyWorkspaceOverrides(preferences.value, workspacePreferences.value))
const selectedSkin = computed(() => findSkin(effectivePreferences.value.skinId))
const materializedSkin = computed<SkinPack>(() => {
  const skin = selectedSkin.value
  const loadedAssets = loadedBuiltInMaterials.value[skin.id]
  return loadedAssets ? { ...skin, assets: { ...skin.assets, ...loadedAssets } } : skin
})
const resolvedSkin = computed(() => resolveSkinPack(
  materializedSkin.value,
  effectivePreferences.value.colorMode,
  systemPrefersDark.value,
))
const resolvedTokens = computed(() => resolveThemeTokens(resolvedSkin.value, effectivePreferences.value))
const availableColorModes = computed(() => supportedSkinColorModes(selectedSkin.value))
const activeLayoutPreset = computed(() => getLayoutPreset(effectivePreferences.value.layoutPresetId))
const isDarkTheme = computed(() => resolvedSkin.value.isDark)
const isActiveSkinImported = computed(() => (
  !isBuiltInSkinId(resolvedSkin.value.id)
  && importedSkins.value.some((skin) => skin.id === resolvedSkin.value.id)
))
const themeRootClass = computed(() => (isDarkTheme.value ? 'app-dark' : ''))
const themeAttributes = computed(() => ({
  'data-theme-skin': resolvedSkin.value.id,
  'data-theme-color-mode': resolvedSkin.value.colorMode,
  'data-skin-api': String(resolvedSkin.value.manifest.schemaVersion),
  'data-skin-recipe-chrome': resolvedSkin.value.recipes.chrome,
  'data-skin-recipe-navigation': resolvedSkin.value.recipes.navigation,
  'data-skin-recipe-panel': resolvedSkin.value.recipes.panel,
  'data-skin-recipe-control': resolvedSkin.value.recipes.control,
  'data-skin-recipe-message': resolvedSkin.value.recipes.message,
  'data-skin-recipe-identity': resolvedSkin.value.recipes.identity,
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
  root.dataset.themeColorMode = resolvedSkin.value.colorMode
  root.dataset.skinApi = String(resolvedSkin.value.manifest.schemaVersion)
  root.dataset.skinRecipeChrome = resolvedSkin.value.recipes.chrome
  root.dataset.skinRecipeNavigation = resolvedSkin.value.recipes.navigation
  root.dataset.skinRecipePanel = resolvedSkin.value.recipes.panel
  root.dataset.skinRecipeControl = resolvedSkin.value.recipes.control
  root.dataset.skinRecipeMessage = resolvedSkin.value.recipes.message
  root.dataset.skinRecipeIdentity = resolvedSkin.value.recipes.identity
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
  const assistantAvatar = resolvedSkin.value.assets?.assistantAvatar
  const userAvatar = resolvedSkin.value.assets?.userAvatar
  root.style.setProperty('--skin-background-image', backgroundAsset ? `url("${backgroundAsset}")` : 'none')
  root.style.setProperty('--skin-background-fit', resolvedSkin.value.background?.fit ?? 'cover')
  root.style.setProperty('--skin-background-position', resolvedSkin.value.background?.position ?? 'center')
  root.style.setProperty('--skin-brand-image', brandAsset ? `url("${brandAsset}")` : 'none')
  root.style.setProperty('--skin-assistant-avatar', assistantAvatar ? `url("${assistantAvatar}")` : 'none')
  root.style.setProperty('--skin-user-avatar', userAvatar ? `url("${userAvatar}")` : 'none')
}

function normalizeKnownPreferences(nextPreferences: ThemePreferences): ThemePreferences {
  return normalizeThemePreferences(nextPreferences, {
    skins: allSkins(),
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
    skins: allSkins(),
  })
}

function setSkin(skinId: string): void {
  const skin = findSkin(skinId)
  const requestedMode = preferences.value.colorMode
  commitPreferences({
    ...preferences.value,
    skinId: skin.id,
    colorMode: requestedMode === 'system' || skin.variants[requestedMode]
      ? requestedMode
      : skin.defaultColorMode,
  })
}

function setColorMode(value: ThemeColorMode): void {
  if (value !== 'system' && !selectedSkin.value.variants[value]) return
  commitPreferences({
    ...preferences.value,
    colorMode: value,
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
  setColorMode(value ? 'system' : resolvedSkin.value.colorMode)
}

function setWorkspaceThemePreferences(value: unknown): void {
  const normalized = normalizeWorkspaceThemePreferences(value)
  const hasWorkspaceTheme =
    normalized.skinId ||
    normalized.accentColor ||
    normalized.density ||
    normalized.layoutPresetId ||
    normalized.colorMode
  workspacePreferences.value = hasWorkspaceTheme ? normalized : null
}

function clearWorkspaceThemePreferences(): void {
  workspacePreferences.value = null
}

function toggleLightDark(): void {
  const targetMode = isDarkTheme.value ? 'light' : 'dark'
  if (!availableColorModes.value.includes(targetMode)) return
  setColorMode(targetMode)
}

function resetTheme(): void {
  commitPreferences(DEFAULT_THEME_PREFERENCES)
}

function exportActiveSkin(): string {
  return serializeSkinPack(materializedSkin.value)
}

function importSkin(value: string): SkinPack {
  const skin = parseSkinPack(value)
  if (isBuiltInSkinId(skin.id)) {
    throw new Error(`Skin id "${skin.id}" is reserved by a built-in skin.`)
  }
  const nextSkins = [
    ...importedSkins.value.filter((candidate) => candidate.id !== skin.id),
    skin,
  ].slice(-MAX_IMPORTED_SKINS)
  // Persist before publishing reactive state so a quota failure cannot create a ghost install.
  saveImportedSkins(nextSkins)
  importedSkins.value = nextSkins
  void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, nextSkins, 'imported skins')
  setSkin(skin.id)
  return skin
}

function removeImportedSkin(skinId: string): void {
  if (isBuiltInSkinId(skinId)) throw new Error('Built-in skins cannot be removed.')
  if (!importedSkins.value.some((skin) => skin.id === skinId)) return
  const nextSkins = importedSkins.value.filter((skin) => skin.id !== skinId)
  // Keep the selected skin and list untouched when local persistence fails.
  saveImportedSkins(nextSkins)
  importedSkins.value = nextSkins
  void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, nextSkins, 'imported skins')
  if (preferences.value.skinId === skinId) setSkin(DEFAULT_THEME_PREFERENCES.skinId)
}

async function hydrateThemeFromSettingsStore(): Promise<void> {
  const hydrationStartVersion = preferenceChangeVersion
  const remoteImportedSkins = await readRemoteSetting<unknown[]>(DESKTOP_SETTING_KEYS.themeImportedSkins)
  if (Array.isArray(remoteImportedSkins)) {
    const nextSkins = normalizeImportedSkins(remoteImportedSkins)
    importedSkins.value = nextSkins
    try {
      saveImportedSkins(nextSkins)
    } catch {
      themePersistenceError.value = 'Could not cache imported skins in this browser; server settings remain available.'
    }
  } else if (importedSkins.value.length > 0) {
    void saveRemoteSetting(DESKTOP_SETTING_KEYS.themeImportedSkins, importedSkins.value, 'imported skins')
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
  watch(selectedSkin, async (skin) => {
    if (loadedBuiltInMaterials.value[skin.id]) return
    try {
      const materials = await loadBuiltInSkinMaterials(skin.id)
      if (!materials) return
      loadedBuiltInMaterials.value = { ...loadedBuiltInMaterials.value, [skin.id]: materials }
      applyCurrentTheme()
    } catch {
      // Keep the skin usable when an optional material chunk cannot be loaded.
    }
  }, { immediate: true })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    systemPrefersDark.value = event.matches
    if (effectivePreferences.value.colorMode === 'system') applyCurrentTheme()
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
    availableColorModes,
    isDarkTheme,
    isActiveSkinImported,
    themeRootClass,
    themeAttributes,
    applyCurrentTheme,
    updatePreferences,
    setSkin,
    setColorMode,
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
