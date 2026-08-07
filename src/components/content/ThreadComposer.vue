<template>
  <form class="thread-composer" data-cody-region="composer" data-testid="thread-composer" @submit.prevent="onSubmit">
    <div
      class="thread-composer-shell"
      data-cody-component="composer-surface"
      :data-drag-active="isDraggingImages"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <ul v-if="attachedImages.length > 0" class="thread-composer-image-list">
        <li v-for="image in attachedImages" :key="image.id" class="thread-composer-image-item">
          <img class="thread-composer-image-preview" :src="image.url" :alt="image.name" />
          <button
            class="thread-composer-image-remove"
            type="button"
            :aria-label="t('composer.removeImage')"
            :disabled="disabled"
            @click="removeImage(image.id)"
          >
            <IconTablerX class="thread-composer-image-remove-icon" />
          </button>
        </li>
      </ul>

      <ul v-if="selectedSkills.length > 0" class="thread-composer-skill-list">
        <li v-for="skill in selectedSkills" :key="`${skill.name}:${skill.path}`" class="thread-composer-skill-item">
          <span class="thread-composer-skill-name">${{ skill.displayName }}</span>
          <button
            class="thread-composer-skill-remove"
            type="button"
            :aria-label="t('composer.removeSkill')"
            :disabled="disabled"
            @click="removeSkill(skill)"
          >
            <IconTablerX class="thread-composer-skill-remove-icon" />
          </button>
        </li>
      </ul>

      <ul v-if="selectedContexts.length > 0" class="thread-composer-context-list">
        <li v-for="context in selectedContexts" :key="context.id" class="thread-composer-context-item">
          <span class="thread-composer-context-name">{{ context.label }}</span>
          <button
            class="thread-composer-context-remove"
            type="button"
            :aria-label="t('composer.removeContext')"
            :disabled="disabled"
            @click="removeContext(context)"
          >
            <IconTablerX class="thread-composer-context-remove-icon" />
          </button>
        </li>
      </ul>

      <textarea
        ref="draftInputRef"
        v-model="draft"
        class="thread-composer-input"
        data-testid="thread-composer-input"
        rows="1"
        :placeholder="placeholderText"
        :disabled="disabled || !activeThreadId"
        @input="onDraftInput"
        @click="onDraftCursorChange"
        @keyup="onDraftCursorChange"
        @paste="onPaste"
        @keydown="onDraftKeydown"
      />

      <div v-if="isSkillMenuOpen" class="thread-composer-skill-menu">
        <p v-if="isLoadingSkills" class="thread-composer-skill-status">{{ t('composer.skills.loading') }}</p>
        <p v-else-if="skillError" class="thread-composer-skill-status thread-composer-skill-status-error">
          {{ skillError }}
        </p>
        <p v-else-if="filteredSkills.length === 0" class="thread-composer-skill-status">{{ t('composer.skills.empty') }}</p>
        <template v-else>
          <button
            v-for="skill in filteredSkills"
            :key="`${skill.name}:${skill.path}`"
            class="thread-composer-skill-option"
            type="button"
            @mousedown.prevent="onSelectSkill(skill)"
          >
            <span class="thread-composer-skill-option-name">${{ skill.displayName }}</span>
            <span v-if="skill.description" class="thread-composer-skill-option-description">
              {{ skill.description }}
            </span>
          </button>
        </template>
      </div>

      <div v-if="isContextMenuOpen" class="thread-composer-context-menu">
        <p v-if="isLoadingContext" class="thread-composer-context-status">{{ t('composer.context.loading') }}</p>
        <p v-else-if="contextError" class="thread-composer-context-status thread-composer-context-status-error">
          {{ contextError }}
        </p>
        <p v-else-if="filteredContexts.length === 0" class="thread-composer-context-status">{{ t('composer.context.empty') }}</p>
        <template v-else>
          <button
            v-for="context in filteredContexts"
            :key="context.kind"
            class="thread-composer-context-option"
            type="button"
            @mousedown.prevent="onSelectContext(context)"
          >
            <span class="thread-composer-context-option-name">{{ context.label }}</span>
            <span class="thread-composer-context-option-description">{{ context.description }}</span>
          </button>
        </template>
      </div>

      <div class="thread-composer-controls">
        <input
          ref="fileInputRef"
          class="thread-composer-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          @change="onFileInputChange"
        />

        <button
          class="thread-composer-attach"
          type="button"
          :aria-label="t('composer.attachImages')"
          :title="t('composer.attachImages')"
          :disabled="disabled || !activeThreadId || isUploadingImage"
          @click="openFilePicker"
        >
          <IconTablerPhoto class="thread-composer-attach-icon" />
        </button>

        <button
          class="thread-composer-mobile-options"
          type="button"
          :aria-expanded="isMobileOptionsOpen"
          aria-controls="composer-mobile-options"
          @click="isMobileOptionsOpen = true"
        >
          <span>{{ t('composer.runSettings') }}</span>
          <small>{{ selectedModel }} · {{ selectedPermissionMode }}</small>
        </button>

        <ComposerDropdown
          class="thread-composer-control"
          :model-value="selectedCollaborationMode"
          :options="collaborationModeOptions"
          :placeholder="t('composer.mode')"
          open-direction="up"
          :disabled="disabled || !activeThreadId || collaborationModes.length === 0 || isTurnInProgress"
          @update:model-value="onCollaborationModeSelect"
        />

        <ComposerDropdown
          class="thread-composer-control"
          :model-value="selectedModel"
          :options="modelOptions"
          :placeholder="t('composer.default')"
          open-direction="up"
          :disabled="disabled || !activeThreadId || models.length === 0 || isTurnInProgress"
          @update:model-value="onModelSelect"
        />

        <ComposerDropdown
          class="thread-composer-control"
          :model-value="selectedReasoningEffort"
          :options="reasoningOptions"
          :placeholder="t('composer.thinking')"
          open-direction="up"
          :disabled="disabled || !activeThreadId || isTurnInProgress"
          @update:model-value="onReasoningEffortSelect"
        />

        <ComposerDropdown
          class="thread-composer-control thread-composer-permission-control"
          :model-value="selectedPermissionMode"
          :options="permissionModeOptions"
          :placeholder="t('composer.normal')"
          open-direction="up"
          :disabled="disabled || !activeThreadId || isTurnInProgress"
          @update:model-value="onPermissionModeSelect"
        />

        <span v-if="isUploadingImage" class="thread-composer-uploading">{{ t('composer.uploading') }}</span>
        <span v-else-if="uploadError" class="thread-composer-upload-error">{{ uploadError }}</span>
        <span v-else-if="busyLabel" class="thread-composer-busy">
          <span class="thread-composer-busy-dot" aria-hidden="true" />
          {{ busyLabel }}
        </span>

        <div class="thread-composer-actions">
          <button
            v-if="isTurnInProgress"
            class="thread-composer-stop"
            type="button"
            :aria-label="t('composer.stop')"
            :title="t('composer.stop')"
            :disabled="disabled || !activeThreadId || isInterruptingTurn"
            @click="onInterrupt"
          >
            <IconTablerPlayerStopFilled class="thread-composer-stop-icon" />
          </button>
          <button
            class="thread-composer-submit"
            data-testid="thread-composer-submit"
            type="submit"
            :aria-label="submitButtonLabel"
            :title="submitButtonLabel"
            :disabled="!canSubmit"
          >
            <IconTablerArrowUp class="thread-composer-submit-icon" />
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="isMobileOptionsOpen"
        class="thread-composer-options-backdrop"
        @click.self="isMobileOptionsOpen = false"
      >
        <section id="composer-mobile-options" class="thread-composer-options-sheet" role="dialog" aria-modal="true" :aria-label="t('composer.runSettings')">
          <header>
            <div>
              <span>{{ t('composer.beforeRun') }}</span>
              <h2>{{ t('composer.runSettings') }}</h2>
            </div>
            <button type="button" :aria-label="t('composer.closeSettings')" @click="isMobileOptionsOpen = false">{{ t('composer.done') }}</button>
          </header>
          <label>
            <span>{{ t('composer.collaboration') }}</span>
            <select :value="selectedCollaborationMode" :disabled="isTurnInProgress" @change="onMobileCollaborationChange">
              <option v-for="option in collaborationModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <small>{{ t('composer.collaborationHint') }}</small>
          </label>
          <label>
            <span>{{ t('composer.model') }}</span>
            <select :value="selectedModel" :disabled="isTurnInProgress" @change="onMobileModelChange">
              <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('composer.thinking') }}</span>
            <select :value="selectedReasoningEffort" :disabled="isTurnInProgress" @change="onMobileReasoningChange">
              <option v-for="option in reasoningOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('composer.permissions') }}</span>
            <select :value="selectedPermissionMode" :disabled="isTurnInProgress" @change="onMobilePermissionChange">
              <option v-for="option in permissionModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <small>{{ t('composer.permissionsHint') }}</small>
          </label>
        </section>
      </div>
    </Teleport>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  materializeComposerContextText,
  useComposerContext,
  type UiComposerContextOption,
} from '../../composables/useComposerContext'
import { hasImageFile, useComposerImages } from '../../composables/useComposerImages'
import { useComposerSkills } from '../../composables/useComposerSkills'
import { COMPOSER_PERMISSION_MODE_OPTIONS } from '../../composables/desktopTurnPermissions'
import type {
  ReasoningEffort,
  UiCollaborationModeOption,
  UiComposerPermissionMode,
  UiComposerContextAttachment,
  UiComposerSkill,
  UiComposerSubmitPayload,
} from '../../types/codex'
import IconTablerArrowUp from '../icons/IconTablerArrowUp.vue'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'
import IconTablerPlayerStopFilled from '../icons/IconTablerPlayerStopFilled.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import ComposerDropdown from './ComposerDropdown.vue'
import { insertPromptIntoDraft, type PromptInsertion } from '../../composables/promptLibraryRules'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  activeThreadId: string
  models: string[]
  selectedModel: string
  selectedReasoningEffort: ReasoningEffort | ''
  collaborationModes: UiCollaborationModeOption[]
  selectedCollaborationMode: string
  selectedPermissionMode: UiComposerPermissionMode
  cwd: string
  isTurnInProgress?: boolean
  isInterruptingTurn?: boolean
  disabled?: boolean
  busyLabel?: string
  promptInsertion?: PromptInsertion | null
  contextInsertion?: UiComposerContextAttachment | null
}>()

