<template>
  <section class="skills-page" :aria-label="t('skills.title')">
    <header class="skills-hero">
      <div>
        <p class="skills-eyebrow">{{ t('skills.eyebrow') }}</p>
        <h1>{{ t('skills.title') }}</h1>
        <p>{{ t('skills.subtitle', { project: projectLabel || t('app.notSelected') }) }}</p>
      </div>
      <button class="skills-refresh" type="button" :disabled="isLoading" @click="loadSkills">
        <IconTablerRefresh />
        {{ t('skills.refresh') }}
      </button>
    </header>

    <div class="skills-metrics" aria-live="polite">
      <div><strong>{{ skills.length }}</strong><span>{{ t('skills.metric.available') }}</span></div>
      <div><strong class="accent">{{ enabledCount }}</strong><span>{{ t('skills.metric.enabled') }}</span></div>
      <div><strong>{{ repoCount }}</strong><span>{{ t('skills.metric.project') }}</span></div>
      <div><strong :class="{ warning: errors.length > 0 }">{{ errors.length }}</strong><span>{{ t('skills.metric.issues') }}</span></div>
    </div>

    <div v-if="loadError" class="skills-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" @click="loadSkills">{{ t('skills.retry') }}</button>
    </div>

    <div v-if="errors.length > 0" class="skills-warning" role="status">
      <strong>{{ t('skills.discoveryIssues', { count: String(errors.length) }) }}</strong>
      <span>{{ errors[0]?.message }}</span>
    </div>

    <div class="skills-workbench">
      <aside class="skills-filters">
        <p>{{ t('skills.filter.scope') }}</p>
        <button
          v-for="option in scopeOptions"
          :key="option.id"
          type="button"
          :data-active="activeScope === option.id"
          @click="activeScope = option.id"
        >
          <span>{{ option.label }}</span><small>{{ option.count }}</small>
        </button>
        <div class="skills-filter-rule" />
        <p>{{ t('skills.filter.status') }}</p>
        <button type="button" :data-active="activeScope === 'enabled'" @click="activeScope = 'enabled'">
          <span>{{ t('skills.enabled') }}</span><small>{{ enabledCount }}</small>
        </button>
        <button type="button" :data-active="activeScope === 'disabled'" @click="activeScope = 'disabled'">
          <span>{{ t('skills.disabled') }}</span><small>{{ skills.length - enabledCount }}</small>
        </button>
      </aside>

      <main class="skills-catalog">
        <label class="skills-search">
          <IconTablerSearch />
          <input v-model="query" type="search" :placeholder="t('skills.search')" />
        </label>

        <div v-if="isLoading" class="skills-empty">{{ t('skills.loading') }}</div>
        <div v-else-if="filteredSkills.length === 0" class="skills-empty">
          <strong>{{ t('skills.empty.title') }}</strong>
          <span>{{ t('skills.empty.body') }}</span>
        </div>
        <div v-else class="skills-list">
          <button
            v-for="skill in filteredSkills"
            :key="skill.path"
            class="skill-card"
            type="button"
            :data-active="selectedSkill?.path === skill.path"
            @click="selectedPath = skill.path"
          >
            <span class="skill-monogram" :style="monogramStyle(skill)">{{ monogram(skill) }}</span>
            <span class="skill-card-copy">
              <strong>{{ displayName(skill) }}</strong>
              <small>{{ summary(skill) || t('skills.noDescription') }}</small>
            </span>
            <span class="skill-card-meta">
              <small>{{ scopeLabel(skill.scope) }}</small>
              <b :data-enabled="skill.enabled">{{ skill.enabled ? t('skills.enabled') : t('skills.disabled') }}</b>
            </span>
          </button>
        </div>
      </main>

      <aside class="skill-detail">
        <template v-if="selectedSkill">
          <div class="skill-detail-heading">
            <span class="skill-detail-icon" :style="monogramStyle(selectedSkill)">{{ monogram(selectedSkill) }}</span>
            <div><h2>{{ displayName(selectedSkill) }}</h2><p>{{ scopeLabel(selectedSkill.scope) }}</p></div>
            <button
              class="skill-toggle"
              type="button"
              role="switch"
              :aria-checked="selectedSkill.enabled"
              :disabled="updatingPath === selectedSkill.path"
              @click="toggleSelectedSkill"
            ><span /></button>
          </div>

          <p class="skill-description">{{ selectedSkill.description || summary(selectedSkill) || t('skills.noDescription') }}</p>

          <section class="skill-detail-section">
            <h3>{{ t('skills.detail.trigger') }}</h3>
            <div class="skill-trigger-copy">{{ summary(selectedSkill) || selectedSkill.description || t('skills.noTrigger') }}</div>
          </section>

          <section class="skill-detail-section">
            <h3>{{ t('skills.detail.dependencies') }}</h3>
            <div v-if="dependencies.length > 0" class="skill-dependencies">
              <div v-for="dependency in dependencies" :key="`${dependency.type}:${dependency.value}`">
                <i /><span><strong>{{ dependency.value }}</strong><small>{{ dependency.description || dependency.type }}</small></span>
                <code>{{ dependency.transport || dependency.type }}</code>
              </div>
            </div>
            <p v-else class="skill-detail-empty">{{ t('skills.noDependencies') }}</p>
          </section>

          <section class="skill-detail-section">
            <h3>{{ t('skills.detail.source') }}</h3>
            <code class="skill-path">{{ selectedSkill.path }}</code>
          </section>

          <section v-if="selectedSkill.defaultPrompt" class="skill-detail-section">
            <h3>{{ t('skills.detail.defaultPrompt') }}</h3>
            <div class="skill-trigger-copy">{{ selectedSkill.defaultPrompt }}</div>
          </section>

          <p v-if="updateError" class="skill-update-error" role="alert">{{ updateError }}</p>
        </template>
        <div v-else class="skills-empty">{{ t('skills.selectSkill') }}</div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CodexSkillOption } from '@codycodeagent/cody-web-core/session'
