<template>
  <main class="app-settings-page" :aria-label="t('settings.aria')">
    <header class="app-settings-page-header">
      <div>
        <p class="app-settings-eyebrow">{{ t('settings.page.eyebrow') }}</p>
        <h1>{{ t('settings.page.title') }}</h1>
        <p>{{ t('settings.page.subtitle') }}</p>
      </div>
      <div class="app-settings-page-meta">
        <span class="app-settings-count">{{ t('settings.page.sectionCount', { count: String(settingsNavItems.length) }) }}</span>
        <span class="app-settings-global-state" :data-tone="saveTone">
          <span aria-hidden="true" />
          {{ unifiedSaveState }}
        </span>
      </div>
    </header>

    <div class="app-settings-workspace">
      <aside class="app-settings-nav" :aria-label="t('settings.nav.aria')">
        <label class="app-settings-search">
          <span>{{ t('settings.search.label') }}</span>
          <span class="app-settings-search-control">
            <IconTablerSearch aria-hidden="true" />
            <input v-model="settingsQuery" type="search" :placeholder="t('settings.search.placeholder')" />
            <button v-if="settingsQuery" type="button" :aria-label="t('settings.search.clear')" @click="settingsQuery = ''">
              <IconTablerX aria-hidden="true" />
            </button>
          </span>
        </label>

        <label class="app-settings-mobile-select">
          <span>{{ t('settings.nav.mobileLabel') }}</span>
          <select :value="activeSection" @change="onMobileSectionSelect">
            <option v-for="item in visibleNavItems" :key="item.key" :value="item.key">{{ item.label }}</option>
          </select>
        </label>

        <nav class="app-settings-nav-groups">
          <section v-for="group in visibleNavGroups" :key="group.key" class="app-settings-nav-group">
            <h2>{{ group.label }}</h2>
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              :data-section="item.key"
              :class="{ 'is-active': activeSection === item.key }"
              :aria-current="activeSection === item.key ? 'page' : undefined"
              :aria-controls="`settings-${item.key}`"
              @click="selectSettingsSection(item.key)"
            >
              <span class="app-settings-nav-icon"><component :is="item.icon" aria-hidden="true" /></span>
              <span class="app-settings-nav-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.hint }}</small>
              </span>
              <IconTablerChevronRight class="app-settings-nav-chevron" aria-hidden="true" />
            </button>
          </section>
        </nav>

        <p v-if="visibleNavItems.length === 0" class="app-settings-nav-empty">
          {{ t('settings.search.noResults', { query: settingsQuery }) }}
        </p>
        <footer class="app-settings-nav-footer">
          <span>{{ t('settings.page.version') }}</span>
          <strong>{{ BUILD_INFO.version }}</strong>
        </footer>
      </aside>

      <div v-if="activeNavItem && visibleNavItems.length > 0" id="settings-content" class="app-settings-content" tabindex="-1">
        <header class="app-settings-content-header">
          <span class="app-settings-content-icon"><component :is="activeNavItem.icon" aria-hidden="true" /></span>
          <div>
            <p>{{ activeGroupLabel }}</p>
            <h2>{{ activeNavItem.title }}</h2>
            <span>{{ activeNavItem.subtitle }}</span>
          </div>
        </header>

        <section v-if="activeSection === 'about'" id="settings-about" class="app-settings-section">
          <dl class="app-version-details">
            <div>
              <dt>{{ t('settings.about.version') }}</dt>
              <dd>{{ BUILD_INFO.version }}</dd>
            </div>
            <div>
              <dt>{{ t('settings.about.buildId') }}</dt>
              <dd>{{ BUILD_INFO.buildId }}</dd>
            </div>
            <div>
              <dt>{{ t('settings.about.gitSha') }}</dt>
              <dd>{{ BUILD_INFO.gitSha }}</dd>
            </div>
            <div>
              <dt>{{ t('settings.about.builtAt') }}</dt>
              <dd>{{ buildTimeLabel }}</dd>
            </div>
          </dl>
        </section>

        <section v-else-if="activeSection === 'language'" id="settings-language" class="app-settings-section app-settings-form-section">
          <div class="app-settings-control-row">
            <div>
              <strong>{{ t('settings.language.current') }}</strong>
              <span>{{ t('settings.language.subtitle') }}</span>
            </div>
            <label class="app-settings-language-select">
              <span class="sr-only">{{ t('settings.language.current') }}</span>
              <select :value="locale" @change="onLocaleSelect">
                <option v-for="option in localeOptions" :key="option.value" :value="option.value">
                  {{ option.value === 'zh-CN' ? t('settings.language.chinese') : t('settings.language.english') }}
                </option>
              </select>
            </label>
          </div>
        </section>

        <section v-else-if="activeSection === 'catalog'" id="settings-catalog" class="app-settings-section">
          <div class="app-settings-section-toolbar">
            <div>
              <strong>{{ catalogStatusLabel }}</strong>
              <span>{{ t('settings.catalog.subtitle') }}</span>
            </div>
            <button class="catalog-sync-button" type="button" :disabled="isCatalogSyncing" @click="runCatalogSync">
              <IconTablerRefresh :class="{ 'is-spinning': isCatalogSyncing }" aria-hidden="true" />
              {{ t('settings.catalog.syncNow') }}
            </button>
          </div>
          <dl class="catalog-sync-status" :data-tone="catalogStatusTone">
            <div>
              <dt>{{ catalogStatusLabel }}</dt>
              <dd>{{ catalogStatus?.lastError || catalogStatusError || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('settings.catalog.lastSuccess') }}</dt>
              <dd>{{ formatCatalogTime(catalogStatus?.lastSuccessAtIso) }}</dd>
            </div>
            <div>
              <dt>{{ t('settings.catalog.nextRun') }}</dt>
              <dd>{{ formatCatalogTime(catalogStatus?.nextRunAtIso) }}</dd>
            </div>
          </dl>
        </section>

        <section v-else-if="activeSection === 'feishu'" id="settings-feishu" class="app-settings-section app-settings-section-embedded">
          <FeishuBotPanel />
        </section>

        <section v-else-if="activeSection === 'tasks'" id="settings-tasks" class="app-settings-section app-settings-section-embedded app-settings-stack">
          <AgentTasksPanel :projects="projects" @select-thread="$emit('selectThread', $event)" />
          <BackgroundTasksPanel />
        </section>

        <section v-else-if="activeSection === 'appearance'" id="settings-appearance" class="app-settings-section app-settings-section-embedded">
          <WorkspaceThemePanel />
        </section>

        <section v-else id="settings-usage" class="app-settings-section">
          <div class="app-settings-control-row app-settings-control-row-top">
            <div>
              <strong>{{ t('settings.tokenFlame.firepowerTitle') }}</strong>
              <span>{{ t('settings.tokenFlame.firepowerBody') }}</span>
            </div>
            <label class="app-settings-switch">
              <input v-model="flameSettings.enabled" type="checkbox" />
              <span>{{ flameSettings.enabled ? t('settings.tokenFlame.enabled') : t('settings.tokenFlame.disabled') }}</span>
            </label>
          </div>

          <div class="flame-settings-card">
            <div class="flame-preview" :data-level="previewLevel">
              <span class="flame-preview-ember" />
              <span class="flame-preview-core" />
              <span class="flame-preview-tip" />
            </div>

            <div class="flame-settings-copy">
              <h3>{{ t('settings.tokenFlame.firepowerTitle') }}</h3>
              <p>{{ t('settings.tokenFlame.firepowerBody') }}</p>
              <div class="flame-settings-controls">
                <label>
                  <span>{{ t('settings.tokenFlame.defaultPosition') }}</span>
                  <select v-model="flameSettings.defaultCorner">
                    <option value="bottom-right">{{ t('settings.tokenFlame.bottomRight') }}</option>
                    <option value="bottom-left">{{ t('settings.tokenFlame.bottomLeft') }}</option>
                    <option value="top-right">{{ t('settings.tokenFlame.topRight') }}</option>
                    <option value="top-left">{{ t('settings.tokenFlame.topLeft') }}</option>
                  </select>
                </label>
                <label class="flame-settings-checkbox">
                  <input v-model="flameSettings.reducedMotion" type="checkbox" />
                  <span>{{ t('settings.tokenFlame.calmAnimation') }}</span>
                </label>
                <button class="flame-settings-reset-position" type="button" @click="resetFlamePosition">
                  {{ t('settings.tokenFlame.resetPosition') }}
                </button>
              </div>
              <p v-if="saveMessage" class="flame-settings-message" :data-tone="saveTone">{{ saveMessage }}</p>
            </div>
          </div>

          <ol class="flame-level-list" :aria-label="t('settings.tokenFlame.levelsAria')">
            <li v-for="level in flameLevels" :key="level.name">
              <span class="flame-level-dot" :data-level="level.level" />
              <span class="flame-level-name">{{ level.name }}</span>
              <span class="flame-level-range">{{ level.range }}</span>
            </li>
          </ol>
        </section>
      </div>

      <section v-else class="app-settings-no-results">
        <IconTablerSearch aria-hidden="true" />
        <h2>{{ t('settings.search.emptyTitle') }}</h2>
        <p>{{ t('settings.search.noResults', { query: settingsQuery }) }}</p>
        <button type="button" @click="settingsQuery = ''">{{ t('settings.search.clear') }}</button>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchUserSetting, writeUserSetting } from '../../api/codexSettingsClient'