const emit = defineEmits<{
  submit: [payload: UiComposerSubmitPayload]
  interrupt: []
  'update:selected-model': [modelId: string]
  'update:selected-reasoning-effort': [effort: ReasoningEffort | '']
  'update:selected-collaboration-mode': [name: string]
  'update:selected-permission-mode': [mode: UiComposerPermissionMode]
}>()
const { t } = useLocale()

const draft = ref('')
const isMobileOptionsOpen = ref(false)
const draftInputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const dragDepth = ref(0)
const {
  attachedImages,
  isUploadingImage,
  uploadError,
  attachFiles,
  removeImage,
  resetImages,
} = useComposerImages()
const {
  selectedSkills,
  filteredSkills,
  isSkillMenuOpen,
  isLoadingSkills,
  skillError,
  updateSkillTrigger,
  selectSkill,
  removeSkill,
  closeSkillMenu,
  resetSkills,
} = useComposerSkills()
const {
  selectedContexts,
  filteredContexts,
  isContextMenuOpen,
  isLoadingContext,
  contextError,
  updateContextTrigger,
  selectContext,
  addContextAttachment,
  removeContext,
  closeContextMenu,
  resetContexts,
} = useComposerContext()
const reasoningOptions = computed<Array<{ value: ReasoningEffort; label: string }>>(() => [
  { value: 'none', label: t('composer.reasoning.none') },
  { value: 'minimal', label: t('composer.reasoning.minimal') },
  { value: 'low', label: t('composer.reasoning.low') },
  { value: 'medium', label: t('composer.reasoning.medium') },
  { value: 'high', label: t('composer.reasoning.high') },
  { value: 'xhigh', label: t('composer.reasoning.xhigh') },
])
const modelOptions = computed(() =>
  props.models.map((modelId) => ({ value: modelId, label: modelId })),
)
const collaborationModeOptions = computed(() =>
  props.collaborationModes.map((mode) => ({ value: mode.name, label: mode.label })),
)
const permissionModeOptions = COMPOSER_PERMISSION_MODE_OPTIONS
const canSubmit = computed(() => {
  if (props.disabled) return false
  if (!props.activeThreadId) return false
  if (isUploadingImage.value) return false
  return (
    draft.value.trim().length > 0 ||
    attachedImages.value.length > 0 ||
    selectedSkills.value.length > 0 ||
    selectedContexts.value.length > 0
  )
})

