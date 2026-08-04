<template>
  <section class="image-skin-studio" data-testid="image-skin-studio">
    <header class="image-skin-studio-header">
      <div>
        <span class="image-skin-studio-kicker">{{ t('theme.imageStudio.kicker') }}</span>
        <h4>{{ t('theme.imageStudio.title') }}</h4>
        <p>{{ t('theme.imageStudio.description') }}</p>
      </div>
      <span class="image-skin-studio-local">{{ t('theme.imageStudio.local') }}</span>
    </header>

    <div v-if="!previewUrl" class="image-skin-dropzone" :data-dragging="dragging" @dragenter.prevent="dragging = true" @dragover.prevent @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
      <span class="image-skin-dropzone-icon"><IconTablerPhoto /></span>
      <strong>{{ t('theme.imageStudio.dropTitle') }}</strong>
      <p>{{ t('theme.imageStudio.dropHint') }}</p>
      <button type="button" :disabled="busy || disabled" @click="openPicker">{{ t('theme.imageStudio.choose') }}</button>
    </div>

    <div v-else class="image-skin-workbench">
      <div class="image-skin-preview" :style="previewVariables">
        <div class="image-skin-preview-photo" />
        <div class="image-skin-preview-tint" />
        <div class="image-skin-preview-content">
          <div class="image-skin-preview-toolbar">
            <span>{{ draftName || t('theme.imageStudio.untitled') }}</span>
            <div class="image-skin-preview-modes" role="group" :aria-label="t('theme.imageStudio.previewMode')">
              <button type="button" :data-active="previewMode === 'light'" @click="previewMode = 'light'">{{ t('theme.mode.light') }}</button>
              <button type="button" :data-active="previewMode === 'dark'" @click="previewMode = 'dark'">{{ t('theme.mode.dark') }}</button>
            </div>
          </div>
          <div class="image-skin-preview-card">
            <span>{{ t('theme.imageStudio.previewEyebrow') }}</span>
            <strong>{{ t('theme.imageStudio.previewTitle') }}</strong>
            <p>{{ t('theme.imageStudio.previewBody') }}</p>
            <button type="button">{{ t('theme.imageStudio.previewAction') }}</button>
          </div>
        </div>
      </div>

      <div class="image-skin-controls">
        <label class="image-skin-name">
          <span>{{ t('theme.imageStudio.name') }}</span>
          <input v-model="draftName" type="text" maxlength="80" :placeholder="t('theme.imageStudio.namePlaceholder')" />
        </label>

        <div class="image-skin-palette">
          <span>{{ t('theme.imageStudio.palette') }}</span>
          <div>
            <i v-for="color in palette" :key="color" :style="{ background: color }" :title="color" />
          </div>
        </div>

        <label>
          <span>{{ t('theme.imageStudio.blur') }} <output>{{ blur }}px</output></span>
          <input v-model.number="blur" type="range" min="0" max="48" step="1" />
        </label>
        <label>
          <span>{{ t('theme.imageStudio.dim') }} <output>{{ dim }}%</output></span>
          <input v-model.number="dim" type="range" min="0" max="80" step="1" />
        </label>
        <label>
          <span>{{ t('theme.imageStudio.saturation') }} <output>{{ saturation }}%</output></span>
          <input v-model.number="saturation" type="range" min="50" max="160" step="1" />
        </label>
        <label>
          <span>{{ t('theme.imageStudio.position') }}</span>
          <select v-model="position">
            <option value="center">{{ t('theme.imageStudio.position.center') }}</option>
            <option value="center top">{{ t('theme.imageStudio.position.top') }}</option>
            <option value="center bottom">{{ t('theme.imageStudio.position.bottom') }}</option>
            <option value="left center">{{ t('theme.imageStudio.position.left') }}</option>
            <option value="right center">{{ t('theme.imageStudio.position.right') }}</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="previewUrl" class="image-skin-actions">
      <p>{{ imageMeta }}</p>
      <div>
        <button type="button" :disabled="busy || disabled" @click="openPicker">{{ t('theme.imageStudio.replace') }}</button>
        <button class="image-skin-save" type="button" :disabled="busy || disabled || !processedImage" @click="saveSkin">
          {{ busy ? t('theme.imageStudio.saving') : t('theme.imageStudio.save') }}
        </button>
      </div>
    </div>
    <p v-if="disabled" class="image-skin-status" data-tone="warning">{{ t('theme.imageStudio.workspaceLocked') }}</p>
    <p v-if="statusMessage" class="image-skin-status" :data-tone="statusTone" role="status">{{ statusMessage }}</p>
    <input ref="fileInputRef" class="image-skin-file-input" type="file" accept="image/png,image/jpeg,image/webp" @change="onFileChange" />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { uploadThemeAsset } from '../../api/codexThemeAssetClient'
