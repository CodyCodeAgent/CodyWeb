<template>
  <section class="workspace-theme-panel" data-cody-component="panel" :aria-label="t('theme.aria')">
    <header class="workspace-theme-panel-header">
      <div>
        <h3 class="workspace-theme-panel-title">{{ t('theme.title') }}</h3>
        <p class="workspace-theme-panel-subtitle" data-testid="theme-summary">{{ themeSummary }}</p>
        <p
          v-if="themeDetail"
          class="workspace-theme-panel-detail"
          data-testid="theme-detail"
        >
          {{ themeDetail }}
        </p>
      </div>
      <button class="workspace-theme-panel-reset" type="button" @click="resetTheme">{{ t('theme.reset') }}</button>
    </header>

    <p
      v-if="hasWorkspaceThemeBinding"
      class="workspace-theme-panel-workspace-binding"
      data-testid="theme-workspace-binding"
    >
      {{ t('theme.workspaceBindingActive') }} · {{ workspaceThemeSummary }}
    </p>
    <p
      v-if="themePersistenceError"
      class="workspace-theme-panel-persistence-error"
      data-testid="theme-persistence-error"
      role="alert"
    >
      {{ themePersistenceError }}
    </p>

    <div class="workspace-theme-panel-grid">
      <label>
        <span>{{ t('theme.skin') }}</span>
        <select
          data-testid="theme-skin-select"
          :value="effectivePreferences.skinId"
          :disabled="hasWorkspaceThemeBinding"
          @change="onSkinSelect"
        >
          <option v-for="skin in availableSkins" :key="skin.id" :value="skin.id">{{ skin.name }}</option>
        </select>
      </label>

      <label>
        <span>{{ t('theme.mode') }}</span>
        <select
          data-testid="theme-color-mode-select"
          :value="effectivePreferences.colorMode"
          :disabled="hasWorkspaceThemeBinding"
          @change="onColorModeSelect"
        >
          <option value="light" :disabled="!availableColorModes.includes('light')">{{ t('theme.mode.light') }}</option>
          <option value="dark" :disabled="!availableColorModes.includes('dark')">{{ t('theme.mode.dark') }}</option>
          <option value="system">{{ t('theme.mode.system') }}</option>
        </select>
      </label>

      <label>
        <span>{{ t('theme.layout') }}</span>
        <select
          data-testid="theme-layout-select"
          :value="effectivePreferences.layoutPresetId"
          :disabled="hasWorkspaceThemeBinding"
          @change="onLayoutSelect"
        >
          <option v-for="preset in layoutPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </select>
      </label>

      <label>
        <span>{{ t('theme.density') }}</span>
        <select
          data-testid="theme-density-select"
          :value="effectivePreferences.density"
          :disabled="hasWorkspaceThemeBinding"
          @change="onDensitySelect"
        >
          <option value="compact">{{ t('theme.density.compact') }}</option>
          <option value="comfortable">{{ t('theme.density.comfortable') }}</option>
          <option value="spacious">{{ t('theme.density.spacious') }}</option>
        </select>
      </label>

      <label>
        <span>{{ t('theme.accent') }}</span>
        <input
          data-testid="theme-accent-input"
          :value="accentDraft"
          :disabled="hasWorkspaceThemeBinding"
          type="color"
          @input="onAccentInput"
        />
      </label>
    </div>

    <div class="workspace-theme-panel-package" data-testid="theme-package-actions">
      <div>
        <strong>{{ t('theme.package.title') }}</strong>
        <span>{{ t('theme.package.description') }}</span>
      </div>
      <div class="workspace-theme-panel-package-actions">
        <button type="button" data-testid="theme-package-download" @click="downloadSkinPackage">
          {{ t('theme.package.download') }}
        </button>
        <button type="button" data-testid="theme-package-import" @click="openSkinPackagePicker">
          {{ t('theme.package.import') }}
        </button>
        <button
          v-if="isImportedActiveSkin"
          type="button"
          data-testid="theme-package-remove"
          data-tone="danger"
          @click="removeActiveImportedSkin"
        >
          {{ t('theme.package.remove') }}
        </button>
        <input
          ref="skinPackageInputRef"
          class="workspace-theme-panel-package-input"
          type="file"
          accept=".cody-skin,application/json"
          @change="onSkinPackageChange"
        />
      </div>
    </div>

    <details class="workspace-theme-panel-advanced">
      <summary>{{ t('theme.skinJson') }}</summary>
      <div class="workspace-theme-panel-json-actions">
        <button type="button" @click="exportSkin">{{ t('theme.export') }}</button>
        <button type="button" @click="importSkinDraft">{{ t('theme.import') }}</button>
      </div>
      <textarea v-model="skinJsonDraft" spellcheck="false" />
      <p v-if="skinJsonMessage" class="workspace-theme-panel-message" :data-tone="skinJsonMessageTone">
        {{ skinJsonMessage }}
      </p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { LAYOUT_PRESETS } from '../../theme/themeRegistry'
