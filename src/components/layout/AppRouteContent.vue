<template>
  <AppSettingsPage v-if="isSettingsRoute" :projects="newThreadProjectOptions" @select-thread="emit('selectThread', $event)" />
  <WorkspaceSkillsPage v-else-if="isSkillsRoute" :cwd="skillsCwd" :project-label="skillsProjectLabel" />
  <template v-else-if="isHomeRoute">
    <div class="content-grid new-thread-grid">
      <div class="new-thread-empty">
        <div class="new-thread-kicker"><span class="new-thread-kicker-signal" aria-hidden="true" />{{ t('app.missionControl') }}</div>
        <p class="new-thread-hero">{{ t('app.hero') }}</p>
        <p class="new-thread-subtitle">{{ t('app.heroSubtitle') }}</p>
        <ComposerDropdown class="new-thread-folder-dropdown" :model-value="newThreadCwd" :options="newThreadFolderOptions"
          :placeholder="t('app.chooseFolder')" :disabled="newThreadFolderOptions.length === 0"
          @update:model-value="emit('selectNewThreadFolder', $event)" />
      </div>
      <ThreadComposer :active-thread-id="composerThreadContextId" :disabled="isSendingMessage" :prompt-insertion="promptInsertion"
        :models="availableModelIds" :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
        :collaboration-modes="collaborationModeOptions" :selected-collaboration-mode="selectedCollaborationModeName"
        :selected-permission-mode="selectedPermissionMode" :selected-submit-mode="selectedSubmitMode"
        :busy-label="homeComposerBusyLabel" :is-turn-in-progress="false"
        :is-interrupting-turn="false" :cwd="newThreadCwd" @submit="emitSubmitMessage"
        @update:selected-model="emit('selectModel', $event)" @update:selected-reasoning-effort="emit('selectReasoningEffort', $event)"
        @update:selected-collaboration-mode="emit('selectCollaborationMode', $event)"
        @update:selected-permission-mode="emit('selectPermissionMode', $event)"
        @update:selected-submit-mode="emit('selectSubmitMode', $event)" />
    </div>
  </template>
  <div v-else class="content-grid" :data-view="isCodeView ? 'code' : 'chat'">
    <WorkspaceCodeWorkbench v-if="isCodeView && selectedThread?.cwd" :cwd="selectedThread.cwd" :thread-id="composerThreadContextId"
      :messages="filteredMessages" @ask-code="emit('askCode', $event)">
      <template #conversation>
        <ThreadConversation :messages="filteredMessages" :is-loading="isLoadingMessages" :cwd="selectedThread?.cwd ?? ''"
          :thread-title="selectedThread?.title ?? ''" :load-error="selectedMessageLoadError" :active-thread-id="composerThreadContextId"
          :scroll-state="selectedThreadScrollState" :live-overlay="liveOverlay" :pending-requests="selectedThreadServerRequests"
          :is-loading-earlier-messages="isLoadingEarlierMessages" :has-more-messages-before="selectedThreadHasMoreMessagesBefore"
          :earlier-message-count="selectedThreadEarlierMessageCount"
          :share-selection-active="conversationShareSelecting"
          :initial-share-selected-message-ids="conversationShareSelectedMessageIds"
          @update-scroll-state="emit('updateScrollState', $event)" @respond-server-request="emit('respondServerRequest', $event)"
          @load-earlier-messages="emit('loadEarlierMessages', $event)"
          @retry-load="emit('retryLoad')" @open-code="emit('openCode', $event)"
          @confirm-share-selection="emit('confirmShareSelection', $event)" @cancel-share-selection="emit('cancelShareSelection')" />
      </template>
    </WorkspaceCodeWorkbench>
    <section v-else-if="isCodeView" class="code-workbench-restoring" aria-live="polite">
      <div class="code-workbench-restoring-nav" aria-hidden="true" />
      <div class="code-workbench-restoring-main">
        <span /><span /><span /><span /><span />
        <p>正在恢复任务与工作区…</p>
      </div>
    </section>
    <div v-else class="content-workbench"><div class="content-thread">
      <ThreadConversation :messages="filteredMessages" :is-loading="isLoadingMessages" :cwd="selectedThread?.cwd ?? ''"
        :thread-title="selectedThread?.title ?? ''"
        :load-error="selectedMessageLoadError" :active-thread-id="composerThreadContextId" :scroll-state="selectedThreadScrollState"
        :live-overlay="liveOverlay" :pending-requests="selectedThreadServerRequests" :share-selection-active="conversationShareSelecting"
        :is-loading-earlier-messages="isLoadingEarlierMessages" :has-more-messages-before="selectedThreadHasMoreMessagesBefore"
        :earlier-message-count="selectedThreadEarlierMessageCount"
        :initial-share-selected-message-ids="conversationShareSelectedMessageIds"
        @update-scroll-state="emit('updateScrollState', $event)" @respond-server-request="emit('respondServerRequest', $event)"
        @load-earlier-messages="emit('loadEarlierMessages', $event)"
        @retry-load="emit('retryLoad')" @open-code="emit('openCode', $event)"
        @confirm-share-selection="emit('confirmShareSelection', $event)" @cancel-share-selection="emit('cancelShareSelection')" />
    </div></div>
    <ThreadComposer :active-thread-id="composerThreadContextId" :prompt-insertion="promptInsertion" :context-insertion="contextInsertion" :disabled="isSendingMessage"
      :models="availableModelIds" :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
      :collaboration-modes="collaborationModeOptions" :selected-collaboration-mode="selectedCollaborationModeName"
      :selected-permission-mode="selectedPermissionMode" :selected-submit-mode="selectedSubmitMode"
      :queued-messages="selectedQueuedMessages"
      :busy-label="threadComposerBusyLabel" :cwd="selectedThread?.cwd ?? ''"
      :is-turn-in-progress="isSelectedThreadInProgress" :is-interrupting-turn="isInterruptingTurn"
      @submit="emitSubmitMessage" @update:selected-model="emit('selectModel', $event)"
      @update:selected-reasoning-effort="emit('selectReasoningEffort', $event)"
      @update:selected-collaboration-mode="emit('selectCollaborationMode', $event)"
      @update:selected-permission-mode="emit('selectPermissionMode', $event)"
      @update:selected-submit-mode="emit('selectSubmitMode', $event)"
      @send-queued-message-now="emit('sendQueuedMessageNow', $event)"
      @delete-queued-message="emit('deleteQueuedMessage', $event)"
      @interrupt="emit('interrupt')" />
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import type { PromptInsertion } from '../../composables/promptLibraryRules'
import { useLocale } from '../../composables/useLocale'
import type { ReasoningEffort, ThreadScrollState, UiCollaborationModeOption, UiComposerContextAttachment, UiComposerPermissionMode, UiComposerSubmitAck, UiComposerSubmitMode, UiComposerSubmitPayload, UiLiveOverlay, UiMessage, UiQueuedMessage, UiServerRequest, UiServerRequestReply, UiThread } from '../../types/codex'
import ComposerDropdown from '../content/ComposerDropdown.vue'
import ThreadComposer from '../content/ThreadComposer.vue'
import ThreadConversation from '../content/ThreadConversation.vue'
import type { NewThreadProjectOption } from '../content/NewThreadSetupModal.vue'