import { useLocale } from '../../composables/useLocale'
import { createImageSkinPack, processThemeImage, type ProcessedThemeImage } from '../../theme/imageSkinGenerator'
import { contrastingTextColor } from '../../theme/themeRegistry'
import { useTheme } from '../../theme/useTheme'
import type { ResolvedThemeColorMode } from '../../theme/tokens'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'

const props = defineProps<{ disabled?: boolean }>()

const { t } = useLocale()
const { importSkin, setColorMode } = useTheme()
const fileInputRef = ref<HTMLInputElement | null>(null)
const previewUrl = ref('')
const processedImage = ref<ProcessedThemeImage | null>(null)
const palette = ref<string[]>([])
const draftName = ref('')
const previewMode = ref<ResolvedThemeColorMode>('dark')
const blur = ref(24)
const dim = ref(38)
const saturation = ref(108)
const position = ref('center')
const busy = ref(false)
const dragging = ref(false)
const statusMessage = ref('')
const statusTone = ref<'success' | 'danger'>('success')

const previewPack = computed(() => previewUrl.value ? createImageSkinPack({
  name: draftName.value,
  backgroundUrl: previewUrl.value,
  palette: palette.value,
  blur: blur.value,
  dim: dim.value,
  saturation: saturation.value,
  position: position.value,
  defaultColorMode: previewMode.value,
}) : null)
const previewTokens = computed(() => previewPack.value?.variants[previewMode.value]?.tokens)
const previewVariables = computed(() => ({
  '--preview-image': previewUrl.value ? `url("${previewUrl.value}")` : 'none',
  '--preview-blur': `${blur.value}px`,
  '--preview-dim': `${dim.value}%`,
  '--preview-saturation': `${saturation.value}%`,
  '--preview-position': position.value,
  '--preview-background': previewTokens.value?.color.background,
  '--preview-surface': previewTokens.value?.color.surface,
  '--preview-text': previewTokens.value?.color.text,
  '--preview-muted': previewTokens.value?.color.textMuted,
  '--preview-border': previewTokens.value?.color.border,
  '--preview-accent': previewTokens.value?.color.accent,
  '--preview-on-accent': previewTokens.value ? contrastingTextColor(previewTokens.value.color.accent) : '#ffffff',
}))
const imageMeta = computed(() => processedImage.value
  ? t('theme.imageStudio.meta', {
      width: String(processedImage.value.width),
      height: String(processedImage.value.height),
      size: (processedImage.value.byteSize / 1024 / 1024).toFixed(1),
    })
  : t('theme.imageStudio.processing'))

function openPicker(): void {
  fileInputRef.value?.click()
}