import { fetchCatalogStatus, syncCatalogNow, type CatalogSyncStatus } from '../../api/codexCatalogClient'
import { DESKTOP_SETTING_KEYS } from '../../composables/desktopSettingsKeys'
import { useLocale, type AppLocale } from '../../composables/useLocale'
import { BUILD_INFO } from '../../buildInfo'
import IconTablerBell from '../icons/IconTablerBell.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerClipboardList from '../icons/IconTablerClipboardList.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerSettings from '../icons/IconTablerSettings.vue'
import IconTablerSun from '../icons/IconTablerSun.vue'
import IconTablerX from '../icons/IconTablerX.vue'
const WorkspaceThemePanel = defineAsyncComponent(() => import('./WorkspaceThemePanel.vue'))
const BackgroundTasksPanel = defineAsyncComponent(() => import('./BackgroundTasksPanel.vue'))
const AgentTasksPanel = defineAsyncComponent(() => import('./AgentTasksPanel.vue'))
const FeishuBotPanel = defineAsyncComponent(() => import('./FeishuBotPanel.vue'))

withDefaults(defineProps<{ projects?: Array<{ cwd: string; label: string }> }>(), { projects: () => [] })
defineEmits<{ selectThread: [threadId: string] }>()

type FlameCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
type SettingsSection = 'appearance' | 'language' | 'catalog' | 'tasks' | 'feishu' | 'usage' | 'about'
type SettingsGroup = 'general' | 'workspace' | 'integrations' | 'system'