const AppSettingsPage = defineAsyncComponent(() => import('../content/AppSettingsPage.vue'))
const WorkspaceSkillsPage = defineAsyncComponent(() => import('../content/WorkspaceSkillsPage.vue'))
const WorkspaceCodeWorkbench = defineAsyncComponent(() => import('../content/WorkspaceCodeWorkbench.vue'))
defineProps<{
  isSettingsRoute: boolean; isSkillsRoute: boolean; isHomeRoute: boolean
  isCodeView: boolean
  newThreadProjectOptions: NewThreadProjectOption[]; skillsCwd: string; skillsProjectLabel: string
  newThreadCwd: string; newThreadFolderOptions: { value: string; label: string }[]
  composerThreadContextId: string; isSendingMessage: boolean; promptInsertion: PromptInsertion | null; availableModelIds: string[]
  contextInsertion: UiComposerContextAttachment | null
  selectedModelId: string; selectedReasoningEffort: ReasoningEffort | ''; collaborationModeOptions: UiCollaborationModeOption[]
  selectedCollaborationModeName: string; selectedPermissionMode: UiComposerPermissionMode; selectedSubmitMode: UiComposerSubmitMode
  homeComposerBusyLabel: string
  filteredMessages: UiMessage[]; isLoadingMessages: boolean; selectedThread: UiThread | null; selectedMessageLoadError: string
  isLoadingEarlierMessages: boolean; selectedThreadHasMoreMessagesBefore: boolean; selectedThreadEarlierMessageCount: number
  selectedThreadScrollState: ThreadScrollState | null; liveOverlay: UiLiveOverlay | null; selectedThreadServerRequests: UiServerRequest[]
  selectedQueuedMessages: UiQueuedMessage[]
  threadComposerBusyLabel: string; isSelectedThreadInProgress: boolean; isInterruptingTurn: boolean
  conversationShareSelecting: boolean
  conversationShareSelectedMessageIds: string[]
}>()
const emit = defineEmits<{
  selectThread: [string]; respondServerRequest: [UiServerRequestReply]; selectNewThreadFolder: [string]
  submitMessage: [UiComposerSubmitPayload, UiComposerSubmitAck]; selectModel: [string]; selectReasoningEffort: [ReasoningEffort | '']
  selectCollaborationMode: [string]; selectPermissionMode: [UiComposerPermissionMode]
  selectSubmitMode: [UiComposerSubmitMode]
  updateScrollState: [{ threadId: string; state: ThreadScrollState }]; retryLoad: []; interrupt: []
  loadEarlierMessages: [threadId: string]
  sendQueuedMessageNow: [payload: { threadId: string; messageId: string }]
  deleteQueuedMessage: [payload: { threadId: string; messageId: string }]
  openCode: [location: { path?: string; line?: number; mode?: 'file' | 'diff' }]
  askCode: [attachment: UiComposerContextAttachment]
  confirmShareSelection: [messageIds: string[]]
  cancelShareSelection: []
}>()
const { t } = useLocale()