import { useTheme } from '../../theme/useTheme'
import type { LayoutPresetId, ThemeColorMode, ThemeDensity } from '../../theme/tokens'
import type { UiWorkspaceConfig } from '../../types/codex'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  workspaceTheme?: UiWorkspaceConfig['theme'] | null
}>()

const {
  effectivePreferences,
  availableSkins,
  activeSkin,
  isActiveSkinImported,
  activeLayoutPreset,
  availableColorModes,
  workspacePreferences,
  themePersistenceError,
  setSkin,
  setColorMode,
  setAccentColor,
  setDensity,
  setLayoutPreset,
  setWorkspaceThemePreferences,
  clearWorkspaceThemePreferences,
  resetTheme,
  exportActiveSkin,
  importSkin,
  removeImportedSkin,
} = useTheme()
const { t } = useLocale()

const layoutPresets = LAYOUT_PRESETS
const skinJsonDraft = ref('')
const skinPackageInputRef = ref<HTMLInputElement | null>(null)
const skinJsonMessage = ref('')
const skinJsonMessageTone = ref<'success' | 'danger'>('success')
const accentDraft = computed(() => effectivePreferences.value.accentColor || activeSkin.value.tokens.color.accent)
const hasWorkspaceThemeBinding = computed(() => workspacePreferences.value !== null)
const isImportedActiveSkin = isActiveSkinImported
const selectedSkinName = computed(() =>
  availableSkins.value.find((skin) => skin.id === effectivePreferences.value.skinId)?.name ?? activeSkin.value.name,
)
const themeSummary = computed(() => {
  const mode = t(`theme.mode.${effectivePreferences.value.colorMode}`)
  return `${selectedSkinName.value} · ${mode} · ${activeLayoutPreset.value.name}`
})
const themeDetail = computed(() => {
  if (hasWorkspaceThemeBinding.value) return t('theme.detail.workspaceOverride')
  if (effectivePreferences.value.colorMode === 'system') {
    return t('theme.detail.activeMode', { mode: t(`theme.mode.${activeSkin.value.colorMode}`) })
  }
  if (effectivePreferences.value.accentColor) {
    return t('theme.detail.accentOverride', { value: effectivePreferences.value.accentColor })
  }
  return ''
})
const workspaceThemeSummary = computed(() => {
  const theme = workspacePreferences.value
  if (!theme) return t('theme.personalDefaults')
  const parts = [
    theme.skinId ? t('theme.summary.skin', { value: theme.skinId }) : '',
    theme.layoutPresetId ? t('theme.summary.layout', { value: theme.layoutPresetId }) : '',
    theme.density ? t('theme.summary.density', { value: theme.density }) : '',
    theme.accentColor ? t('theme.summary.accent', { value: theme.accentColor }) : '',
    theme.colorMode ? t('theme.summary.mode', { value: t(`theme.mode.${theme.colorMode}`) }) : '',
  ].filter(Boolean)
  return parts.join(' · ') || t('theme.workspaceDefaults')
})