import { getSkillCatalog, setSkillEnabled } from '../../api/codexComposerClient'
import { useLocale } from '../../composables/useLocale'
import IconTablerRefresh from '../icons/IconTablerRefresh.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'

const props = defineProps<{ cwd: string; projectLabel: string }>()
const { t } = useLocale()

type ScopeFilter = 'all' | 'repo' | 'user' | 'system' | 'enabled' | 'disabled'

const skills = ref<CodexSkillOption[]>([])
const errors = ref<Array<{ path: string; message: string }>>([])
const isLoading = ref(false)
const loadError = ref('')
const updateError = ref('')
const updatingPath = ref('')
const query = ref('')
const activeScope = ref<ScopeFilter>('all')
const selectedPath = ref('')

const enabledCount = computed(() => skills.value.filter((skill) => skill.enabled).length)
const repoCount = computed(() => skills.value.filter((skill) => skill.scope === 'repo').length)
const selectedSkill = computed(() => skills.value.find((skill) => skill.path === selectedPath.value) ?? skills.value[0] ?? null)
const dependencies = computed(() => selectedSkill.value?.dependencies ?? [])
const scopeOptions = computed(() => [
  { id: 'all' as const, label: t('skills.scope.all'), count: skills.value.length },
  { id: 'repo' as const, label: t('skills.scope.repo'), count: repoCount.value },
  { id: 'user' as const, label: t('skills.scope.user'), count: skills.value.filter((skill) => skill.scope === 'user').length },
  { id: 'system' as const, label: t('skills.scope.system'), count: skills.value.filter((skill) => ['system', 'admin'].includes(skill.scope)).length },
])
const filteredSkills = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase()
  return skills.value.filter((skill) => {
    if (activeScope.value === 'repo' && skill.scope !== 'repo') return false
    if (activeScope.value === 'user' && skill.scope !== 'user') return false
    if (activeScope.value === 'system' && !['system', 'admin'].includes(skill.scope)) return false
    if (activeScope.value === 'enabled' && !skill.enabled) return false
    if (activeScope.value === 'disabled' && skill.enabled) return false
    if (!normalizedQuery) return true
    return [skill.name, displayName(skill), skill.description, summary(skill), skill.path]
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  })
})

