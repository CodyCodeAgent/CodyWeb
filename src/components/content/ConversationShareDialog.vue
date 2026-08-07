<template>
  <div class="share-dialog-backdrop" @click.self="closeDialog">
    <section class="share-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" @keydown.esc="closeDialog">
      <header class="share-dialog-header">
        <div>
          <p>{{ copy.eyebrow }}</p>
          <h2 :id="titleId">{{ copy.title }}</h2>
          <span>{{ copy.subtitle }}</span>
        </div>
        <button ref="closeButton" class="share-dialog-close" type="button" :aria-label="copy.close" @click="closeDialog">
          <IconTablerX />
        </button>
      </header>

      <nav class="share-dialog-tabs" :aria-label="copy.tabs">
        <button type="button" :data-active="activeTab === 'create'" @click="activeTab = 'create'">{{ copy.createTab }}</button>
        <button type="button" :data-active="activeTab === 'manage'" @click="activeTab = 'manage'">
          {{ copy.manageTab }}<span v-if="activeShares.length > 0">{{ activeShares.length }}</span>
        </button>
      </nav>

      <div v-if="activeTab === 'create'" class="share-dialog-create">
        <section v-if="createdShare" class="share-success" aria-live="polite">
          <span class="share-success-mark" aria-hidden="true"><IconTablerCheck /></span>
          <div>
            <p>{{ copy.created }}</p>
            <h3>{{ createdShare.title }}</h3>
            <span>{{ copy.publicHint }}</span>
          </div>
          <label>
            <span>{{ copy.link }}</span>
            <div class="share-link-field">
              <input :value="createdShareUrl" readonly @focus="selectInputText" />
              <button type="button" @click="copyCreatedLink">{{ linkCopied ? copy.copied : copy.copy }}</button>
            </div>
          </label>
          <p v-if="submitError" class="share-error share-success-error" role="alert">{{ submitError }}</p>
          <div class="share-success-actions">
            <a :href="createdShare.publicPath" target="_blank" rel="noopener noreferrer">{{ copy.open }}</a>
            <button type="button" :disabled="isDownloadingImage" @click="downloadCreatedImage">
              <IconTablerPhoto />
              {{ isDownloadingImage ? copy.downloadingImage : copy.downloadImage }}
            </button>
            <button type="button" @click="resetCreation">{{ copy.createAnother }}</button>
          </div>
        </section>

        <template v-else>
          <div class="share-turn-toolbar">
            <div>
              <strong>{{ copy.chooseTurns }}</strong>
              <span>{{ copy.selected.replace('{count}', String(selectedTurnIds.size)) }}</span>
            </div>
            <button type="button" @click="toggleAllTurns">
              {{ allTurnsSelected ? copy.clearAll : copy.selectAll }}
            </button>
          </div>

          <div class="share-dialog-columns">
            <section class="share-turn-list" :aria-label="copy.chooseTurns">
              <p v-if="turns.length === 0" class="share-empty">{{ copy.noTurns }}</p>
              <label
                v-for="(turn, index) in turns"
                v-else
                :key="turn.id"
                class="share-turn-option"
                :data-selected="selectedTurnIds.has(turn.id)"
              >
                <input type="checkbox" :checked="selectedTurnIds.has(turn.id)" @change="toggleTurn(turn.id)" />
                <span class="share-turn-check" aria-hidden="true"><IconTablerCheck /></span>
                <span class="share-turn-copy">
                  <span class="share-turn-meta">
                    <strong>{{ copy.turn.replace('{index}', String(index + 1)) }}</strong>
                    <small v-if="turn.hasToolDetails">{{ copy.hasTools }}</small>
                    <small v-if="turn.imageCount > 0">{{ copy.images.replace('{count}', String(turn.imageCount)) }}</small>
                  </span>
                  <span v-if="turn.userPreview" class="share-turn-user">{{ turn.userPreview }}</span>
                  <span v-if="turn.assistantPreview" class="share-turn-assistant">{{ turn.assistantPreview }}</span>
                </span>
              </label>
            </section>

            <form class="share-config" @submit.prevent="submitShare">
              <div class="share-config-heading">
                <strong>{{ copy.settings }}</strong>
                <span>{{ copy.snapshotHint }}</span>
              </div>
              <label class="share-field">
                <span>{{ copy.fieldTitle }}</span>
                <input v-model.trim="shareTitle" type="text" maxlength="160" required />
              </label>
              <label class="share-field">
                <span>{{ copy.expiry }}</span>
                <select v-model="expiryValue">
                  <option value="7">{{ copy.sevenDays }}</option>
                  <option value="30">{{ copy.thirtyDays }}</option>
                  <option value="never">{{ copy.never }}</option>
                </select>
              </label>
              <label class="share-switch">
                <input v-model="redactLocalPaths" type="checkbox" />
                <span><strong>{{ copy.hidePaths }}</strong><small>{{ copy.hidePathsHint }}</small></span>
              </label>
              <label class="share-switch">
                <input v-model="includeToolDetails" type="checkbox" />
                <span><strong>{{ copy.includeTools }}</strong><small>{{ copy.includeToolsHint }}</small></span>
              </label>
              <p v-if="selectedImageCount > 0" class="share-config-note">
                {{ copy.imageOmitted.replace('{count}', String(selectedImageCount)) }}
              </p>
              <p v-if="submitError" class="share-error" role="alert">{{ submitError }}</p>
              <button class="share-submit" type="submit" :disabled="isSubmitting || selectedTurnIds.size === 0 || !shareTitle">
                {{ isSubmitting ? copy.creating : copy.generate }}
              </button>
            </form>
          </div>
        </template>
      </div>

      <section v-else class="share-manage" aria-live="polite">
        <div class="share-manage-intro">
          <div><strong>{{ copy.activeShares }}</strong><span>{{ copy.activeSharesHint }}</span></div>
          <button type="button" :disabled="isLoadingShares" @click="loadShares">{{ isLoadingShares ? copy.loading : copy.refresh }}</button>
        </div>
        <p v-if="sharesError" class="share-error" role="alert">{{ sharesError }}</p>
        <p v-else-if="!isLoadingShares && activeShares.length === 0" class="share-empty">{{ copy.noShares }}</p>
        <ul v-else class="share-manage-list">
          <li v-for="share in activeShares" :key="share.id">
            <div>
              <strong>{{ share.title }}</strong>
              <span>{{ copy.shareMeta.replace('{turns}', String(share.turnCount)).replace('{expiry}', formatExpiry(share.expiresAtIso)) }}</span>
            </div>
            <button v-if="revokeConfirmationId !== share.id" type="button" @click="revokeConfirmationId = share.id">{{ copy.revoke }}</button>
            <button v-else class="share-revoke-confirm" type="button" :disabled="revokingId === share.id" @click="revokeShare(share.id)">
              {{ revokingId === share.id ? copy.revoking : copy.confirmRevoke }}
            </button>
          </li>
        </ul>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { createConversationShare, fetchConversationShares, revokeConversationShare } from '../../api/codexConversationShareClient'