const placeholderText = computed(() =>
  props.activeThreadId
    ? props.isTurnInProgress
      ? t('composer.placeholder.guide')
      : t('composer.placeholder.message')
    : t('composer.placeholder.selectThread'),
)
const submitButtonLabel = computed(() =>
  props.isTurnInProgress ? t('composer.submit.guidance') : t('composer.submit.message'),
)
const canAttachImages = computed(() => !props.disabled && Boolean(props.activeThreadId))
const isDraggingImages = computed(() => canAttachImages.value && dragDepth.value > 0)

watch(() => props.promptInsertion?.id, () => {
  const insertion = props.promptInsertion
  if (!insertion) return
  const next = insertPromptIntoDraft(draft.value, insertion.text, getDraftCursor(), insertion.mode)
  draft.value = next.text
  void nextTick(() => {
    const input = draftInputRef.value
    if (!input) return
    input.focus()
    input.setSelectionRange(next.cursor, next.cursor)
    resizeDraftInput()
    onDraftCursorChange()
  })
})

watch(() => props.contextInsertion?.id, () => {
  const insertion = props.contextInsertion
  if (!insertion) return
  addContextAttachment(insertion)
  void nextTick(() => {
    draftInputRef.value?.focus()
    resizeDraftInput()
  })
})

function onSubmit(): void {
  const text = materializeComposerContextText(draft.value, selectedContexts.value)
  if (!canSubmit.value) return
  emit('submit', {
    text,
    images: attachedImages.value,
    skills: selectedSkills.value,
    contexts: selectedContexts.value,
  })
  draft.value = ''
  resetImages()
  resetSkills()
  resetContexts()
  void nextTick(resizeDraftInput)
}