function releasePreview(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

async function selectFile(file: File): Promise<void> {
  if (props.disabled) return
  busy.value = true
  statusMessage.value = ''
  releasePreview()
  previewUrl.value = URL.createObjectURL(file)
  draftName.value = file.name.replace(/\.[^.]+$/u, '').slice(0, 80)
  try {
    const result = await processThemeImage(file)
    processedImage.value = result
    palette.value = result.palette
  } catch (error) {
    releasePreview()
    processedImage.value = null
    statusMessage.value = error instanceof Error ? error.message : t('theme.imageStudio.failed')
    statusTone.value = 'danger'
  } finally {
    busy.value = false
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void selectFile(file)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  if (props.disabled) return
  const file = event.dataTransfer?.files[0]
  if (file) void selectFile(file)
}

async function saveSkin(): Promise<void> {
  if (!processedImage.value) return
  busy.value = true
  statusMessage.value = ''
  try {
    const asset = await uploadThemeAsset(processedImage.value.dataUrl)
    const skin = createImageSkinPack({
      name: draftName.value,
      backgroundUrl: asset.url,
      palette: palette.value,
      blur: blur.value,
      dim: dim.value,
      saturation: saturation.value,
      position: position.value,
      defaultColorMode: previewMode.value,
    })
    importSkin(JSON.stringify(skin))
    setColorMode(previewMode.value)
    statusMessage.value = t('theme.imageStudio.saved', { name: skin.name })
    statusTone.value = 'success'
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : t('theme.imageStudio.failed')
    statusTone.value = 'danger'
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(releasePreview)
</script>

<style scoped>
@reference "../../style.css";

.image-skin-studio {
  margin-top: .9rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent) 22%, var(--color-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-elevated) 68%, transparent);
}

.image-skin-studio-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.1rem;
}

.image-skin-studio-kicker,
.image-skin-controls label > span,
.image-skin-palette > span {
  color: var(--color-accent);
  font-size: .68rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.image-skin-studio-header h4 { margin: .15rem 0 0; color: var(--color-text); font-size: 1rem; }
.image-skin-studio-header p { max-width: 42rem; margin: .3rem 0 0; color: var(--color-text-muted); font-size: .76rem; line-height: 1.5; }

.image-skin-studio-local {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--color-success) 34%, var(--color-border));
  border-radius: 999px;
  padding: .25rem .55rem;
  background: color-mix(in srgb, var(--color-success) 10%, transparent);
  color: var(--color-success);
  font-size: .68rem;
  font-weight: 650;
}

.image-skin-dropzone {
  display: grid;
  min-height: 11.5rem;
  place-items: center;
  align-content: center;
  gap: .45rem;
  margin: 0 1rem 1rem;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
  text-align: center;
  transition: border-color var(--motion-fast), background var(--motion-fast), transform var(--motion-fast);
}

.image-skin-dropzone[data-dragging='true'] { border-color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface)); transform: scale(.995); }
.image-skin-dropzone-icon { display: grid; width: 2.7rem; height: 2.7rem; place-items: center; border-radius: .8rem; background: color-mix(in srgb, var(--color-accent) 13%, transparent); color: var(--color-accent); }
.image-skin-dropzone-icon :deep(svg) { width: 1.35rem; height: 1.35rem; }
.image-skin-dropzone strong { color: var(--color-text); font-size: .88rem; }
.image-skin-dropzone p { margin: 0; color: var(--color-text-muted); font-size: .72rem; }
.image-skin-dropzone button,
.image-skin-actions button { min-height: 2.75rem; border: 1px solid var(--color-border); border-radius: .7rem; padding: 0 .9rem; background: var(--color-surface); color: var(--color-text); font-size: .76rem; font-weight: 650; }
.image-skin-dropzone button { margin-top: .35rem; border-color: color-mix(in srgb, var(--color-accent) 46%, var(--color-border)); }