const SETTINGS_SECTIONS: SettingsSection[] = ['appearance', 'language', 'catalog', 'tasks', 'feishu', 'usage', 'about']

function sectionFromHash(): SettingsSection | null {
  if (typeof window === 'undefined') return null
  const key = window.location.hash.replace(/^#settings-/u, '')
  return SETTINGS_SECTIONS.includes(key as SettingsSection) ? key as SettingsSection : null
}

type FlameSettings = {
  enabled: boolean
  defaultCorner: FlameCorner
  reducedMotion: boolean
  position: {
    x: number
    y: number
  } | null
}

const DEFAULT_FLAME_SETTINGS: FlameSettings = {
  enabled: true,
  defaultCorner: 'bottom-right',
  reducedMotion: false,
  position: null,
}

const { locale, localeOptions, setLocale, t } = useLocale()

const flameSettings = ref<FlameSettings>({ ...DEFAULT_FLAME_SETTINGS })
const catalogStatus = ref<CatalogSyncStatus | null>(null)
const catalogStatusError = ref('')
const isCatalogSyncing = ref(false)
const saveMessage = ref('')
const saveTone = ref<'success' | 'danger'>('success')
const hasHydrated = ref(false)
const settingsQuery = ref('')
const activeSection = ref<SettingsSection>(sectionFromHash() ?? 'appearance')
const settingsNavItems = computed(() => [
  { key: 'appearance' as const, group: 'general' as const, label: t('settings.nav.appearance'), hint: t('settings.nav.appearanceHint'), title: t('settings.appearance.title'), subtitle: t('settings.appearance.subtitle'), terms: 'appearance theme skin layout density accent 外观 主题', icon: IconTablerSun },
  { key: 'language' as const, group: 'general' as const, label: t('settings.nav.language'), hint: t('settings.nav.languageHint'), title: t('settings.language.title'), subtitle: t('settings.language.subtitle'), terms: 'language locale chinese english 语言 中文 英文', icon: IconTablerSettings },
  { key: 'catalog' as const, group: 'workspace' as const, label: t('settings.nav.catalog'), hint: t('settings.nav.catalogHint'), title: t('settings.catalog.title'), subtitle: t('settings.catalog.subtitle'), terms: 'catalog sync projects conversations 目录 同步 项目 会话', icon: IconTablerFolder },
  { key: 'tasks' as const, group: 'workspace' as const, label: t('settings.nav.tasks'), hint: t('settings.nav.tasksHint'), title: t('settings.tasks.title'), subtitle: t('settings.tasks.subtitle'), terms: 'background tasks sync token diagnostics jobs 后台 任务 校准', icon: IconTablerRefresh },
  { key: 'feishu' as const, group: 'integrations' as const, label: t('settings.nav.feishu'), hint: t('settings.nav.feishuHint'), title: t('settings.feishu.title'), subtitle: t('settings.feishu.subtitle'), terms: 'feishu lark bot app id secret bindings sessions 飞书 机器人 凭据 会话 绑定', icon: IconTablerBell },
  { key: 'usage' as const, group: 'system' as const, label: t('settings.nav.usage'), hint: t('settings.nav.usageHint'), title: t('settings.tokenFlame.title'), subtitle: t('settings.tokenFlame.subtitle'), terms: 'usage token flame position motion 用量 火焰', icon: IconTablerPhoto },
  { key: 'about' as const, group: 'system' as const, label: t('settings.nav.about'), hint: t('settings.nav.aboutHint'), title: t('settings.about.title'), subtitle: t('settings.about.subtitle'), terms: 'about version build git sha commit 关于 版本 构建 提交', icon: IconTablerClipboardList },
])
const visibleNavItems = computed(() => settingsNavItems.value.filter((item) => matchesSettings(item.key)))
const navGroupOrder: SettingsGroup[] = ['general', 'workspace', 'integrations', 'system']
const visibleNavGroups = computed(() => navGroupOrder.map((key) => ({
  key,
  label: t(`settings.nav.group.${key}`),
  items: visibleNavItems.value.filter((item) => item.group === key),
})).filter((group) => group.items.length > 0))
const activeNavItem = computed(() => settingsNavItems.value.find((item) => item.key === activeSection.value) ?? null)
const activeGroupLabel = computed(() => activeNavItem.value ? t(`settings.nav.group.${activeNavItem.value.group}`) : '')
const unifiedSaveState = computed(() => {
  if (!hasHydrated.value) return t('settings.save.loading')
  if (saveTone.value === 'danger') return t('settings.save.failed')
  if (saveMessage.value) return t('settings.save.saved')
  return t('settings.save.auto')
})
const previewLevel = computed(() => flameSettings.value.enabled ? 'bonfire' : 'spark')
const flameLevels = computed(() => [
  { level: 'spark', name: t('settings.tokenFlame.level.spark'), range: t('settings.tokenFlame.range.less20k') },
  { level: 'campfire', name: t('settings.tokenFlame.level.campfire'), range: t('settings.tokenFlame.range.20k80k') },
  { level: 'steady', name: t('settings.tokenFlame.level.steady'), range: t('settings.tokenFlame.range.80k200k') },
  { level: 'bonfire', name: t('settings.tokenFlame.level.bonfire'), range: t('settings.tokenFlame.range.200k500k') },
  { level: 'blaze', name: t('settings.tokenFlame.level.blaze'), range: t('settings.tokenFlame.range.500k1m') },
  { level: 'inferno', name: t('settings.tokenFlame.level.inferno'), range: t('settings.tokenFlame.range.1mPlus') },
] as const)
const catalogStatusTone = computed(() => {
  if (catalogStatusError.value || catalogStatus.value?.lastError) return 'danger'
  if (isCatalogSyncing.value || catalogStatus.value?.running) return 'working'
  return 'success'
})
const catalogStatusLabel = computed(() => {
  if (catalogStatusTone.value === 'danger') return t('settings.catalog.status.error')
  if (catalogStatusTone.value === 'working') return t('settings.catalog.status.running')
  return t('settings.catalog.status.ready')
})
const buildTimeLabel = computed(() => formatCatalogTime(BUILD_INFO.builtAt))

function matchesSettings(key: SettingsSection): boolean {
  const query = settingsQuery.value.trim().toLowerCase()
  if (!query) return true
  const item = settingsNavItems.value.find((candidate) => candidate.key === key)
  return Boolean(item && `${item.label} ${item.terms}`.toLowerCase().includes(query))
}

function selectSettingsSection(key: SettingsSection, updateHash = true): void {
  activeSection.value = key
  if (updateHash && typeof window !== 'undefined') {
    window.history.replaceState(window.history.state, '', `#settings-${key}`)
  }
  void nextTick(() => document.querySelector<HTMLElement>('#settings-content')?.focus({ preventScroll: true }))
}

function onMobileSectionSelect(event: Event): void {
  selectSettingsSection((event.target as HTMLSelectElement).value as SettingsSection)
}

function onSettingsHashChange(): void {
  const section = sectionFromHash()
  if (section) selectSettingsSection(section, false)
}

function formatCatalogTime(value: string | null | undefined): string {
  if (!value) return t('settings.catalog.never')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp))
}