function onSkinSelect(event: Event): void {
  setSkin((event.target as HTMLSelectElement).value)
}

function onColorModeSelect(event: Event): void {
  setColorMode((event.target as HTMLSelectElement).value as ThemeColorMode)
}

function onLayoutSelect(event: Event): void {
  setLayoutPreset((event.target as HTMLSelectElement).value as LayoutPresetId)
}

function onDensitySelect(event: Event): void {
  setDensity((event.target as HTMLSelectElement).value as ThemeDensity)
}

function onAccentInput(event: Event): void {
  setAccentColor((event.target as HTMLInputElement).value)
}


function exportSkin(): void {
  skinJsonDraft.value = exportActiveSkin()
  skinJsonMessage.value = t('theme.exported')
  skinJsonMessageTone.value = 'success'
}

function importSkinDraft(): void {
  try {
    const skin = importSkin(skinJsonDraft.value)
    skinJsonMessage.value = t('theme.imported', { name: skin.name })
    skinJsonMessageTone.value = 'success'
  } catch (error) {
    skinJsonMessage.value = error instanceof Error ? error.message : t('theme.importFailed')
    skinJsonMessageTone.value = 'danger'
  }
}

function skinPackageFilename(): string {
  const safeId = activeSkin.value.id.replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-')
  return `${safeId || 'cody-skin'}.cody-skin`
}

function downloadSkinPackage(): void {
  const packageText = exportActiveSkin()
  const url = URL.createObjectURL(new Blob([packageText], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = skinPackageFilename()
  anchor.hidden = true
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  skinJsonMessage.value = t('theme.package.downloaded')
  skinJsonMessageTone.value = 'success'
}

function openSkinPackagePicker(): void {
  skinPackageInputRef.value?.click()
}

async function onSkinPackageChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 1_500_000) {
    skinJsonMessage.value = t('theme.package.tooLarge')
    skinJsonMessageTone.value = 'danger'
    return
  }
  try {
    const skin = importSkin(await file.text())
    skinJsonDraft.value = exportActiveSkin()
    skinJsonMessage.value = t('theme.imported', { name: skin.name })
    skinJsonMessageTone.value = 'success'
  } catch (error) {
    skinJsonMessage.value = error instanceof Error ? error.message : t('theme.importFailed')
    skinJsonMessageTone.value = 'danger'
  }
}

function removeActiveImportedSkin(): void {
  const name = activeSkin.value.name
  try {
    removeImportedSkin(activeSkin.value.id)
    skinJsonDraft.value = ''
    skinJsonMessage.value = t('theme.package.removed', { name })
    skinJsonMessageTone.value = 'success'
  } catch (error) {
    skinJsonMessage.value = error instanceof Error ? error.message : t('theme.importFailed')
    skinJsonMessageTone.value = 'danger'
  }
}

watch(activeSkin, () => {
  skinJsonMessage.value = ''
})

watch(() => props.workspaceTheme, (theme) => {
  if (theme) {
    setWorkspaceThemePreferences(theme)
    return
  }
  clearWorkspaceThemePreferences()
}, { immediate: true, deep: true })
</script>

<style scoped>
@reference "../../style.css";

.workspace-theme-panel {
  @apply rounded-lg border theme-border theme-bg-panel p-3;
  background: var(--color-surface);
  border-color: var(--color-border);
  box-shadow: var(--shadow-panel);
  color: var(--color-text);
}

.workspace-theme-panel-header {
  @apply flex items-start justify-between gap-3;
}

.workspace-theme-panel-title {
  @apply m-0 text-xs font-semibold uppercase tracking-normal theme-muted;
  color: var(--color-text-muted);
}

.workspace-theme-panel-subtitle {
  @apply m-0 mt-1 text-xs theme-muted;
  color: var(--color-text);
}

