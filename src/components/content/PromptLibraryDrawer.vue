<template>
  <Teleport to="body">
    <div v-if="open" class="prompt-library-layer" @click.self="emit('close')">
      <aside class="prompt-library" role="dialog" aria-modal="true" :aria-label="t('promptLibrary.aria')" :data-editing="isEditing">
        <header class="prompt-library-header">
          <div>
            <span class="prompt-library-eyebrow">{{ t('promptLibrary.eyebrow') }}</span>
            <h2>{{ t('promptLibrary.title') }}</h2>
            <p>{{ t('promptLibrary.subtitle') }}</p>
          </div>
          <button class="prompt-library-close" type="button" :aria-label="t('promptLibrary.close')" @click="emit('close')">
            <IconTablerX />
          </button>
        </header>

        <div v-if="!isEditing" class="prompt-library-toolbar">
          <label class="prompt-library-search">
            <IconTablerSearch />
            <input v-model="query" type="search" :placeholder="t('promptLibrary.search')" autofocus />
          </label>
          <div class="prompt-library-create-actions">
            <button class="prompt-library-ai" type="button" :disabled="!cwd.trim()" @click="startCreate('ai')">{{ t('promptLibrary.aiNew') }}</button>
            <button class="prompt-library-new" type="button" @click="startCreate('human')">+ {{ t('promptLibrary.new') }}</button>
          </div>
        </div>

        <template v-if="isEditing">
          <form class="prompt-library-editor" @submit.prevent="saveEditor">
            <div class="prompt-library-editor-heading">
              <div><span>{{ editor.id ? t('promptLibrary.edit') : t('promptLibrary.newHeading') }}</span><h3>{{ t('promptLibrary.editorTitle') }}</h3></div>
              <button type="button" @click="cancelEditor">{{ t('promptLibrary.cancel') }}</button>
            </div>
            <section v-if="editor.authoringMode === 'ai'" class="scenario-ai-drafter">
              <div>
                <strong>{{ t('promptLibrary.ai.title') }}</strong>
                <span>{{ t('promptLibrary.ai.hint') }}</span>
              </div>
              <label>{{ t('promptLibrary.ai.brief') }}<textarea v-model="editor.aiBrief" required rows="5" :placeholder="t('promptLibrary.ai.placeholder')" /></label>
              <button type="button" :disabled="isDrafting || !editor.aiBrief.trim() || !cwd.trim()" @click="generateDraft">
                {{ isDrafting ? t('promptLibrary.ai.drafting') : t('promptLibrary.ai.generate') }}
              </button>
              <p v-if="draftReason" class="scenario-ai-reason">{{ draftReason }}</p>
            </section>
            <label>{{ t('promptLibrary.field.title') }}<input v-model="editor.title" required maxlength="80" /></label>
            <label>{{ t('promptLibrary.field.description') }}<input v-model="editor.description" maxlength="160" /></label>
            <div class="prompt-library-editor-grid">
              <label>{{ t('promptLibrary.field.category') }}<input v-model="editor.category" maxlength="32" /></label>
              <label>{{ t('promptLibrary.field.availability') }}
                <select v-model="editor.scope">
                  <option value="global">{{ t('promptLibrary.scope.global') }}</option>
                  <option value="workspace" :disabled="!cwd.trim()">{{ t('promptLibrary.scope.workspace') }}</option>
                </select>
              </label>
            </div>
            <label>{{ t('promptLibrary.field.primarySkill') }}
              <select v-model="editor.primarySkillPath" :disabled="isLoadingSkills">
                <option value="">{{ t('promptLibrary.skill.none') }}</option>
                <option v-for="skill in selectableSkills" :key="`${skill.name}:${skill.path}`" :value="skill.path">
                  {{ skill.displayName || skill.name }}
                </option>
              </select>
              <small>{{ isLoadingSkills ? t('promptLibrary.skill.loading') : t('promptLibrary.skill.hint') }}</small>
            </label>
            <label>{{ t('promptLibrary.field.prompt') }}<textarea v-model="editor.content" required rows="12" /></label>
            <p v-if="editorError" class="prompt-library-error">{{ editorError }}</p>
            <div class="prompt-library-editor-actions">
              <button v-if="editor.id && !editor.id.startsWith('builtin-')" class="prompt-library-delete" type="button" @click="deleteEditor">{{ t('promptLibrary.delete') }}</button>
              <button class="prompt-library-save" type="submit" :disabled="isSaving">{{ isSaving ? t('promptLibrary.saving') : t('promptLibrary.save') }}</button>
            </div>
          </form>
        </template>

        <template v-else>
          <nav class="prompt-library-categories" :aria-label="t('promptLibrary.categories')">
            <button v-for="item in categories" :key="item" type="button" :data-active="category === item" @click="category = item">{{ item === 'All' ? t('promptLibrary.all') : item }}</button>
          </nav>

          <div v-if="isLoading" class="prompt-library-empty">{{ t('promptLibrary.loading') }}</div>
          <div v-else-if="filteredTemplates.length === 0" class="prompt-library-empty">
            <strong>{{ t('promptLibrary.empty.title') }}</strong>
            <span>{{ t('promptLibrary.empty.body') }}</span>
          </div>
          <ol v-else class="prompt-library-list">
            <li v-for="template in filteredTemplates" :key="template.id" class="prompt-library-card">
              <button class="prompt-library-card-main" type="button" @click="useTemplate(template, 'insert')">
                <span class="prompt-library-card-meta"><b>{{ template.category }}</b><i>{{ template.scope === 'workspace' ? t('promptLibrary.scope.thisWorkspace') : t('promptLibrary.scope.globalShort') }}</i></span>
                <strong>{{ template.title }}</strong>
                <span class="scenario-package-summary">{{ template.description || template.content }}</span>
                <span class="scenario-package-capabilities">
                  <i v-if="template.primarySkill">{{ t('promptLibrary.skill.primary') }} · {{ template.primarySkill.displayName || template.primarySkill.name }}</i>
                  <i v-else>{{ t('promptLibrary.skill.autodiscover') }}</i>
                  <i v-if="template.authoringMode === 'ai'">{{ t('promptLibrary.ai.badge') }}</i>
                </span>
              </button>
              <div class="prompt-library-card-actions">
                <button type="button" :aria-label="template.isFavorite ? t('promptLibrary.favorite.remove') : t('promptLibrary.favorite.add')" :title="template.isFavorite ? t('promptLibrary.favorite.remove') : t('promptLibrary.favorite.add')" @click="toggleFavorite(template)">{{ template.isFavorite ? '★' : '☆' }}</button>
                <button type="button" :title="t('promptLibrary.replaceTitle')" @click="useTemplate(template, 'replace')">{{ t('promptLibrary.replace') }}</button>
                <button type="button" :title="t('promptLibrary.editTitle')" @click="startEdit(template)"><IconTablerFilePencil /></button>
              </div>
            </li>
          </ol>
          <footer class="prompt-library-footer"><span>{{ t('promptLibrary.count', { count: String(filteredTemplates.length) }) }}</span><span>{{ t('promptLibrary.hint') }}</span></footer>
        </template>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { deletePromptTemplate, draftScenarioPackage, fetchPromptTemplates, recordPromptTemplateUse, replacePromptTemplates, savePromptTemplate, setPromptTemplateFavorite } from '../../api/codexPromptLibraryClient'