async function loadCatalogStatus(): Promise<void> {
  try {
    catalogStatus.value = await fetchCatalogStatus()
    catalogStatusError.value = ''
  } catch (error) {
    catalogStatusError.value = error instanceof Error ? error.message : t('settings.catalog.failed')
  }
}

async function runCatalogSync(): Promise<void> {
  if (isCatalogSyncing.value) return
  isCatalogSyncing.value = true
  catalogStatusError.value = ''
  try {
    catalogStatus.value = await syncCatalogNow()
  } catch (error) {
    catalogStatusError.value = error instanceof Error ? error.message : t('settings.catalog.failed')
  } finally {
    isCatalogSyncing.value = false
  }
}

function onLocaleSelect(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value as AppLocale)
}

function normalizeFlameSettings(value: unknown): FlameSettings {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const defaultCorner = (
    row.defaultCorner === 'bottom-left' ||
    row.defaultCorner === 'top-right' ||
    row.defaultCorner === 'top-left' ||
    row.defaultCorner === 'bottom-right'
  )
    ? row.defaultCorner
    : DEFAULT_FLAME_SETTINGS.defaultCorner

  return {
    enabled: row.enabled !== false,
    defaultCorner,
    reducedMotion: row.reducedMotion === true,
    position: normalizePosition(row.position),
  }
}