function displayName(skill: CodexSkillOption): string {
  return skill.displayName || skill.name
}

function summary(skill: CodexSkillOption): string {
  return skill.description
}

function monogram(skill: CodexSkillOption): string {
  const words = displayName(skill).split(/[-_: ]+/u).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || 'S'
}

function monogramStyle(skill: CodexSkillOption): Record<string, string> {
  const color = skill.brandColor || 'var(--color-accent)'
  return { color, background: `color-mix(in srgb, ${color} 13%, var(--color-panel))` }
}

function scopeLabel(scope: CodexSkillOption['scope']): string {
  return t(`skills.scope.${scope}` as Parameters<typeof t>[0])
}

async function loadSkills(): Promise<void> {
  const cwd = props.cwd.trim()
  if (!cwd) {
    skills.value = []
    errors.value = []
    return
  }
  isLoading.value = true
  loadError.value = ''
  try {
    const entries = await getSkillCatalog([cwd])
    const entry = entries.find((item) => item.cwd === cwd) ?? entries[0]
    skills.value = [...(entry?.skills ?? [])].sort((a, b) => {
      if (a.scope === 'repo' && b.scope !== 'repo') return -1
      if (a.scope !== 'repo' && b.scope === 'repo') return 1
      return displayName(a).localeCompare(displayName(b))
    })
    errors.value = entry?.errors ?? []
    if (!skills.value.some((skill) => skill.path === selectedPath.value)) selectedPath.value = skills.value[0]?.path ?? ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('skills.loadFailed')
  } finally {
    isLoading.value = false
  }
}

async function toggleSelectedSkill(): Promise<void> {
  const skill = selectedSkill.value
  if (!skill || updatingPath.value) return
  updatingPath.value = skill.path
  updateError.value = ''
  try {
    await setSkillEnabled(skill.path, !skill.enabled)
    skill.enabled = !skill.enabled
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : t('skills.updateFailed')
  } finally {
    updatingPath.value = ''
  }
}

onMounted(loadSkills)
watch(() => props.cwd, loadSkills)
</script>

<style scoped>
@reference "../../style.css";