import { downloadConversationSharePng } from '../../api/conversationShareImageClient'
import { buildConversationShareMessages, buildConversationShareTurns } from '../../composables/conversationShareRules'
import { useLocale } from '../../composables/useLocale'
import type { UiConversationShareSnapshot, UiConversationShareSummary, UiMessage } from '../../types/codex'
import IconTablerCheck from '../icons/IconTablerCheck.vue'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'
import IconTablerX from '../icons/IconTablerX.vue'

const props = defineProps<{
  threadId: string
  threadTitle: string
  projectName: string
  messages: UiMessage[]
}>()
const emit = defineEmits<{ close: [] }>()
const { locale } = useLocale()
const titleId = `conversation-share-title-${Math.random().toString(36).slice(2)}`
const activeTab = ref<'create' | 'manage'>('create')
const selectedTurnIds = ref(new Set<string>())
const shareTitle = ref(props.threadTitle.trim() || 'CodyWeb conversation')
const expiryValue = ref<'7' | '30' | 'never'>('30')
const redactLocalPaths = ref(true)
const includeToolDetails = ref(false)
const isSubmitting = ref(false)
const submitError = ref('')
const createdShare = ref<UiConversationShareSummary | null>(null)
const linkCopied = ref(false)
const isDownloadingImage = ref(false)
const activeShares = ref<UiConversationShareSummary[]>([])
const isLoadingShares = ref(false)
const sharesError = ref('')
const revokeConfirmationId = ref('')
const revokingId = ref('')
const closeButton = ref<HTMLButtonElement | null>(null)