function normalizePosition(value: unknown): FlameSettings['position'] {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!row || typeof row.x !== 'number' || typeof row.y !== 'number') return null
  if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) return null
  return {
    x: row.x,
    y: row.y,
  }
}

function resetFlamePosition(): void {
  flameSettings.value = {
    ...flameSettings.value,
    position: null,
  }
}

async function loadFlameSettings(): Promise<void> {
  try {
    const setting = await fetchUserSetting<unknown>(DESKTOP_SETTING_KEYS.tokenFlameWidget)
    flameSettings.value = normalizeFlameSettings(setting?.value ?? DEFAULT_FLAME_SETTINGS)
  } catch {
    flameSettings.value = { ...DEFAULT_FLAME_SETTINGS }
  } finally {
    hasHydrated.value = true
  }
}

watch(flameSettings, (nextSettings) => {
  if (!hasHydrated.value) return
  void writeUserSetting(DESKTOP_SETTING_KEYS.tokenFlameWidget, nextSettings)
    .then(() => {
      saveTone.value = 'success'
      saveMessage.value = t('settings.tokenFlame.saved')
    })
    .catch(() => {
      saveTone.value = 'danger'
      saveMessage.value = t('settings.tokenFlame.saveFailed')
    })
}, { deep: true })

watch(visibleNavItems, (items) => {
  if (items.length > 0 && !items.some((item) => item.key === activeSection.value)) {
    selectSettingsSection(items[0].key, false)
  }
})

onMounted(() => {
  void loadFlameSettings()
  void loadCatalogStatus()
  window.addEventListener('hashchange', onSettingsHashChange)
})

onBeforeUnmount(() => window.removeEventListener('hashchange', onSettingsHashChange))
</script>

<style scoped>
@reference "../../style.css";

.app-settings-page {
  @apply h-full min-h-0 w-full overflow-y-auto px-6 pb-10 pt-5;
  background: var(--color-background);
  color: var(--color-text);
}

.app-settings-page-header {
  @apply mx-auto mb-5 flex w-full max-w-[92rem] items-end justify-between gap-6;
  padding-inline: 0.2rem;
}

.app-settings-page-header h1 {
  @apply m-0 text-2xl font-semibold tracking-tight;
  color: var(--color-text);
}

.app-settings-page-header > div > p:last-child {
  @apply m-0 mt-1 max-w-3xl text-sm leading-6;
  color: var(--color-text-muted);
}

.app-settings-eyebrow {
  @apply m-0 mb-1;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.app-settings-page-meta {
  @apply flex shrink-0 flex-col items-end gap-2;
}

.app-settings-count {
  @apply text-xs;
  color: var(--color-text-muted);
}

.app-settings-global-state {
  @apply inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium;
  border-color: color-mix(in srgb, var(--color-success) 34%, var(--color-border));
  background: color-mix(in srgb, var(--color-success) 9%, var(--color-panel));
  color: color-mix(in srgb, var(--color-success) 55%, var(--color-text));
}

.app-settings-global-state > span {
  @apply h-2 w-2 rounded-full;
  background: var(--color-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 14%, transparent);
}

.app-settings-global-state[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--color-danger) 36%, var(--color-border));
  background: color-mix(in srgb, var(--color-danger) 9%, var(--color-panel));
  color: var(--color-danger);
}

.app-settings-global-state[data-tone='danger'] > span {
  background: var(--color-danger);
}

.app-settings-workspace {
  @apply mx-auto grid w-full max-w-[92rem] items-start gap-5;
  grid-template-columns: 17rem minmax(0, 1fr);
}

.app-settings-nav {
  @apply sticky top-4 grid gap-4 rounded-xl border p-3;
  border-color: var(--color-border);
  background: color-mix(in srgb, var(--color-panel) 94%, transparent);
  box-shadow: var(--shadow-panel);
}

.app-settings-search {
  @apply grid gap-1.5 px-1;
}