.skills-page { flex:1; min-height:0; overflow:auto; padding:clamp(1.2rem,2.7vw,2.2rem); color:var(--color-text); }
.skills-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; max-width:90rem; margin:0 auto 1.35rem; }
.skills-eyebrow { margin:0 0 .38rem!important; color:var(--color-accent)!important; font:700 .68rem var(--font-mono); letter-spacing:.14em; text-transform:uppercase; }
.skills-hero h1 { margin:0; font-size:clamp(1.55rem,2.2vw,2.1rem); letter-spacing:-.045em; }
.skills-hero p { margin:.45rem 0 0; color:var(--color-text-muted); }
.skills-refresh { display:flex; align-items:center; gap:.45rem; padding:.58rem .75rem; border:1px solid var(--color-border); border-radius:var(--radius-md); background:var(--color-panel); color:var(--color-text-muted); }
.skills-refresh:hover { color:var(--color-text); border-color:color-mix(in srgb,var(--color-accent) 35%,var(--color-border)); }
.skills-refresh svg { width:1rem; }
.skills-metrics { max-width:90rem; margin:0 auto 1.2rem; display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--color-border); border-radius:var(--radius-lg); overflow:hidden; background:color-mix(in srgb,var(--color-panel) 78%,transparent); }
.skills-metrics div { padding:.85rem 1rem; border-right:1px solid var(--color-border); }
.skills-metrics div:last-child { border:0; }
.skills-metrics strong { display:block; font:600 1.15rem var(--font-mono); }
.skills-metrics span { color:var(--color-text-muted); font-size:.7rem; }
.skills-metrics .accent { color:var(--color-accent); }
.skills-metrics .warning { color:var(--color-warning); }
.skills-error,.skills-warning { max-width:90rem; margin:0 auto 1rem; display:flex; justify-content:space-between; gap:1rem; padding:.7rem .85rem; border:1px solid color-mix(in srgb,var(--color-danger) 30%,var(--color-border)); border-radius:var(--radius-md); background:color-mix(in srgb,var(--color-danger) 7%,var(--color-panel)); }
.skills-warning { justify-content:flex-start; color:var(--color-text-muted); border-color:color-mix(in srgb,var(--color-warning) 30%,var(--color-border)); background:color-mix(in srgb,var(--color-warning) 6%,var(--color-panel)); }
.skills-warning strong { color:var(--color-warning); }
.skills-workbench { max-width:90rem; min-height:34rem; margin:0 auto; display:grid; grid-template-columns:12rem minmax(22rem,1fr) minmax(19rem,27rem); border:1px solid var(--color-border); border-radius:var(--radius-xl); overflow:hidden; background:color-mix(in srgb,var(--color-panel) 75%,transparent); box-shadow:var(--shadow-panel); }
.skills-filters { padding:1rem .7rem; border-right:1px solid var(--color-border); background:color-mix(in srgb,var(--color-surface) 82%,transparent); }
.skills-filters p { margin:.6rem .65rem; color:var(--color-text-muted); font:650 .62rem var(--font-mono); text-transform:uppercase; letter-spacing:.11em; }
.skills-filters button { width:100%; display:flex; justify-content:space-between; padding:.62rem .65rem; border:0; border-radius:var(--radius-md); background:transparent; color:var(--color-text-muted); text-align:left; }
.skills-filters button:hover { background:var(--color-elevated); color:var(--color-text); }
.skills-filters button[data-active='true'] { background:color-mix(in srgb,var(--color-accent) 10%,var(--color-elevated)); color:var(--color-text); box-shadow:inset 2px 0 var(--color-accent); }
.skills-filters small { font-family:var(--font-mono); }
.skills-filter-rule { height:1px; margin:1rem .65rem; background:var(--color-border); }
.skills-catalog { min-width:0; padding:1rem; }
.skills-search { height:2.45rem; display:flex; align-items:center; gap:.55rem; padding:0 .75rem; margin-bottom:1rem; border:1px solid var(--color-border); border-radius:var(--radius-md); background:var(--color-background); }
.skills-search:focus-within { border-color:color-mix(in srgb,var(--color-accent) 45%,var(--color-border)); box-shadow:0 0 0 3px color-mix(in srgb,var(--color-accent) 7%,transparent); }
.skills-search svg { width:1rem; color:var(--color-text-muted); }
.skills-search input { width:100%; border:0; outline:0; background:transparent; color:var(--color-text); }
.skills-list { display:flex; flex-direction:column; gap:.45rem; }
.skill-card { width:100%; min-width:0; display:grid; grid-template-columns:2.5rem minmax(0,1fr) auto; align-items:center; gap:.75rem; padding:.68rem; border:1px solid transparent; border-radius:var(--radius-lg); background:color-mix(in srgb,var(--color-elevated) 46%,transparent); text-align:left; }
.skill-card:hover { border-color:var(--color-border); transform:translateX(2px); }
.skill-card[data-active='true'] { border-color:color-mix(in srgb,var(--color-accent) 28%,var(--color-border)); background:color-mix(in srgb,var(--color-accent) 6%,var(--color-elevated)); box-shadow:inset 3px 0 var(--color-accent); }
.skill-monogram,.skill-detail-icon { width:2.35rem; height:2.35rem; display:grid; place-items:center; border-radius:var(--radius-md); font:750 .73rem var(--font-mono); }
.skill-card-copy { min-width:0; }
.skill-card-copy strong,.skill-card-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skill-card-copy strong { font-size:.84rem; }
.skill-card-copy small { margin-top:.24rem; color:var(--color-text-muted); font-size:.68rem; }
.skill-card-meta { text-align:right; }
.skill-card-meta small { display:block; color:var(--color-text-muted); font: .6rem var(--font-mono); }
.skill-card-meta b { display:inline-block; margin-top:.3rem; padding:.18rem .35rem; border-radius:.3rem; background:color-mix(in srgb,var(--color-text-muted) 10%,transparent); color:var(--color-text-muted); font-size:.58rem; }
.skill-card-meta b[data-enabled='true'] { background:color-mix(in srgb,var(--color-success) 10%,transparent); color:var(--color-success); }
.skill-detail { min-width:0; padding:1.15rem; border-left:1px solid var(--color-border); background:color-mix(in srgb,var(--color-surface) 84%,transparent); }
.skill-detail-heading { display:flex; align-items:center; gap:.7rem; }
.skill-detail-heading h2 { margin:0; font-size:1rem; }
.skill-detail-heading p { margin:.16rem 0 0; color:var(--color-text-muted); font:.6rem var(--font-mono); text-transform:uppercase; }
.skill-toggle { width:2.15rem; height:1.25rem; margin-left:auto; padding:.15rem; border:0; border-radius:1rem; background:var(--color-control); }
.skill-toggle span { display:block; width:.95rem; height:.95rem; border-radius:50%; background:var(--color-text-muted); transition:transform .16s ease; }
.skill-toggle[aria-checked='true'] { background:color-mix(in srgb,var(--color-accent) 34%,var(--color-control)); }
.skill-toggle[aria-checked='true'] span { transform:translateX(.9rem); background:var(--color-accent); }
.skill-description { margin:1rem 0 1.3rem; color:var(--color-text-muted); font-size:.78rem; line-height:1.65; }
.skill-detail-section { margin-top:1.25rem; }
.skill-detail-section h3 { margin:0 0 .55rem; color:var(--color-text-muted); font:650 .61rem var(--font-mono); text-transform:uppercase; letter-spacing:.11em; }
.skill-trigger-copy,.skill-path { display:block; padding:.7rem; border:1px solid var(--color-border); border-radius:var(--radius-md); background:var(--color-background); color:var(--color-text-soft,var(--color-text-muted)); font-size:.7rem; line-height:1.55; overflow-wrap:anywhere; }
.skill-path { font-family:var(--font-mono); }
.skill-dependencies>div { display:grid; grid-template-columns:.45rem minmax(0,1fr) auto; align-items:center; gap:.55rem; padding:.48rem 0; border-bottom:1px solid color-mix(in srgb,var(--color-border) 68%,transparent); }
.skill-dependencies i { width:.4rem; height:.4rem; border-radius:50%; background:var(--color-success); }
.skill-dependencies strong,.skill-dependencies small { display:block; }
.skill-dependencies strong { font-size:.7rem; }
.skill-dependencies small,.skill-dependencies code { color:var(--color-text-muted); font-size:.6rem; }
.skill-detail-empty,.skill-update-error { color:var(--color-text-muted); font-size:.7rem; }
.skill-update-error { color:var(--color-danger); }
.skills-empty { min-height:10rem; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.35rem; color:var(--color-text-muted); text-align:center; }
@media (max-width: 1100px) { .skills-workbench { grid-template-columns:10rem minmax(20rem,1fr); } .skill-detail { grid-column:1/-1; border-left:0; border-top:1px solid var(--color-border); } }
@media (max-width: 760px) { .skills-page { padding:.85rem; } .skills-metrics { grid-template-columns:repeat(2,1fr); } .skills-metrics div:nth-child(2) { border-right:0; } .skills-workbench { grid-template-columns:1fr; } .skills-filters { border-right:0; border-bottom:1px solid var(--color-border); } .skills-hero { align-items:flex-start; } }
</style>