import { getAvailableSkills } from '../../api/codexComposerClient'
import { useLocale } from '../../composables/useLocale'
import {
  normalizePromptTemplates,
  createPromptTemplateId,
  visiblePromptTemplates,
  type PromptInsertion,
  type PromptTemplate,
  type PromptTemplateScope,
} from '../../composables/promptLibraryRules'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'

const props = defineProps<{ open: boolean; cwd: string }>()
const emit = defineEmits<{ close: []; insert: [insertion: PromptInsertion] }>()
const { t } = useLocale()

const templates = ref<PromptTemplate[]>([])
const query = ref('')
const category = ref('All')
const isLoading = ref(false)
const isSaving = ref(false)
const isDrafting = ref(false)
const isLoadingSkills = ref(false)
const isEditing = ref(false)
const editorError = ref('')
const availableSkills = ref<ComposerSkill[]>([])
const draftReason = ref('')
const editor = reactive({
  id: '', title: '', description: '', category: 'General', content: '', scope: 'global' as PromptTemplateScope,
  primarySkillPath: '', authoringMode: 'human' as 'human' | 'ai', aiBrief: '',
})
let insertionId = 0

const filteredTemplates = computed(() => visiblePromptTemplates(templates.value, props.cwd, query.value, category.value))
const categories = computed(() => ['All', ...new Set(visiblePromptTemplates(templates.value, props.cwd, '').map((template) => template.category))])
const selectableSkills = computed(() => {
  const current = templates.value.find((template) => template.id === editor.id)?.primarySkill
  const skills = current && !availableSkills.value.some((skill) => skill.path === current.path)
    ? [current, ...availableSkills.value]
    : availableSkills.value
  return [...skills].sort((left, right) => (left.displayName || left.name).localeCompare(right.displayName || right.name))
})