const copy = computed(() => locale.value === 'zh-CN' ? {
  eyebrow: '公开对话快照', title: '分享这个 Session', subtitle: '选择要公开的回合。分享页面无需登录，但无法访问原 Session。',
  close: '关闭分享窗口', tabs: '分享视图', createTab: '创建分享', manageTab: '已分享', created: '分享链接已生成', publicHint: '知道链接的人无需登录即可查看这份只读快照。',
  link: '公开链接', copy: '复制', copied: '已复制', open: '打开分享页面', downloadImage: '下载分享长图', downloadingImage: '正在生成长图…', createAnother: '再创建一个', chooseTurns: '选择对话回合', selected: '已选择 {count} 个回合',
  selectAll: '全选', clearAll: '清空', noTurns: '这个 Session 还没有可以分享的完整对话。', turn: '回合 {index}', hasTools: '包含过程', images: '{count} 张图片',
  settings: '分享设置', snapshotHint: '生成后内容不会随原对话变化。', fieldTitle: '分享标题', expiry: '有效期', sevenDays: '7 天', thirtyDays: '30 天', never: '永久',
  hidePaths: '隐藏本地路径', hidePathsHint: '保留文件名，隐藏用户名和绝对目录。', includeTools: '包含工具过程', includeToolsHint: '公开命令、文件变更和工具摘要；敏感值仍会自动隐藏。',
  imageOmitted: '所选回合包含 {count} 张本地图片。当前公开快照不会发布这些图片。', generate: '生成公开链接', creating: '正在生成…',
  activeShares: '当前有效分享', activeSharesHint: '撤销后链接会立即失效，原 Session 不受影响。', refresh: '刷新', loading: '加载中…', noShares: '这个 Session 当前没有有效分享。',
  shareMeta: '{turns} 个回合 · {expiry}', revoke: '撤销', confirmRevoke: '确认撤销', revoking: '正在撤销…', expiredNever: '永久有效', expiredAt: '有效至 {date}',
} : {
  eyebrow: 'Public conversation snapshot', title: 'Share this session', subtitle: 'Choose the turns to publish. The page needs no login and cannot access the source session.',
  close: 'Close share dialog', tabs: 'Share views', createTab: 'Create share', manageTab: 'Shared', created: 'Share link created', publicHint: 'Anyone with the link can view this read-only snapshot without signing in.',
  link: 'Public link', copy: 'Copy', copied: 'Copied', open: 'Open shared page', downloadImage: 'Download share image', downloadingImage: 'Generating image…', createAnother: 'Create another', chooseTurns: 'Choose conversation turns', selected: '{count} turns selected',
  selectAll: 'Select all', clearAll: 'Clear', noTurns: 'This session has no complete conversation turns to share yet.', turn: 'Turn {index}', hasTools: 'Has activity', images: '{count} images',
  settings: 'Share settings', snapshotHint: 'The published content will not change with the source conversation.', fieldTitle: 'Share title', expiry: 'Expires', sevenDays: '7 days', thirtyDays: '30 days', never: 'Never',
  hidePaths: 'Hide local paths', hidePathsHint: 'Keep file names while hiding user names and absolute directories.', includeTools: 'Include tool activity', includeToolsHint: 'Publish command, file-change, and tool summaries. Secrets are still redacted.',
  imageOmitted: 'The selected turns contain {count} local images. This public snapshot will not publish them yet.', generate: 'Generate public link', creating: 'Creating…',
  activeShares: 'Active shares', activeSharesHint: 'Revoking immediately disables the link without changing the source session.', refresh: 'Refresh', loading: 'Loading…', noShares: 'This session has no active shares.',
  shareMeta: '{turns} turns · {expiry}', revoke: 'Revoke', confirmRevoke: 'Confirm revoke', revoking: 'Revoking…', expiredNever: 'Never expires', expiredAt: 'Expires {date}',
})