.app-settings-search > span:first-child,
.app-settings-mobile-select > span {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app-settings-search-control {
  @apply flex min-h-10 items-center gap-2 rounded-lg border px-2.5 transition;
  border: 1px solid var(--color-border);
  background: var(--color-elevated);
}

.app-settings-search-control:focus-within {
  border-color: color-mix(in srgb, var(--color-accent) 65%, var(--color-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.app-settings-search-control > svg {
  @apply h-4 w-4 shrink-0;
  color: var(--color-text-muted);
}

.app-settings-search input {
  @apply min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none;
  color: var(--color-text);
}

.app-settings-search input::-webkit-search-cancel-button {
  appearance: none;
}

.app-settings-search-control button {
  @apply inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition;
  color: var(--color-text-muted);
}

.app-settings-search-control button:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.app-settings-search-control button svg {
  @apply h-3.5 w-3.5;
}

.app-settings-mobile-select {
  display: none;
}

.app-settings-nav-groups {
  @apply grid gap-4;
}

.app-settings-nav-group {
  @apply grid gap-1;
}

.app-settings-nav-group h2 {
  @apply m-0 px-2 pb-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em];
  color: var(--color-text-muted);
}

.app-settings-nav-group button {
  @apply grid min-h-14 w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)_1rem] items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 py-2 text-left transition duration-200;
  color: var(--color-text-muted);
}

.app-settings-nav-group button:hover {
  background: var(--color-elevated);
  color: var(--color-text);
}

.app-settings-nav-group button.is-active {
  border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  background: linear-gradient(100deg, color-mix(in srgb, var(--color-accent) 13%, var(--color-elevated)), var(--color-elevated));
  color: var(--color-text);
  box-shadow: inset 3px 0 0 var(--color-accent);
}

.app-settings-nav-group button:focus-visible,
.app-settings-no-results button:focus-visible,
.catalog-sync-button:focus-visible,
.flame-settings-reset-position:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.app-settings-nav-icon,
.app-settings-content-icon {
  @apply inline-flex items-center justify-center rounded-md border;
  border-color: var(--color-border);
  background: var(--color-surface);
}

.app-settings-nav-icon {
  @apply h-8 w-8;
}

.app-settings-nav-icon svg {
  @apply h-4 w-4;
}

.app-settings-nav-group button.is-active .app-settings-nav-icon {
  border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  color: var(--color-accent);
}

.app-settings-nav-copy {
  @apply grid min-w-0 gap-0.5;
}

.app-settings-nav-copy strong {
  @apply truncate text-sm font-semibold;
}

.app-settings-nav-copy small {
  @apply truncate text-[0.68rem] font-normal;
  color: var(--color-text-muted);
}

.app-settings-nav-chevron {
  @apply h-4 w-4 opacity-0 transition;
}

.app-settings-nav-group button:hover .app-settings-nav-chevron,
.app-settings-nav-group button.is-active .app-settings-nav-chevron {
  opacity: 1;
}

.app-settings-nav-empty {
  @apply m-0 rounded-lg border border-dashed p-3 text-xs leading-5;
  border-color: var(--color-border);
  color: var(--color-text-muted);
}

.app-settings-nav-footer {
  @apply flex items-center justify-between gap-3 border-t px-2 pt-3 text-[0.68rem];
  border-color: var(--color-border);
  color: var(--color-text-muted);
}

.app-settings-nav-footer strong {
  font-family: var(--font-mono);
  color: var(--color-text);
}

.app-settings-content {
  @apply flex min-w-0 flex-col gap-4 outline-none;
}

.app-settings-content-header {
  @apply flex min-h-[7.25rem] items-center gap-4 overflow-hidden rounded-xl border px-5 py-4;
  border-color: var(--color-border);
  background:
    radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 40%),
    var(--color-panel);
  box-shadow: var(--shadow-panel);
}

.app-settings-content-icon {
  @apply h-12 w-12 shrink-0;
  border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
  color: var(--color-accent);
}

.app-settings-content-icon svg {
  @apply h-6 w-6;
}

.app-settings-content-header p {
  @apply m-0 text-[0.68rem] font-semibold uppercase tracking-[0.12em];
  color: var(--color-accent);
}

.app-settings-content-header h2 {
  @apply m-0 mt-1 text-xl font-semibold tracking-tight;
  color: var(--color-text);
}

.app-settings-content-header div > span {
  @apply mt-1 block max-w-3xl text-sm leading-5;
  color: var(--color-text-muted);
}

.app-settings-no-results {
  @apply flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center;
  border-color: var(--color-border);
  background: var(--color-panel);
  color: var(--color-text-muted);
}

.app-settings-no-results > svg {
  @apply h-8 w-8;
}

.app-settings-no-results h2 {
  @apply m-0 mt-3 text-base font-semibold;
  color: var(--color-text);
}

.app-settings-no-results p {
  @apply m-0 mt-1 text-sm;
}