function emitSubmitMessage(payload: UiComposerSubmitPayload, ack: UiComposerSubmitAck): void {
  emit('submitMessage', payload, ack)
}
</script>

<style scoped>
@reference "../../style.css";

/* Keep the conversation viewport bounded so its internal list owns scrolling.
   These rules must live here: App.vue's scoped styles cannot reach through the
   AppRouteContent component boundary. */
.content-grid {
  @apply flex flex-1 min-h-0 flex-col gap-3;
}

.content-workbench {
  @apply flex flex-1 min-h-0 gap-3 px-0;
}

.content-thread {
  @apply flex flex-1 min-h-0 flex-col overflow-hidden;
}

.content-thread :deep(.conversation-root) {
  @apply flex-1 min-h-0;
}

.content-grid > :deep(.thread-composer) {
  @apply shrink-0;
}

.content-grid[data-view='code'] > :deep(.thread-composer) {
  max-width: none;
  padding-inline: 0;
}

.code-workbench-restoring {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: minmax(12rem, 16rem) 1fr;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-background);
}

.code-workbench-restoring-nav {
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-panel) 92%, var(--color-background));
}

.code-workbench-restoring-main {
  display: grid;
  align-content: start;
  gap: 0.75rem;
  padding: 4rem 2rem;
  color: var(--color-text-muted);
}

.code-workbench-restoring-main span {
  width: min(34rem, 72%);
  height: 0.75rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  animation: code-workbench-restore-pulse 1.2s ease-in-out infinite;
}

.code-workbench-restoring-main span:nth-child(2n) { width: min(27rem, 58%); }
.code-workbench-restoring-main p { margin: 0.5rem 0 0; font-size: 0.75rem; }

@keyframes code-workbench-restore-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .code-workbench-restoring-main span { animation: none; } }
@media (max-width: 760px) { .code-workbench-restoring { grid-template-columns: 1fr; }.code-workbench-restoring-nav { display: none; } }
</style>