const turns = computed(() => buildConversationShareTurns(props.messages))
const allTurnsSelected = computed(() => turns.value.length > 0 && turns.value.every((turn) => selectedTurnIds.value.has(turn.id)))
const selectedImageCount = computed(() => turns.value.reduce((total, turn) => total + (selectedTurnIds.value.has(turn.id) ? turn.imageCount : 0), 0))
const createdShareUrl = computed(() => createdShare.value ? `${window.location.origin}${createdShare.value.publicPath}` : '')

function toggleTurn(turnId: string): void {
  const next = new Set(selectedTurnIds.value)
  if (next.has(turnId)) next.delete(turnId)
  else next.add(turnId)
  selectedTurnIds.value = next
}

function toggleAllTurns(): void {
  selectedTurnIds.value = allTurnsSelected.value ? new Set() : new Set(turns.value.map((turn) => turn.id))
}

function closeDialog(): void {
  if (!isSubmitting.value && !revokingId.value) emit('close')
}

async function submitShare(): Promise<void> {
  if (selectedTurnIds.value.size === 0 || !shareTitle.value.trim()) return
  isSubmitting.value = true
  submitError.value = ''
  try {
    const messages = buildConversationShareMessages(turns.value, selectedTurnIds.value, includeToolDetails.value)
    const snapshot: UiConversationShareSnapshot = {
      version: 1,
      locale: locale.value === 'zh-CN' ? 'zh-CN' : 'en',
      title: shareTitle.value.trim(),
      threadTitle: props.threadTitle,
      projectName: props.projectName,
      createdAtIso: new Date().toISOString(),
      messages,
      selectedTurnIds: [...selectedTurnIds.value],
      options: { includeToolDetails: includeToolDetails.value, redactLocalPaths: redactLocalPaths.value },
    }
    createdShare.value = await createConversationShare({
      threadId: props.threadId,
      snapshot,
      expiresInDays: expiryValue.value === 'never' ? null : Number(expiryValue.value),
    })
    await loadShares()
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Failed to create share'
  } finally {
    isSubmitting.value = false
  }
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

async function copyCreatedLink(): Promise<void> {
  await writeClipboard(createdShareUrl.value)
  linkCopied.value = true
  window.setTimeout(() => { linkCopied.value = false }, 1400)
}

async function downloadCreatedImage(): Promise<void> {
  if (!createdShare.value || isDownloadingImage.value) return
  isDownloadingImage.value = true
  submitError.value = ''
  try {
    await downloadConversationSharePng(createdShare.value.publicPath, createdShare.value.title)
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Failed to generate share image'
  } finally {
    isDownloadingImage.value = false
  }
}

function selectInputText(event: FocusEvent): void {
  const target = event.target
  if (target instanceof HTMLInputElement) target.select()
}

function resetCreation(): void {
  createdShare.value = null
  selectedTurnIds.value = new Set()
  submitError.value = ''
}

async function loadShares(): Promise<void> {
  isLoadingShares.value = true
  sharesError.value = ''
  try {
    activeShares.value = await fetchConversationShares(props.threadId)
  } catch (error) {
    sharesError.value = error instanceof Error ? error.message : 'Failed to load shares'
  } finally {
    isLoadingShares.value = false
  }
}

async function revokeShare(id: string): Promise<void> {
  revokingId.value = id
  sharesError.value = ''
  try {
    await revokeConversationShare(id)
    activeShares.value = activeShares.value.filter((share) => share.id !== id)
    revokeConfirmationId.value = ''
  } catch (error) {
    sharesError.value = error instanceof Error ? error.message : 'Failed to revoke share'
  } finally {
    revokingId.value = ''
  }
}

function formatExpiry(value: string | null): string {
  if (!value) return copy.value.expiredNever
  const date = new Intl.DateTimeFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en', { dateStyle: 'medium' }).format(new Date(value))
  return copy.value.expiredAt.replace('{date}', date)
}

onMounted(() => {
  void loadShares()
  void nextTick(() => closeButton.value?.focus())
})
</script>

<style scoped>
.share-dialog-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:24px;background:rgba(4,9,18,.62);backdrop-filter:blur(8px)}
.share-dialog{--color-panel-muted:var(--color-surface-muted);--color-accent-contrast:var(--color-on-accent);display:flex;flex-direction:column;width:min(1040px,100%);max-height:min(860px,calc(100vh - 48px));overflow:hidden;border:1px solid var(--color-border);border-radius:20px;background:var(--color-panel);color:var(--color-text);box-shadow:0 28px 80px rgba(0,0,0,.3)}
.share-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:24px 26px 18px}.share-dialog-header p{margin:0 0 6px;color:var(--color-accent);font-size:.72rem;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.share-dialog-header h2{margin:0;font-size:1.45rem;line-height:1.25}.share-dialog-header span{display:block;margin-top:6px;color:var(--color-text-muted);font-size:.88rem}.share-dialog-close{display:grid;place-items:center;width:44px;height:44px;flex:0 0 auto;border:1px solid var(--color-border);border-radius:12px;background:transparent;color:var(--color-text-muted);cursor:pointer;transition:background .18s ease,color .18s ease}.share-dialog-close:hover{background:var(--color-panel-muted);color:var(--color-text)}.share-dialog-close:focus-visible,.share-dialog-tabs button:focus-visible,.share-turn-toolbar button:focus-visible,.share-submit:focus-visible,.share-field input:focus-visible,.share-field select:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
.share-dialog-tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--color-border)}.share-dialog-tabs button{min-height:44px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--color-text-muted);font-weight:650;cursor:pointer;transition:color .18s ease,border-color .18s ease}.share-dialog-tabs button[data-active=true]{border-color:var(--color-accent);color:var(--color-text)}.share-dialog-tabs span{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-left:7px;padding:0 5px;border-radius:999px;background:var(--color-panel-muted);font-size:.7rem}
.share-dialog-create,.share-manage{min-height:0;overflow:auto}.share-turn-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 26px 12px}.share-turn-toolbar div{display:flex;align-items:baseline;gap:10px}.share-turn-toolbar span{color:var(--color-text-muted);font-size:.8rem}.share-turn-toolbar button,.share-manage-intro button{min-height:40px;padding:0 13px;border:1px solid var(--color-border);border-radius:10px;background:transparent;color:var(--color-text);font-weight:650;cursor:pointer}.share-dialog-columns{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(290px,.75fr);gap:18px;padding:0 26px 26px}.share-turn-list{display:flex;flex-direction:column;gap:8px;min-height:320px;max-height:560px;overflow:auto;padding:2px}.share-turn-option{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr);gap:12px;padding:14px;border:1px solid var(--color-border);border-radius:13px;background:var(--color-background);cursor:pointer;transition:border-color .18s ease,background .18s ease}.share-turn-option:hover{border-color:color-mix(in srgb,var(--color-accent) 50%,var(--color-border))}.share-turn-option[data-selected=true]{border-color:var(--color-accent);background:color-mix(in srgb,var(--color-accent) 8%,var(--color-background))}.share-turn-option>input{position:absolute;opacity:0;pointer-events:none}.share-turn-check{display:grid;place-items:center;width:22px;height:22px;border:1px solid var(--color-border);border-radius:7px;color:transparent}.share-turn-option[data-selected=true] .share-turn-check{border-color:var(--color-accent);background:var(--color-accent);color:var(--color-accent-contrast)}.share-turn-copy{display:flex;min-width:0;flex-direction:column;gap:7px}.share-turn-meta{display:flex;align-items:center;gap:7px}.share-turn-meta strong{font-size:.76rem}.share-turn-meta small{padding:2px 6px;border-radius:999px;background:var(--color-panel-muted);color:var(--color-text-muted);font-size:.65rem}.share-turn-user,.share-turn-assistant{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:.84rem;line-height:1.5}.share-turn-user{font-weight:650}.share-turn-assistant{color:var(--color-text-muted)}
.share-turn-option:has(input:focus-visible){outline:2px solid var(--color-accent);outline-offset:2px}
.share-config{align-self:start;display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid var(--color-border);border-radius:15px;background:var(--color-background)}.share-config-heading{display:flex;flex-direction:column;gap:3px}.share-config-heading span,.share-field>span{color:var(--color-text-muted);font-size:.75rem}.share-field{display:flex;flex-direction:column;gap:6px}.share-field>span{font-weight:650}.share-field input,.share-field select{width:100%;min-height:44px;padding:0 12px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-panel);color:var(--color-text);font:inherit}.share-switch{display:grid;grid-template-columns:20px 1fr;gap:10px;align-items:start;cursor:pointer}.share-switch input{width:18px;height:18px;margin-top:2px;accent-color:var(--color-accent)}.share-switch span{display:flex;flex-direction:column;gap:2px}.share-switch strong{font-size:.82rem}.share-switch small{color:var(--color-text-muted);font-size:.72rem;line-height:1.45}.share-config-note{margin:0;padding:9px 10px;border:1px solid color-mix(in srgb,var(--color-warning) 45%,var(--color-border));border-radius:9px;color:var(--color-text-muted);font-size:.72rem;line-height:1.5}.share-error{margin:0;color:var(--color-danger);font-size:.78rem}.share-submit{min-height:46px;border:0;border-radius:11px;background:var(--color-accent);color:var(--color-accent-contrast);font-weight:750;cursor:pointer;transition:opacity .18s ease}.share-submit:disabled{cursor:not-allowed;opacity:.45}
.share-success{display:grid;grid-template-columns:52px 1fr;gap:16px;width:min(720px,calc(100% - 52px));margin:28px auto;padding:24px;border:1px solid color-mix(in srgb,var(--color-success) 45%,var(--color-border));border-radius:16px;background:color-mix(in srgb,var(--color-success) 7%,var(--color-background))}.share-success-mark{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:var(--color-success);color:#fff;font-size:1.35rem}.share-success p{margin:0;color:var(--color-success);font-size:.72rem;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.share-success h3{margin:4px 0 3px;font-size:1.15rem}.share-success>div>span{color:var(--color-text-muted);font-size:.82rem}.share-success label{grid-column:1/-1;display:flex;flex-direction:column;gap:6px;color:var(--color-text-muted);font-size:.75rem}.share-link-field{display:flex;gap:8px}.share-link-field input{min-width:0;flex:1;height:44px;padding:0 12px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-panel);color:var(--color-text)}.share-link-field button,.share-success-actions button,.share-success-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-panel);color:var(--color-text);font-weight:650;text-decoration:none;cursor:pointer}.share-success .share-success-error{grid-column:1/-1;color:var(--color-danger);font-weight:500;letter-spacing:0;text-transform:none}.share-success-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}.share-success-actions button{gap:7px}.share-success-actions button svg{width:18px;height:18px}.share-success-actions button:disabled{cursor:not-allowed;opacity:.5}.share-success-actions a{border-color:var(--color-accent);background:var(--color-accent);color:var(--color-accent-contrast)}
.share-manage{padding:22px 26px 28px}.share-manage-intro{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.share-manage-intro>div{display:flex;flex-direction:column;gap:3px}.share-manage-intro span{color:var(--color-text-muted);font-size:.78rem}.share-manage-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}.share-manage-list li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 16px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-background)}.share-manage-list li>div{display:flex;min-width:0;flex-direction:column;gap:3px}.share-manage-list strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.share-manage-list span{color:var(--color-text-muted);font-size:.75rem}.share-manage-list button{min-height:40px;padding:0 13px;border:1px solid var(--color-border);border-radius:9px;background:transparent;color:var(--color-text);cursor:pointer}.share-manage-list .share-revoke-confirm{border-color:var(--color-danger);color:var(--color-danger)}.share-empty{margin:20px 0;padding:28px;border:1px dashed var(--color-border);border-radius:12px;color:var(--color-text-muted);text-align:center}
@media(max-width:760px){.share-dialog-backdrop{padding:0}.share-dialog{width:100%;height:100%;max-height:none;border:0;border-radius:0}.share-dialog-header{padding:18px 16px 14px}.share-dialog-tabs{padding:0 16px}.share-turn-toolbar{padding:14px 16px 10px}.share-turn-toolbar div{align-items:flex-start;flex-direction:column;gap:2px}.share-dialog-columns{grid-template-columns:1fr;padding:0 16px 20px}.share-turn-list{max-height:none}.share-config{position:static}.share-success{width:calc(100% - 32px);margin:20px 16px;grid-template-columns:44px 1fr;padding:18px}.share-link-field{flex-direction:column}.share-success-actions{flex-direction:column}.share-manage{padding:18px 16px}.share-manage-list li{align-items:flex-start;flex-direction:column}.share-manage-list button{width:100%}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