function getDraftCursor(): number {
  return draftInputRef.value?.selectionStart ?? draft.value.length
}

function onDraftInput(): void {
  resizeDraftInput()
  void updateSkillTrigger(draft.value, getDraftCursor(), props.cwd)
  updateContextTrigger(draft.value, getDraftCursor())
}

function onDraftCursorChange(): void {
  void updateSkillTrigger(draft.value, getDraftCursor(), props.cwd)
  updateContextTrigger(draft.value, getDraftCursor())
}

function onDraftKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isContextMenuOpen.value) {
    closeContextMenu()
    return
  }

  if (event.key === 'Escape' && isSkillMenuOpen.value) {
    closeSkillMenu()
    return
  }

  if (event.key !== 'Enter') return
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  onSubmit()
}

function onSelectSkill(skill: UiComposerSkill): void {
  const selected = selectSkill(skill, draft.value)
  draft.value = selected.text
  void nextTick(() => {
    const input = draftInputRef.value
    if (!input) return
    input.focus()
    input.setSelectionRange(selected.cursor, selected.cursor)
    resizeDraftInput()
  })
}

function onSelectContext(context: UiComposerContextOption): void {
  void selectContext(context, draft.value, props.cwd).then((selected) => {
    draft.value = selected.text
    void nextTick(() => {
      const input = draftInputRef.value
      if (!input) return
      input.focus()
      input.setSelectionRange(selected.cursor, selected.cursor)
      resizeDraftInput()
    })
  })
}

function onInterrupt(): void {
  emit('interrupt')
}

function onModelSelect(value: string): void {
  emit('update:selected-model', value)
}

function onReasoningEffortSelect(value: string): void {
  emit('update:selected-reasoning-effort', value as ReasoningEffort)
}

function onCollaborationModeSelect(value: string): void {
  emit('update:selected-collaboration-mode', value)
}

function onPermissionModeSelect(value: string): void {
  emit('update:selected-permission-mode', value === 'yolo' ? 'yolo' : 'current')
}

function eventValue(event: Event): string {
  return (event.target as HTMLSelectElement).value
}

function onMobileCollaborationChange(event: Event): void { onCollaborationModeSelect(eventValue(event)) }
function onMobileModelChange(event: Event): void { onModelSelect(eventValue(event)) }
function onMobileReasoningChange(event: Event): void { onReasoningEffortSelect(eventValue(event)) }
function onMobilePermissionChange(event: Event): void { onPermissionModeSelect(eventValue(event)) }

function openFilePicker(): void {
  fileInputRef.value?.click()
}