async function loadTemplates(): Promise<void> {
  isLoading.value = true
  try {
    const stored = await fetchPromptTemplates()
    templates.value = stored.length > 0 ? normalizePromptTemplates(stored) : normalizePromptTemplates(null)
    if (stored.length === 0) await persistTemplates()
  } catch {
    templates.value = normalizePromptTemplates(null)
  } finally {
    isLoading.value = false
  }
}

async function persistTemplates(): Promise<void> {
  templates.value = normalizePromptTemplates(await replacePromptTemplates(templates.value))
}

function resetEditor(): void {
  Object.assign(editor, { id: '', title: '', description: '', category: 'General', content: '', scope: 'global', primarySkillPath: '', authoringMode: 'human', aiBrief: '' })
  editorError.value = ''
  draftReason.value = ''
}

function startCreate(mode: 'human' | 'ai'): void { resetEditor(); editor.authoringMode = mode; if (mode === 'ai' && props.cwd.trim()) editor.scope = 'workspace'; isEditing.value = true }
function startEdit(template: PromptTemplate): void {
  Object.assign(editor, {
    id: template.id, title: template.title, description: template.description, category: template.category,
    content: template.content, scope: template.scope, primarySkillPath: template.primarySkill?.path ?? '',
    authoringMode: template.authoringMode, aiBrief: '',
  })
  isEditing.value = true
}
function cancelEditor(): void { isEditing.value = false; resetEditor() }

async function saveEditor(): Promise<void> {
  if (!editor.title.trim() || !editor.content.trim()) return
  if (editor.scope === 'workspace' && !props.cwd.trim()) {
    editorError.value = t('promptLibrary.workspaceRequired')
    return
  }
  isSaving.value = true
  try {
    const now = new Date().toISOString()
    const existing = templates.value.find((template) => template.id === editor.id)
    const primarySkill = selectableSkills.value.find((skill) => skill.path === editor.primarySkillPath) ?? null
    const next: PromptTemplate = {
      id: existing?.id ?? createPromptTemplateId(),
      title: editor.title.trim(),
      description: editor.description.trim(),
      category: editor.category.trim() || 'General',
      content: editor.content.trim(),
      primarySkill: primarySkill ? { ...primarySkill } : null,
      authoringMode: editor.authoringMode,
      scope: editor.scope,
      workspaceCwd: editor.scope === 'workspace' ? props.cwd.trim() : '',
      isFavorite: existing?.isFavorite ?? false,
      useCount: existing?.useCount ?? 0,
      lastUsedAtIso: existing?.lastUsedAtIso ?? '',
      createdAtIso: existing?.createdAtIso ?? now,
      updatedAtIso: now,
    }
    const saved = await savePromptTemplate(next, existing?.updatedAtIso ?? '')
    templates.value = existing ? templates.value.map((template) => template.id === existing.id ? saved : template) : [saved, ...templates.value]
    cancelEditor()
  } catch {
    editorError.value = t('promptLibrary.saveFailed')
  } finally {
    isSaving.value = false
  }
}

async function loadSkills(): Promise<void> {
  isLoadingSkills.value = true
  try { availableSkills.value = await getAvailableSkills(props.cwd.trim() || undefined) }
  catch { availableSkills.value = [] }
  finally { isLoadingSkills.value = false }
}

async function generateDraft(): Promise<void> {
  if (!props.cwd.trim() || !editor.aiBrief.trim() || isDrafting.value) return
  isDrafting.value = true
  editorError.value = ''
  draftReason.value = ''
  try {
    const draft = await draftScenarioPackage(props.cwd, editor.aiBrief)
    if (draft.primarySkill && !availableSkills.value.some((skill) => skill.path === draft.primarySkill?.path)) {
      availableSkills.value = [...availableSkills.value, draft.primarySkill]
    }
    Object.assign(editor, {
      title: draft.title, description: draft.description, category: draft.category,
      content: draft.content, primarySkillPath: draft.primarySkill?.path ?? '', scope: 'workspace', authoringMode: 'ai',
    })
    draftReason.value = draft.reason
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : t('promptLibrary.ai.failed')
  } finally { isDrafting.value = false }
}