.workspace-theme-panel-detail {
  @apply m-0 mt-1 text-xs theme-muted;
  color: var(--color-text-muted);
}

.workspace-theme-panel-workspace-binding {
  @apply m-0 mt-3 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700;
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
  color: var(--color-accent);
}

.workspace-theme-panel-persistence-error {
  @apply m-0 mt-3 rounded-md border theme-border-danger theme-bg-danger-soft px-2 py-1 text-xs font-medium theme-text-danger;
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
  color: color-mix(in srgb, var(--color-danger) 42%, var(--color-text));
}

.workspace-theme-panel-reset,
.workspace-theme-panel-json-actions button {
  @apply inline-flex h-7 shrink-0 items-center rounded-md border theme-border theme-bg-panel px-2 text-xs font-medium theme-muted transition hover:theme-bg-subtle;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.workspace-theme-panel-grid {
  @apply mt-3 grid gap-2;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
}

.workspace-theme-panel-grid label {
  @apply grid gap-1;
}

.workspace-theme-panel-grid span {
  @apply text-[0.68rem] font-semibold uppercase leading-4 theme-muted;
  color: var(--color-text-muted);
}

.workspace-theme-panel-grid select,
.workspace-theme-panel-grid input {
  @apply h-8 min-w-0 rounded-md border theme-border theme-bg-panel px-2 text-xs theme-text outline-none transition focus:theme-border-info;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.workspace-theme-panel-grid input[type='color'] {
  @apply p-1;
  background: var(--color-elevated);
}

.workspace-theme-panel-package {
  @apply mt-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2;
  border-color: var(--color-border);
  background: color-mix(in srgb, var(--color-elevated) 64%, transparent);
}

.workspace-theme-panel-package > div:first-child {
  @apply grid min-w-0 gap-0.5;
}

.workspace-theme-panel-package strong {
  @apply text-xs font-semibold;
  color: var(--color-text);
}

.workspace-theme-panel-package span {
  @apply text-[0.68rem] leading-4;
  color: var(--color-text-muted);
}

.workspace-theme-panel-package-actions {
  @apply flex shrink-0 gap-2;
}

.workspace-theme-panel-package-actions button {
  @apply inline-flex min-h-8 items-center rounded-md border px-2.5 text-xs font-medium transition;
  border-color: var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.workspace-theme-panel-package-actions button:hover {
  border-color: color-mix(in srgb, var(--color-accent) 44%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-elevated));
}

.workspace-theme-panel-package-actions button[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--color-danger) 40%, var(--color-border));
  color: var(--color-danger);
}

.workspace-theme-panel-package-input {
  display: none;
}

.workspace-theme-panel-advanced {
  @apply mt-3 border-t theme-border pt-2;
  border-color: var(--color-border);
}

.workspace-theme-panel-advanced summary {
  @apply cursor-pointer text-xs font-medium theme-muted;
  color: var(--color-text);
}

.workspace-theme-panel-json-actions {
  @apply mt-2 flex gap-2;
}

.workspace-theme-panel-advanced textarea {
  @apply mt-2 h-36 w-full resize-y rounded-md border theme-border bg-zinc-950 p-2 font-mono text-[0.68rem] leading-4 text-zinc-100 outline-none;
  background: var(--color-code-background);
  border-color: var(--color-border);
}

.workspace-theme-panel-message {
  @apply m-0 mt-2 rounded-md border px-2 py-1 text-xs;
}

.workspace-theme-panel-message[data-tone='success'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.workspace-theme-panel-message[data-tone='danger'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

@media (max-width: 920px) {
  .workspace-theme-panel-grid {
    @apply grid-cols-2;
  }
}

@media (max-width: 560px) {
  .workspace-theme-panel-grid {
    @apply grid-cols-1;
  }

  .workspace-theme-panel-package {
    @apply items-stretch flex-col;
  }

  .workspace-theme-panel-package-actions button {
    @apply min-h-11 flex-1 justify-center;
  }
}
</style>