function resizeDraftInput(): void {
  const input = draftInputRef.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${String(Math.min(input.scrollHeight, 140))}px`
}

function onFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files) {
    void attachFiles(input.files)
  }
  input.value = ''
}

function onPaste(event: ClipboardEvent): void {
  const files = event.clipboardData?.files
  if (!files || files.length === 0) return

  if (!hasImageFile(event.clipboardData?.items)) return

  event.preventDefault()
  void attachFiles(files)
}

function onDragEnter(event: DragEvent): void {
  if (!canAttachImages.value || !hasImageFile(event.dataTransfer?.items)) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (!canAttachImages.value || !hasImageFile(event.dataTransfer?.items)) return
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

function onDragLeave(event: DragEvent): void {
  if (!canAttachImages.value || dragDepth.value === 0) return
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(event: DragEvent): void {
  if (!canAttachImages.value || !event.dataTransfer?.files.length) return
  event.preventDefault()
  dragDepth.value = 0
  void attachFiles(event.dataTransfer.files)
}

watch(
  () => props.activeThreadId,
  () => {
    draft.value = ''
    resetImages()
    resetSkills()
    resetContexts()
    dragDepth.value = 0
    void nextTick(resizeDraftInput)
  },
)

watch(
  () => props.cwd,
  () => {
    resetSkills()
    resetContexts()
  },
)
</script>

<style scoped>
@reference "../../style.css";

.thread-composer {
  @apply w-full max-w-175 mx-auto px-6;
}

.thread-composer-shell {
  @apply rounded-2xl border theme-border theme-bg-panel p-3 shadow-sm transition;
}

.thread-composer-shell[data-drag-active='true'] {
  @apply border-zinc-700 theme-bg-subtle ring-2 ring-zinc-300;
}

.thread-composer-image-list {
  @apply mb-2 flex gap-2 overflow-x-auto pb-1;
}

.thread-composer-image-item {
  @apply relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border theme-border theme-bg-subtle;
}

.thread-composer-image-preview {
  @apply h-full w-full object-cover;
}

.thread-composer-image-remove {
  @apply absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/70 bg-zinc-900/75 text-white transition hover:bg-zinc-950 disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-composer-image-remove-icon {
  @apply h-3.5 w-3.5;
}

.thread-composer-skill-list {
  @apply mb-2 flex flex-wrap gap-2;
}

.thread-composer-skill-item {
  @apply flex max-w-full items-center gap-1 rounded-md border theme-border theme-bg-control px-2 py-1 text-xs theme-text;
}

.thread-composer-skill-name {
  @apply min-w-0 truncate font-mono;
}

.thread-composer-skill-remove {
  @apply flex h-4 w-4 shrink-0 items-center justify-center rounded theme-muted transition hover:bg-slate-200 hover:theme-text disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-composer-skill-remove-icon {
  @apply h-3 w-3;
}

.thread-composer-context-list {
  @apply mb-2 flex flex-wrap gap-2;
}

.thread-composer-context-item {
  @apply flex max-w-full items-center gap-1 rounded-md border theme-border-success theme-bg-success-soft px-2 py-1 text-xs theme-text-success;
}

.thread-composer-context-name {
  @apply min-w-0 truncate font-mono;
}

.thread-composer-context-remove {
  @apply flex h-4 w-4 shrink-0 items-center justify-center rounded text-emerald-600 transition hover:theme-bg-success-soft hover:theme-text-success disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-composer-context-remove-icon {
  @apply h-3 w-3;
}

.thread-composer-input {
  @apply block w-full min-w-0 max-h-35 min-h-11 resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-1 py-3 text-sm leading-5 theme-text outline-none transition;
}

.thread-composer-input:focus {
  @apply ring-0;
}

.thread-composer-input:disabled {
  @apply theme-bg-control theme-muted cursor-not-allowed;
}

.thread-composer-skill-menu {
  @apply mb-2 max-h-64 overflow-y-auto rounded-lg border theme-border theme-bg-panel p-1 shadow-lg;
}

.thread-composer-skill-status {
  @apply m-0 px-3 py-2 text-xs theme-muted;
}

.thread-composer-skill-status-error {
  @apply text-rose-600;
}

.thread-composer-skill-option {
  @apply flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition hover:theme-bg-control;
}

.thread-composer-skill-option-name {
  @apply text-sm font-medium theme-text;
}

.thread-composer-skill-option-description {
  @apply line-clamp-2 text-xs leading-4 theme-muted;
}

.thread-composer-context-menu {
  @apply mb-2 max-h-64 overflow-y-auto rounded-lg border theme-border-success theme-bg-panel p-1 shadow-lg;
}

.thread-composer-context-status {
  @apply m-0 px-3 py-2 text-xs theme-text-success;
}

.thread-composer-context-status-error {
  @apply text-rose-600;
}

.thread-composer-context-option {
  @apply flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition hover:theme-bg-success-soft;
}

.thread-composer-context-option-name {
  @apply text-sm font-medium theme-text-success;
}

.thread-composer-context-option-description {
  @apply line-clamp-2 text-xs leading-4 theme-text-success;
}

.thread-composer-controls {
  @apply mt-3 flex items-center gap-4;
}

.thread-composer-file-input {
  @apply hidden;
}

.thread-composer-attach {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border theme-border theme-bg-panel theme-muted transition hover:theme-border hover:theme-bg-subtle disabled:cursor-not-allowed disabled:theme-bg-control disabled:theme-muted;
}

.thread-composer-attach-icon {
  @apply h-4.5 w-4.5;
}

.thread-composer-control {
  @apply shrink-0;
}

.thread-composer-mobile-options {
  @apply hidden;
}

.thread-composer-permission-control {
  @apply theme-text-warning;
}

.thread-composer-uploading {
  @apply text-xs theme-muted;
}

.thread-composer-upload-error {
  @apply min-w-0 flex-1 truncate text-xs text-rose-600;
}

.thread-composer-busy {
  @apply inline-flex min-w-0 flex-1 items-center gap-2 truncate text-xs font-medium theme-muted;
}

.thread-composer-busy-dot {
  @apply h-2 w-2 shrink-0 rounded-full theme-bg-success;
  animation: thread-composer-busy-pulse 1.1s ease-in-out infinite;
}

@keyframes thread-composer-busy-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.9);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.thread-composer-actions {
  @apply ml-auto flex shrink-0 items-center gap-2;
}

.thread-composer-submit {
  @apply inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-0 theme-bg-accent theme-on-accent transition hover:bg-black disabled:cursor-not-allowed disabled:theme-bg-disabled disabled:theme-muted;
}

.thread-composer-submit-icon {
  @apply h-5 w-5;
}

.thread-composer-stop {
  @apply inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-0 theme-bg-accent theme-on-accent transition hover:bg-black disabled:cursor-not-allowed disabled:theme-bg-disabled disabled:theme-muted;
}

.thread-composer-stop-icon {
  @apply h-5 w-5;
}

.thread-composer-options-backdrop,
.thread-composer-options-sheet {
  display: none;
}

@media (max-width: 720px) {
  .thread-composer-control {
    display: none;
  }

  .thread-composer-mobile-options {
    display: grid;
    min-width: 0;
    gap: 0.1rem;
    border: 0;
    background: transparent;
    color: var(--color-text);
    text-align: left;
  }

  .thread-composer-mobile-options span {
    font-size: 0.72rem;
    font-weight: 650;
  }

  .thread-composer-mobile-options small {
    max-width: 10rem;
    overflow: hidden;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-composer-options-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    background: rgb(2 6 12 / 0.66);
    backdrop-filter: blur(6px);
  }

  .thread-composer-options-sheet {
    display: grid;
    width: 100%;
    max-height: 86vh;
    gap: 1rem;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-bottom: 0;
    border-radius: 1.25rem 1.25rem 0 0;
    background: var(--color-panel);
    padding: 1.1rem 1rem calc(1rem + env(safe-area-inset-bottom));
    box-shadow: var(--shadow-floating);
  }

  .thread-composer-options-sheet header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .thread-composer-options-sheet header span,
  .thread-composer-options-sheet label > span {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .thread-composer-options-sheet h2 {
    margin: 0.2rem 0 0;
    color: var(--color-text);
    font-size: 1.25rem;
  }

  .thread-composer-options-sheet header button {
    border: 0;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    padding: 0.55rem 0.8rem;
    color: #071018;
    font-weight: 700;
  }

  .thread-composer-options-sheet label {
    display: grid;
    gap: 0.4rem;
  }

  .thread-composer-options-sheet select {
    width: 100%;
    min-height: 2.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-elevated);
    padding-inline: 0.75rem;
    color: var(--color-text);
  }

  .thread-composer-options-sheet label small {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
}
</style>