async function deleteEditor(): Promise<void> {
  if (!editor.id || !window.confirm(t('promptLibrary.deleteConfirm'))) return
  const existing = templates.value.find((template) => template.id === editor.id)
  await deletePromptTemplate(editor.id, existing?.updatedAtIso ?? '')
  templates.value = templates.value.filter((template) => template.id !== editor.id)
  cancelEditor()
}

function useTemplate(template: PromptTemplate, mode: PromptInsertion['mode']): void {
  const now = new Date().toISOString()
  templates.value = templates.value.map((item) => item.id === template.id ? { ...item, useCount: item.useCount + 1, lastUsedAtIso: now } : item)
  void recordPromptTemplateUse(template.id, now).then((saved) => {
    templates.value = templates.value.map((item) => item.id === saved.id ? saved : item)
  })
  emit('insert', { id: ++insertionId, text: template.content, skills: template.primarySkill ? [{ ...template.primarySkill }] : [], mode })
  emit('close')
}

function toggleFavorite(template: PromptTemplate): void {
  const isFavorite = !template.isFavorite
  templates.value = templates.value.map((item) => item.id === template.id ? { ...item, isFavorite } : item)
  void setPromptTemplateFavorite(template.id, isFavorite).then((saved) => {
    templates.value = templates.value.map((item) => item.id === saved.id ? saved : item)
  })
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  if (isEditing.value) cancelEditor()
  else emit('close')
}

watch(() => props.open, (open) => {
  if (!open) return
  query.value = ''
  category.value = 'All'
  isEditing.value = false
  window.addEventListener('keydown', onWindowKeydown)
  void Promise.all([loadTemplates(), loadSkills()])
})

watch(() => props.cwd, () => { if (props.open) void loadSkills() })

watch(() => props.open, (open, previous) => {
  if (previous && !open) window.removeEventListener('keydown', onWindowKeydown)
})

onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<style scoped>
@reference "../../style.css";
.prompt-library-layer { @apply fixed inset-0 z-[120] flex justify-end bg-black/45 backdrop-blur-[2px]; }
.prompt-library { @apply grid h-full min-w-0 w-[min(31rem,100vw)] grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] overflow-hidden border-l theme-border theme-bg-panel theme-text shadow-2xl; animation: prompt-drawer-in 180ms ease-out; }
.prompt-library[data-editing='true'] { grid-template-rows: auto minmax(0, 1fr); }
.prompt-library-header { @apply flex items-start justify-between gap-4 border-b theme-border px-5 pb-4 pt-5; }
.prompt-library-eyebrow { @apply font-mono text-[0.62rem] font-bold uppercase tracking-[0.16em] theme-muted; }
.prompt-library-header h2 { @apply m-0 mt-1 text-xl font-semibold tracking-tight; }
.prompt-library-header p { @apply m-0 mt-1 max-w-96 text-xs leading-5 theme-muted; }
.prompt-library-close { @apply grid h-9 w-9 shrink-0 place-items-center rounded-md border theme-border theme-bg-control theme-muted transition hover:theme-bg-subtle hover:theme-text; }
.prompt-library-close svg { @apply h-4 w-4; }
.prompt-library-toolbar { @apply grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-5 py-3; }
.prompt-library-search { @apply flex h-9 items-center gap-2 rounded-md border theme-border theme-bg-subtle px-3; }
.prompt-library-search svg { @apply h-4 w-4 theme-muted; }
.prompt-library-search input { @apply min-w-0 flex-1 border-0 bg-transparent text-sm outline-none theme-text; }
.prompt-library-create-actions { @apply flex gap-2; }
.prompt-library-new,.prompt-library-save { @apply min-h-11 rounded-md border theme-border-info theme-bg-accent px-3 text-xs font-semibold theme-on-accent transition hover:theme-bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50; }
.prompt-library-ai { @apply min-h-11 rounded-md border theme-border theme-bg-control px-3 text-xs font-semibold theme-text transition hover:theme-bg-subtle disabled:cursor-not-allowed disabled:opacity-50; }
.prompt-library-categories { @apply flex gap-1 overflow-x-auto border-b theme-border px-5 pb-3; scrollbar-width: none; }
.prompt-library-categories button { @apply shrink-0 rounded-full border border-transparent px-2.5 py-1 text-[0.68rem] font-medium theme-muted; }
.prompt-library-categories button[data-active='true'] { @apply theme-border theme-bg-control theme-text; }
.prompt-library-list { @apply m-0 grid content-start gap-2 overflow-y-auto px-5 py-3; list-style: none; }
.prompt-library-card { @apply grid grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-lg border theme-border theme-bg-subtle transition hover:border-[var(--color-accent)]; }
.prompt-library-card-main { @apply grid min-w-0 gap-1 border-0 bg-transparent px-3.5 py-3 text-left; }
.prompt-library-card-main strong { @apply text-sm theme-text; }
.scenario-package-summary { @apply line-clamp-2 text-xs leading-5 theme-muted; }
.scenario-package-capabilities { @apply mt-1 flex flex-wrap gap-1.5; }
.scenario-package-capabilities i { @apply rounded-full border theme-border theme-bg-control px-2 py-0.5 text-[0.58rem] font-semibold not-italic theme-muted; }
.prompt-library-card-meta { @apply flex items-center gap-2 font-mono text-[0.58rem] uppercase tracking-wide; }
.prompt-library-card-meta b { @apply text-[var(--color-accent)]; }
.prompt-library-card-meta i { @apply not-italic theme-muted; }
.prompt-library-card-actions { @apply flex w-16 flex-col border-l theme-border; }
.prompt-library-card-actions button { @apply grid min-h-8 flex-1 place-items-center border-0 border-b theme-border bg-transparent px-1 text-[0.62rem] theme-muted transition last:border-b-0 hover:theme-bg-control hover:theme-text; }
.prompt-library-card-actions svg { @apply h-3.5 w-3.5; }
.prompt-library-empty { @apply grid place-content-center gap-1 px-5 py-16 text-center text-sm theme-muted; }
.prompt-library-empty strong { @apply theme-text; }
.prompt-library-footer { @apply flex justify-between border-t theme-border px-5 py-2.5 font-mono text-[0.6rem] theme-muted; }
.prompt-library-editor { @apply col-span-full grid w-full min-w-0 content-start gap-3 overflow-y-auto px-5 py-4; }
.prompt-library-editor-heading { @apply mb-1 flex min-w-0 items-start justify-between gap-2 border-b theme-border pb-3; }
.prompt-library-editor-heading > div { @apply min-w-0; }
.prompt-library-editor-heading span { @apply font-mono text-[0.6rem] uppercase tracking-widest theme-muted; }
.prompt-library-editor-heading h3 { @apply m-0 mt-1 break-words text-base; }
.prompt-library-editor-heading button { @apply min-h-11 shrink-0 px-2 text-xs theme-muted; }
.prompt-library-editor label { @apply grid gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wide theme-muted; }
.prompt-library-editor input,.prompt-library-editor select,.prompt-library-editor textarea { @apply w-full min-w-0 max-w-full rounded-md border theme-border theme-bg-subtle px-3 py-2 text-sm font-normal normal-case tracking-normal outline-none theme-text focus:border-[var(--color-accent)]; }
.prompt-library-editor label > small { @apply text-[0.62rem] font-normal normal-case leading-4 tracking-normal theme-muted; }
.prompt-library-editor textarea { @apply resize-y font-mono text-xs leading-5; }
.prompt-library-editor-grid { @apply grid grid-cols-2 gap-3; }
.prompt-library-editor-actions { @apply flex justify-end gap-2 pt-1; }
.prompt-library-editor-actions button { @apply min-h-9 rounded-md px-3 text-xs font-semibold; }
.prompt-library-delete { @apply mr-auto theme-text-danger; }
.prompt-library-error { @apply m-0 text-xs theme-text-danger; }
.scenario-ai-drafter { @apply grid min-w-0 gap-3 rounded-lg border p-3; border-color:color-mix(in srgb,var(--color-accent) 30%,var(--color-border)); background:color-mix(in srgb,var(--color-accent) 6%,var(--color-panel)); }
.scenario-ai-drafter > div { @apply grid gap-0.5; }
.scenario-ai-drafter > div strong { @apply text-sm theme-text; }
.scenario-ai-drafter > div span { @apply text-xs leading-5 theme-muted; }
.scenario-ai-drafter > button { @apply min-h-11 justify-self-end rounded-md border theme-border-info theme-bg-accent px-3 text-xs font-semibold theme-on-accent disabled:cursor-not-allowed disabled:opacity-50; }
.scenario-ai-reason { @apply m-0 rounded-md border theme-border theme-bg-subtle p-2 text-xs leading-5 theme-muted; }
@keyframes prompt-drawer-in { from { opacity: .65; transform: translateX(1.5rem); } }
@media (max-width: 600px) { .prompt-library { @apply w-full; } .prompt-library-editor-grid { @apply grid-cols-1; } }
@media (prefers-reduced-motion: reduce) { .prompt-library { animation: none; } }
</style>