.image-skin-workbench { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(15rem, .65fr); gap: .9rem; padding: 0 1rem 1rem; }
.image-skin-preview { position: relative; min-height: 20rem; overflow: hidden; border: 1px solid var(--preview-border); border-radius: var(--radius-md); background: var(--preview-background); isolation: isolate; }
.image-skin-preview-photo,
.image-skin-preview-tint { position: absolute; pointer-events: none; content: ''; inset: 0; }
.image-skin-preview-photo { z-index: -2; inset: calc(-1 * var(--preview-blur)); background: var(--preview-image) var(--preview-position) / cover no-repeat; filter: blur(var(--preview-blur)) saturate(var(--preview-saturation)); transform: scale(1.04); }
.image-skin-preview-tint { z-index: -1; background: color-mix(in srgb, var(--preview-background) var(--preview-dim), transparent); }
.image-skin-preview-content { display: grid; min-height: 20rem; grid-template-rows: auto 1fr; padding: .8rem; color: var(--preview-text); }
.image-skin-preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: .72rem; font-weight: 700; }
.image-skin-preview-modes { display: flex; gap: .15rem; border: 1px solid color-mix(in srgb, var(--preview-border) 80%, transparent); border-radius: .6rem; padding: .15rem; background: color-mix(in srgb, var(--preview-surface) 70%, transparent); }
.image-skin-preview-modes button { min-height: 2rem; border: 0; border-radius: .45rem; padding: 0 .55rem; background: transparent; color: var(--preview-muted); font-size: .68rem; }
.image-skin-preview-modes button[data-active='true'] { background: var(--preview-accent); color: var(--preview-on-accent); }
.image-skin-preview-card { align-self: end; max-width: 23rem; border: 1px solid color-mix(in srgb, var(--preview-border) 82%, transparent); border-radius: 1rem; padding: 1rem; background: color-mix(in srgb, var(--preview-surface) 78%, transparent); box-shadow: 0 22px 48px rgb(0 0 0 / .18); backdrop-filter: blur(18px) saturate(112%); }
.image-skin-preview-card span { color: var(--preview-accent); font-size: .65rem; font-weight: 700; text-transform: uppercase; }
.image-skin-preview-card strong { display: block; margin-top: .3rem; font-size: 1rem; }
.image-skin-preview-card p { margin: .4rem 0 .8rem; color: var(--preview-muted); font-size: .72rem; line-height: 1.5; }
.image-skin-preview-card button { min-height: 2.35rem; border: 0; border-radius: .6rem; padding: 0 .8rem; background: var(--preview-accent); color: var(--preview-on-accent); font-size: .72rem; font-weight: 700; }

.image-skin-controls { display: grid; align-content: start; gap: .8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: .9rem; background: color-mix(in srgb, var(--color-surface) 80%, transparent); }
.image-skin-controls label { display: grid; gap: .35rem; }
.image-skin-controls label > span { display: flex; justify-content: space-between; color: var(--color-text-muted); }
.image-skin-controls output { color: var(--color-text); font-family: var(--font-mono); }
.image-skin-controls input[type='text'],
.image-skin-controls select { min-height: 2.5rem; border: 1px solid var(--color-border); border-radius: .6rem; padding: 0 .7rem; background: var(--color-panel); color: var(--color-text); font-size: .76rem; outline: none; }
.image-skin-controls input[type='range'] { width: 100%; accent-color: var(--color-accent); }
.image-skin-palette { display: grid; gap: .35rem; }
.image-skin-palette > div { display: flex; gap: .35rem; }
.image-skin-palette i { width: 1.55rem; height: 1.55rem; border: 2px solid color-mix(in srgb, white 58%, var(--color-border)); border-radius: 999px; box-shadow: 0 2px 8px rgb(0 0 0 / .16); }

.image-skin-actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-top: 1px solid var(--color-border); padding: .8rem 1rem; }
.image-skin-actions p { margin: 0; color: var(--color-text-muted); font-size: .7rem; }
.image-skin-actions > div { display: flex; gap: .55rem; }
.image-skin-actions .image-skin-save { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-on-accent); }
.image-skin-file-input { display: none; }
.image-skin-status { margin: 0; border-top: 1px solid var(--color-border); padding: .65rem 1rem; color: var(--color-text-muted); font-size: .72rem; }
.image-skin-status[data-tone='success'] { color: var(--color-success); }
.image-skin-status[data-tone='danger'] { color: var(--color-danger); }
.image-skin-status[data-tone='warning'] { color: var(--color-warning); }
button:disabled { cursor: not-allowed; opacity: .55; }

@media (max-width: 760px) {
  .image-skin-workbench { grid-template-columns: 1fr; }
  .image-skin-preview { min-height: 16rem; }
  .image-skin-preview-content { min-height: 16rem; }
}

@media (max-width: 520px) {
  .image-skin-studio-header { flex-direction: column; }
  .image-skin-actions { align-items: stretch; flex-direction: column; }
  .image-skin-actions > div { width: 100%; }
  .image-skin-actions button { flex: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .image-skin-dropzone { transition: none; }
}
</style>