.app-settings-no-results button {
  @apply mt-4 min-h-10 cursor-pointer rounded-lg border px-4 text-sm font-medium transition;
  border-color: var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.app-settings-section {
  @apply min-w-0 rounded-xl border p-5;
  background: var(--color-panel);
  border-color: var(--color-border);
  box-shadow: var(--shadow-panel);
}

.app-settings-section-embedded {
  @apply border-0 bg-transparent p-0 shadow-none;
}

.app-settings-stack {
  @apply grid gap-4;
}

.app-settings-section-toolbar,
.app-settings-control-row {
  @apply flex items-center justify-between gap-5;
}

.app-settings-section-toolbar {
  @apply mb-4;
}

.app-settings-control-row-top {
  @apply mb-4 border-b pb-4;
  border-color: var(--color-border);
}

.app-settings-section-toolbar > div,
.app-settings-control-row > div {
  @apply grid min-w-0 gap-1;
}

.app-settings-section-toolbar strong,
.app-settings-control-row strong {
  @apply text-sm font-semibold;
  color: var(--color-text);
}

.app-settings-section-toolbar span,
.app-settings-control-row > div > span {
  @apply text-xs leading-5;
  color: var(--color-text-muted);
}

.catalog-sync-button {
  @apply inline-flex min-h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-wait disabled:opacity-60;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.catalog-sync-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  background: var(--color-elevated);
}

.catalog-sync-button svg {
  @apply h-4 w-4;
}

.catalog-sync-button svg.is-spinning {
  animation: settings-spin 0.9s linear infinite;
}

.catalog-sync-status {
  @apply m-0 grid grid-cols-3 gap-3;
}

.app-version-details {
  @apply m-0 grid gap-3 md:grid-cols-2 xl:grid-cols-4;
}

.app-version-details div,
.catalog-sync-status div {
  @apply min-w-0 rounded-lg border p-3;
  border-color: var(--color-border);
  background: var(--color-surface);
}

.app-version-details dt {
  @apply text-xs font-semibold theme-muted;
  color: var(--color-text-muted);
}

.app-version-details dd {
  @apply m-0 mt-1 truncate font-mono text-sm theme-text;
  color: var(--color-text);
}

.catalog-sync-status dt {
  @apply text-xs font-semibold theme-muted;
  color: var(--color-text-muted);
}

.catalog-sync-status dd {
  @apply m-0 mt-1 truncate text-sm theme-text;
  color: var(--color-text);
}

.catalog-sync-status[data-tone='danger'] div:first-child dd,
.catalog-sync-status[data-tone='danger'] div:first-child dt {
  color: var(--color-danger);
}

.app-settings-switch {
  @apply inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.app-settings-switch input {
  @apply h-4 w-4;
  accent-color: var(--color-accent);
}

.app-settings-language-select {
  @apply grid shrink-0 gap-1;
}

.app-settings-language-select span {
  @apply text-xs font-semibold uppercase tracking-normal theme-muted;
  color: var(--color-text-muted);
}

.app-settings-language-select select {
  @apply min-h-10 min-w-48 cursor-pointer rounded-lg border px-3 text-sm outline-none transition;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.app-settings-language-select select:focus-visible,
.flame-settings-controls select:focus-visible {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.flame-settings-card {
  @apply grid grid-cols-[7rem_minmax(0,1fr)] gap-4 rounded-lg border theme-border theme-bg-panel p-4;
  background: var(--color-surface);
  border-color: var(--color-border);
}

.flame-preview {
  @apply relative flex h-28 w-24 items-end justify-center justify-self-center overflow-hidden rounded-lg bg-zinc-950;
}

.flame-preview-ember,
.flame-preview-core,
.flame-preview-tip {
  @apply absolute bottom-4 block rounded-full;
  transform-origin: 50% 100%;
}

.flame-preview-ember {
  @apply h-14 w-16 bg-orange-600;
  filter: blur(1px);
}

.flame-preview-core {
  @apply h-20 w-12 bg-amber-300;
  clip-path: ellipse(45% 50% at 50% 60%);
}

.flame-preview-tip {
  @apply h-24 w-8 theme-bg-danger;
  clip-path: polygon(50% 0, 82% 48%, 68% 100%, 30% 100%, 18% 48%);
}

.flame-preview[data-level='spark'] .flame-preview-ember,
.flame-preview[data-level='spark'] .flame-preview-core,
.flame-preview[data-level='spark'] .flame-preview-tip {
  transform: scale(0.55);
  opacity: 0.72;
}

.flame-settings-copy h3 {
  @apply m-0 text-sm font-semibold theme-text;
  color: var(--color-text);
}

.flame-settings-copy p {
  @apply m-0 mt-1 text-sm leading-5 theme-muted;
  color: var(--color-text-muted);
}

.flame-settings-controls {
  @apply mt-3 flex flex-wrap items-end gap-3;
}

.flame-settings-controls label {
  @apply grid gap-1;
}

.flame-settings-controls label > span {
  @apply text-xs font-semibold uppercase tracking-normal theme-muted;
  color: var(--color-text-muted);
}

.flame-settings-controls select {
  @apply h-9 rounded-md border theme-border theme-bg-panel px-2 text-sm theme-text outline-none transition focus:theme-border-info;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.flame-settings-checkbox {
  @apply flex h-9 grid-flow-col items-center gap-2 rounded-md border theme-border px-2;
  border-color: var(--color-border);
  color: var(--color-text-muted);
}

.flame-settings-checkbox input {
  @apply h-4 w-4;
  accent-color: var(--color-accent);
}

.flame-settings-reset-position {
  @apply min-h-10 cursor-pointer rounded-lg border px-3 text-sm font-medium transition;
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.flame-settings-reset-position:hover {
  background: var(--color-elevated);
}

.flame-settings-message {
  @apply mt-3 rounded-md border px-2 py-1 text-xs;
}

.flame-settings-message[data-tone='success'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
  background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
  border-color: color-mix(in srgb, var(--color-success) 34%, var(--color-border));
  color: color-mix(in srgb, var(--color-success) 48%, var(--color-text));
}

.flame-settings-message[data-tone='danger'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
  border-color: color-mix(in srgb, var(--color-danger) 34%, var(--color-border));
  color: color-mix(in srgb, var(--color-danger) 48%, var(--color-text));
}

.flame-level-list {
  @apply mt-3 grid list-none gap-2 p-0 md:grid-cols-2;
}

.flame-level-list li {
  @apply grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border theme-border theme-bg-panel px-3 py-2 text-sm;
  background: var(--color-surface);
  border-color: var(--color-border);
}

.flame-level-dot {
  @apply h-3 w-3 rounded-full bg-orange-400;
}

.flame-level-dot[data-level='spark'] {
  @apply bg-amber-300;
}

.flame-level-dot[data-level='campfire'],
.flame-level-dot[data-level='steady'] {
  @apply theme-bg-warning;
}

.flame-level-dot[data-level='bonfire'],
.flame-level-dot[data-level='blaze'] {
  @apply theme-bg-danger;
}

.flame-level-dot[data-level='inferno'] {
  @apply bg-fuchsia-500;
}

.flame-level-name {
  @apply min-w-0 font-medium theme-text;
  color: var(--color-text);
}

.flame-level-range {
  @apply shrink-0 text-xs theme-muted;
  color: var(--color-text-muted);
}

@keyframes settings-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1000px) {
  .app-settings-page {
    padding-inline: 0.75rem;
  }

  .app-settings-page-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.75rem;
  }

  .app-settings-page-meta {
    align-items: center;
    flex-direction: row;
  }

  .app-settings-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .app-settings-nav {
    position: relative;
    top: auto;
  }

  .app-settings-nav-groups,
  .app-settings-nav-footer {
    display: none;
  }

  .app-settings-mobile-select {
    @apply grid gap-1.5 px-1;
  }

  .app-settings-mobile-select select {
    @apply min-h-11 w-full cursor-pointer rounded-lg border px-3 text-sm outline-none;
    border-color: var(--color-border);
    background: var(--color-elevated);
    color: var(--color-text);
  }

  .app-settings-content-header {
    min-height: 6.5rem;
  }

  .catalog-sync-status {
    @apply grid-cols-1;
  }
}

@media (max-width: 640px) {
  .app-settings-page {
    padding-bottom: 2rem;
    padding-top: 0.75rem;
  }

  .app-settings-page-header h1 {
    @apply text-xl;
  }

  .app-settings-search input,
  .app-settings-mobile-select select,
  .app-settings-language-select select,
  .flame-settings-controls select {
    font-size: 1rem;
  }

  .app-settings-count {
    display: none;
  }

  .app-settings-content-header {
    @apply items-start px-4;
  }

  .app-settings-content-icon {
    @apply h-10 w-10;
  }

  .app-settings-section {
    @apply p-4;
  }

  .app-settings-section-embedded {
    padding: 0;
  }

  .app-settings-section-toolbar,
  .app-settings-control-row {
    align-items: stretch;
    flex-direction: column;
  }

  .catalog-sync-button,
  .app-settings-switch,
  .app-settings-language-select,
  .app-settings-language-select select {
    width: 100%;
  }

  .flame-settings-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .flame-preview {
    display: none;
  }

  .flame-settings-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .flame-settings-controls select,
  .flame-settings-reset-position {
    width: 100%;
  }

  .flame-level-list {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-settings-page *,
  .app-settings-page *::before,
  .app-settings-page *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
</style>
