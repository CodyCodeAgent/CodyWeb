<template>
  <section class="conversation-root" data-cody-region="conversation">
    <section
      v-if="showBlockingLoading"
      class="conversation-loading-page"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="conversation-loading-page"
    >
      <div class="conversation-loading-panel">
        <div class="conversation-loading-signal" aria-hidden="true">
          <span />
          <span />
        </div>
        <p class="conversation-loading-eyebrow">{{ t('conversation.loading.eyebrow') }}</p>
        <h2>{{ t('conversation.loading.title') }}</h2>
        <p class="conversation-loading-copy">
          {{ t('conversation.loading.body', { thread: threadLoadingLabel }) }}
        </p>
        <ol class="conversation-loading-steps" aria-hidden="true">
          <li data-state="complete">
            <span class="conversation-loading-step-marker" />
            <span>{{ t('conversation.loading.stage.selected') }}</span>
          </li>
          <li data-state="active">
            <span class="conversation-loading-step-marker" />
            <span>{{ t('conversation.loading.stage.syncing') }}</span>
          </li>
          <li data-state="pending">
            <span class="conversation-loading-step-marker" />
            <span>{{ t('conversation.loading.stage.rendering') }}</span>
          </li>
        </ol>
      </div>

      <div class="conversation-loading-skeleton" aria-hidden="true">
        <article v-for="card in 2" :key="card" class="conversation-loading-skeleton-card">
          <span class="conversation-loading-skeleton-meta" />
          <span class="conversation-loading-skeleton-line" data-width="wide" />
          <span class="conversation-loading-skeleton-line" data-width="medium" />
          <span class="conversation-loading-skeleton-line" data-width="short" />
        </article>
      </div>
    </section>

    <article v-else-if="showBlockingLoadError" class="conversation-load-error" role="alert">
      <p class="conversation-load-error-title">Could not load this thread.</p>
      <p class="conversation-load-error-message">{{ loadError }}</p>
      <button type="button" class="conversation-load-error-retry" @click="emit('retryLoad')">Retry</button>
    </article>

    <p
      v-else-if="showEmptyConversation"
      class="conversation-empty"
    >
      No messages in this thread yet.
    </p>

    <ul
      v-else
      ref="conversationListRef"
      class="conversation-list"
      data-testid="conversation-list"
      @scroll="onConversationScroll"
    >
      <li v-if="showRefreshStatus" class="conversation-item conversation-item-refresh">
        <p class="conversation-refresh-status">Refreshing messages...</p>
      </li>

      <li v-if="showInlineLoadError" class="conversation-item conversation-item-refresh">
        <article class="conversation-load-error conversation-load-error-inline" role="alert">
          <p class="conversation-load-error-title">Message refresh failed.</p>
          <p class="conversation-load-error-message">{{ loadError }}</p>
          <button type="button" class="conversation-load-error-retry" @click="emit('retryLoad')">Retry</button>
        </article>
      </li>

      <li
        v-for="card in conversationRequestCards"
        :key="`server-request:${card.request.id}`"
        class="conversation-item conversation-item-request"
      >
        <div class="message-row">
          <div class="message-stack">
            <article class="request-card">
              <p class="request-title">{{ card.summary.title }}</p>
              <p class="request-meta">{{ serverRequestMetaLabel({ request: card.request, idPrefix: 'Request #' }) }}</p>

              <p class="request-subject">{{ card.summary.subject }}</p>
              <div class="request-risk-line">
                <span class="request-risk-badge" :data-level="card.summary.level">
                  {{ card.summary.level }}
                </span>
                <span
                  v-for="label in card.summary.riskLabels"
                  :key="`${card.request.id}:${label}`"
                  class="request-risk-label"
                >
                  {{ label }}
                </span>
              </div>
              <p class="request-reason">{{ card.summary.description }}</p>
              <ul class="request-impact-list">
                <li v-for="impact in card.summary.impacts" :key="`${card.request.id}:${impact}`">
                  {{ impact }}
                </li>
              </ul>
              <div class="request-scope-line" aria-label="Approval scopes">
                <span
                  v-for="scope in approvalScopeOptions"
                  :key="`${card.request.id}:${scope.scope}`"
                  class="request-scope"
                  :data-enabled="scope.enabled"
                  :title="scope.description"
                >
                  {{ scope.label }}
                </span>
              </div>
              <p class="request-recommendation">{{ card.summary.recommendation }}</p>

              <section v-if="isServerApprovalRequestKind(card.kind)" class="request-actions">
                <button
                  v-for="scope in approvalScopeOptions"
                  :key="`${card.request.id}:${serverRequestActionKeyPrefix(card.kind)}:${scope.scope}`"
                  type="button"
                  class="request-button"
                  :class="{ 'request-button-primary': scope.scope === 'single', 'request-button-danger': scope.scope === 'permanent' }"
                  @click="onRespondApprovalScope(card.request.id, scope.scope)"
                >
                  {{ scope.label }}
                </button>
                <button type="button" class="request-button" @click="onRespondApproval(card.request.id, 'decline')">Decline</button>
                <button type="button" class="request-button" @click="onRespondApproval(card.request.id, 'cancel')">Cancel</button>
              </section>

              <section v-else-if="card.kind === 'tool_user_input'" class="request-user-input">
                <div
                  v-for="question in readToolQuestions(card.request)"
                  :key="`${card.request.id}:${question.id}`"
                  class="request-question"
                >
                  <p class="request-question-title">{{ toolQuestionTitle(question) }}</p>
                  <p v-if="shouldShowToolQuestionText(question)" class="request-question-text">{{ question.question }}</p>
                  <select
                    class="request-select"
                    :value="readQuestionAnswer(card.request.id, question.id, question.options[0] || '')"
                    @change="onQuestionAnswerChange(card.request.id, question.id, $event)"
                  >
                    <option v-for="option in question.options" :key="`${card.request.id}:${question.id}:${option}`" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-if="question.isOther"
                    class="request-input"
                    type="text"
                    :value="readQuestionOtherAnswer(card.request.id, question.id)"
                    placeholder="Other answer"
                    @input="onQuestionOtherAnswerInput(card.request.id, question.id, $event)"
                  />
                </div>

                <button type="button" class="request-button request-button-primary" @click="onRespondToolRequestUserInput(card.request)">
                  Submit Answers
                </button>
              </section>

              <section v-else-if="card.kind === 'tool_call'" class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondToolCallFailure(card.request.id)">Fail Tool Call</button>
                <button type="button" class="request-button" @click="onRespondToolCallSuccess(card.request.id)">Success (Empty)</button>
              </section>

              <section v-else class="request-actions">
                <button type="button" class="request-button request-button-primary" @click="onRespondEmptyResult(card.request.id)">Return Empty Result</button>
                <button type="button" class="request-button" @click="onRejectUnknownRequest(card.request.id)">Reject Request</button>
              </section>
            </article>
          </div>
        </div>
      </li>

      <li
        v-if="hiddenMessagesCount > 0"
        class="conversation-item conversation-item-history"
      >
        <button
          data-testid="conversation-history-button"
          class="conversation-history-button"
          type="button"
          @click="onLoadEarlierMessages"
        >
          {{ historyButtonLabel }}
          <span>{{ hiddenMessagesCount }} hidden</span>
        </button>
        <p class="conversation-history-window">{{ visibleMessageWindowLabel }}</p>
      </li>

      <template v-for="(row, renderedRowIndex) in visibleRows" :key="row.id">
        <li
          v-if="row.kind === 'turn'"
          class="conversation-item conversation-item-terminal"
          :data-turn-status="row.status"
        >
          <div class="message-row"><div class="message-stack">
            <div v-if="row.status === 'completed'" class="system-event-divider turn-receipt" data-testid="turn-receipt" role="status">
              <span class="system-event-divider-heading">
                <span class="system-event-divider-line" aria-hidden="true" />
                <strong>{{ turnEntryHeadline(row.durationMs) }}</strong>
                <span class="system-event-divider-line" aria-hidden="true" />
              </span>
            </div>
            <div v-else class="system-event-divider turn-terminal-state" role="status">
              <span class="system-event-divider-heading">
                <span class="system-event-divider-line" aria-hidden="true" />
                <strong>{{ row.status === 'failed' ? (row.error || '本次回复失败') : '本次回复已停止' }}</strong>
                <span class="system-event-divider-line" aria-hidden="true" />
              </span>
            </div>
          </div></div>
        </li>
        <template v-else v-for="message in [row.message]" :key="message.id">
        <li
          v-if="shouldRenderConversationMessage(message)"
          class="conversation-item"
          data-testid="conversation-message"
          :data-role="message.role"
          :data-message-type="message.messageType || ''"
          :data-message-id="message.id"
          :data-share-selectable="shareSelectionActive && isShareSelectableMessage(message) ? 'true' : undefined"
          :data-share-selected="selectedShareMessageIds.has(message.id) ? 'true' : undefined"
        >
        <button
          v-if="shareSelectionActive && isShareSelectableMessage(message)"
          class="conversation-share-checkbox"
          type="button"
          role="checkbox"
          :aria-checked="selectedShareMessageIds.has(message.id)"
          :aria-label="t('conversation.share.selection.checkbox')"
          @click="toggleShareMessage(message.id)"
        >
          <IconTablerCheck aria-hidden="true" />
        </button>
        <div
          class="message-row"
          :data-role="message.role"
          :data-message-type="message.messageType || ''"
          :data-identity-layout="messageUsesIdentityLane(message) ? 'avatars' : undefined"
        >
          <div
            v-if="messageUsesIdentityLane(message) && message.role !== 'user'"
            class="message-identity-slot"
            data-role="assistant"
            :data-visible="shouldShowMessageIdentity(message, messageRenderIndex(renderedRowIndex))"
          >
            <MessageIdentityAvatar
              v-if="shouldShowMessageIdentity(message, messageRenderIndex(renderedRowIndex))"
              role="assistant"
              :growth="codyGrowth"
              :is-loading="isCodyGrowthLoading"
              :error="codyGrowthError"
            />
          </div>
          <div class="message-stack" :data-role="message.role">
            <article
              class="message-body"
              data-cody-component="message"
              :data-role="message.role"
              :data-has-tool="message.tool ? 'true' : undefined"
            >
              <ul
                v-if="message.skills && message.skills.length > 0"
                class="message-skill-list"
                :data-role="message.role"
              >
                <li v-for="skill in message.skills" :key="`${skill.name}:${skill.path}`" class="message-skill-item">
                  ${{ skill.displayName || skill.name }}
                </li>
              </ul>

              <ul
                v-if="message.images && message.images.length > 0"
                class="message-image-list"
                :data-role="message.role"
              >
                <li v-for="imageUrl in message.images" :key="imageUrl" class="message-image-item">
                  <button class="message-image-button" type="button" @click="openImageModal(imageUrl)">
                    <img class="message-image-preview" :src="imageUrl" alt="Message image preview" loading="lazy" />
                  </button>
                </li>
              </ul>

              <div
                v-if="message.tool?.kind === 'context'"
                class="system-event-divider context-compaction-divider"
                data-testid="context-compaction-divider"
                role="status"
              >
                <span class="system-event-divider-heading">
                  <span class="system-event-divider-line" aria-hidden="true" />
                  <strong>{{ t('conversation.contextCompacted') }}</strong>
                  <span class="system-event-divider-line" aria-hidden="true" />
                </span>
                <small>{{ t('conversation.contextCompactedHint') }}</small>
              </div>

              <FileChangeTimelineGroup
                v-else-if="isFileChangeGroupHead(message)"
                :group="fileChangeGroupFor(message)"
                @open-changes="emit('openCode', { mode: 'diff' })"
              />

              <details
                v-else-if="message.tool"
                class="tool-timeline-card"
                :data-kind="message.tool.kind"
                :data-tone="toolStatusTone(message.tool.status)"
                :open="isToolTimelineOpen(message)"
                @toggle="onToolTimelineToggle(message.id, $event)"
              >
                <summary class="tool-timeline-summary-row">
                  <span class="tool-timeline-chevron" aria-hidden="true">›</span>
                  <span class="tool-timeline-summary-copy">
                    <span class="tool-timeline-header">
                      <span class="tool-timeline-title">{{ message.tool.title }}</span>
                      <span class="tool-timeline-status">{{ formatToolStatus(message.tool.status) }}</span>
                    </span>
                    <span class="tool-timeline-summary">{{ message.tool.summary }}</span>
                  </span>
                </summary>
                <div v-if="shouldMountToolTimelineBody(message)" class="tool-timeline-body">
                  <ul v-if="message.tool.details.length > 0" class="tool-timeline-detail-list">
                    <li v-for="detail in message.tool.details" :key="detail" class="tool-timeline-detail">
                      {{ detail }}
                    </li>
                  </ul>
                  <section v-if="message.tool.output" class="tool-timeline-output">
                    <div class="tool-timeline-output-header">
                      <p class="tool-timeline-output-label">{{ message.tool.outputLabel || 'Output' }}</p>
                      <button
                        v-if="isToolOutputPreviewable(message)"
                        class="tool-timeline-output-toggle"
                        type="button"
                        @click="toggleToolOutput(message.id)"
                      >
                        {{ toolOutputButtonLabel(message.id) }}
                      </button>
                    </div>
                    <pre class="tool-timeline-output-block"><code>{{ renderedToolOutput(message) }}</code></pre>
                  </section>
                </div>
              </details>

              <article
                v-if="message.text.length > 0"
                class="message-card"
                :data-role="message.role"
                :data-message-type="message.messageType || ''"
              >
                <div
                  v-if="message.messageType === 'worked'"
                  class="system-event-divider turn-receipt"
                  data-testid="turn-receipt"
                  role="status"
                >
                  <span class="system-event-divider-heading">
                    <span class="system-event-divider-line" aria-hidden="true" />
                    <strong>{{ turnReceiptHeadline(message) }}</strong>
                    <span class="system-event-divider-line" aria-hidden="true" />
                  </span>
                </div>
                <div v-else-if="message.messageType === 'plan' || message.messageType === 'plan.live'" class="plan-message">
                  <p class="plan-message-title">Plan</p>
                  <MessageMarkdown :text="message.text" :cwd="cwd" @open-file="emit('openCode', $event)" />
                </div>
                <template v-else>
                  <p v-if="message.outbox" class="message-outbox-status" :data-status="message.outbox.status">
                    {{ outboxStatusLabel(message) }}
                  </p>
                  <MessageMarkdown :text="message.text" :cwd="cwd" @open-file="emit('openCode', $event)" />
                  <p v-if="message.outbox?.lastError" class="message-outbox-error">
                    {{ message.outbox.lastError }}
                  </p>
                </template>
              </article>

              <button
                v-if="shouldShowCopyButton(message, messageRenderIndex(renderedRowIndex))"
                data-testid="conversation-copy-button"
                class="message-copy-button"
                type="button"
                :aria-label="copyButtonAriaLabel(message.id)"
                :title="copyButtonTitle(message.id)"
                :data-copied="copiedMessageId === message.id"
                @click="copyMessage(message, messageRenderIndex(renderedRowIndex))"
              >
                <IconTablerCopy class="message-copy-icon" />
              </button>
            </article>
          </div>
          <div
            v-if="messageUsesIdentityLane(message) && message.role === 'user'"
            class="message-identity-slot"
            data-role="user"
            :data-visible="shouldShowMessageIdentity(message, messageRenderIndex(renderedRowIndex))"
          >
            <MessageIdentityAvatar
              v-if="shouldShowMessageIdentity(message, messageRenderIndex(renderedRowIndex))"
              role="user"
              :growth="codyGrowth"
              :is-loading="isCodyGrowthLoading"
              :error="codyGrowthError"
            />
          </div>
        </div>
        </li>
        </template>
      </template>
      <li v-if="liveOverlay" class="conversation-item conversation-item-overlay">
        <div class="message-row">
          <div class="message-stack">
            <article class="live-overlay-inline" aria-live="polite">
              <button
                data-testid="conversation-live-overlay-toggle"
                class="live-overlay-toggle"
                type="button"
                :aria-expanded="isLiveOverlayExpanded"
                :disabled="!hasLiveOverlayDetails"
                @click="toggleLiveOverlay"
              >
                <IconTablerChevronRight class="live-overlay-chevron" :data-expanded="isLiveOverlayExpanded" />
                <span class="live-overlay-label">{{ liveOverlay.activityLabel }}</span>
                <span v-if="hasLiveOverlayDetails" class="live-overlay-hint">
                  {{ liveOverlayDetailsLabel }}
                </span>
              </button>

              <div v-if="isLiveOverlayExpanded && hasLiveOverlayDetails" class="live-overlay-details" data-testid="conversation-live-overlay-details">
                <ul v-if="liveOverlay.activityDetails.length > 0" class="live-overlay-detail-list">
                  <li v-for="detail in liveOverlay.activityDetails" :key="detail" class="live-overlay-detail-item">
                    {{ detail }}
                  </li>
                </ul>
                <p
                  v-if="liveOverlay.reasoningText"
                  class="live-overlay-reasoning"
                  data-testid="conversation-live-overlay-reasoning"
                >
                  {{ liveOverlay.reasoningText }}
                </p>
              </div>
              <p v-if="liveOverlay.errorText" class="live-overlay-error">{{ liveOverlay.errorText }}</p>
            </article>
          </div>
        </div>
      </li>
      <li ref="bottomAnchorRef" class="conversation-bottom-anchor" />
    </ul>

    <aside
      v-if="shareSelectionActive"
      class="conversation-share-selection-bar"
      role="toolbar"
      :aria-label="t('conversation.share.selection.toolbar')"
    >
      <span class="conversation-share-selection-count">
        {{ t('conversation.share.selection.count', { count: String(selectedShareMessageIds.size) }) }}
      </span>
      <div class="conversation-share-selection-actions">
        <button type="button" @click="emit('cancelShareSelection')">
          {{ t('conversation.share.selection.cancel') }}
        </button>
        <button type="button" @click="toggleAllShareMessages">
          {{ allVisibleShareMessagesSelected ? t('conversation.share.selection.clear') : t('conversation.share.selection.selectAll') }}
        </button>
        <button
          class="conversation-share-selection-next"
          type="button"
          :disabled="selectedShareMessageIds.size === 0"
          @click="confirmShareSelection"
        >
          {{ t('conversation.share.selection.next') }}
        </button>
      </div>
    </aside>

    <button
      v-if="showScrollToBottomButton"
      class="conversation-scroll-bottom"
      type="button"
      aria-label="Scroll to latest message"
      title="Scroll to latest message"
      @click="onScrollToBottomClick"
    >
      <IconTablerChevronDown class="conversation-scroll-bottom-icon" />
    </button>

    <div v-if="modalImageUrl.length > 0" class="image-modal-backdrop" @click="closeImageModal">
      <div class="image-modal-content" @click.stop>
        <button class="image-modal-close" type="button" aria-label="Close image preview" @click="closeImageModal">
          <IconTablerX class="icon-svg" />
        </button>
        <img class="image-modal-image" :src="modalImageUrl" alt="Expanded message image" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  DEFAULT_VISIBLE_MESSAGE_COUNT,
  MESSAGE_HISTORY_PAGE_SIZE,
  buildConversationScrollMetrics,
  buildConversationScrollState,
  formatTurnDuration,
  hiddenMessageCount as coreHiddenMessageCount,
  nextVisibleMessageCount,
  normalizedConversationBottomLockFrames,
  normalizedVisibleMessageCount,
  preservedConversationScrollTop,
  restoredConversationScrollTop,
  shouldPreserveConversationViewport,
  shouldRestoreConversationToBottom,
  visibleMessageStartIndex,
  type ConversationFeedEntry,
  type ConversationScrollState,
} from '@codycodeagent/cody-web-core/conversation'
import type { UiLiveOverlay, UiMessage, UiServerRequest, UiServerRequestReply } from '../../types/codex'
import {
  APPROVAL_SCOPE_OPTIONS,
  buildApprovalDecisionReply,
  buildApprovalScopeReply,
  buildEmptyServerRequestReply,
  buildRejectedServerRequestReply,
  buildServerRequestCards,
  isServerApprovalRequestKind,
  serverRequestActionKeyPrefix,
  serverRequestMetaLabel,
  type ApprovalDecision,
  type ApprovalDecisionScope,
} from '@codycodeagent/cody-web-core/presentation'
import {
  buildCopyTextAt as buildThreadCopyTextAt,
  buildToolCallFailureReply,
  buildToolCallSuccessReply,
  buildToolUserInputReply,
  hasLiveOverlayDetails as hasThreadLiveOverlayDetails,
  historyPageButtonLabel,
  liveOverlayDetailsToggleLabel,
  messageCopyAriaLabel,
  messageCopyTitle,
  readToolQuestionAnswer,
  readToolQuestionOtherAnswer,
  readToolQuestions,
  shouldShowBlockingConversationLoadError,
  shouldShowBlockingConversationLoading,
  shouldShowInlineConversationLoadError,
  shouldShowConversationRefreshStatus,
  shouldShowCopyButton as shouldShowThreadCopyButton,
  shouldShowScrollToBottomButton as shouldShowThreadScrollToBottomButton,
  shouldShowToolQuestionText,
  toolQuestionKey,
  toolQuestionTitle,
  visibleMessageWindowSummary,
} from '../../composables/threadConversationRules'
import {
  buildFileChangeMessageGroups,
  formatToolStatus,
  buildToolOutputPreview,
  fileChangeMessageCount,
  type FileChangeMessageGroup,
  isToolOutputTruncated,
  isToolTimelineExpandedByDefault,
  toolOutputToggleLabel,
  toolStatusTone,
} from '@codycodeagent/cody-web-core/presentation'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerCheck from '../icons/IconTablerCheck.vue'
import IconTablerCopy from '../icons/IconTablerCopy.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import MessageMarkdown from './MessageMarkdown.vue'
import MessageIdentityAvatar from './MessageIdentityAvatar.vue'
import FileChangeTimelineGroup from './FileChangeTimelineGroup.vue'
import { useLocale } from '../../composables/useLocale'
import { useCodyGrowth } from '../../composables/useCodyGrowth'
import { useTheme } from '../../theme/useTheme'

type ConversationDisplayRow =
  | { id: string; kind: 'message'; message: UiMessage }
  | { id: string; kind: 'turn'; status: 'completed' | 'failed' | 'interrupted'; durationMs: number | null; error: string }

function messageRowFromFeedEntry(entry: ConversationFeedEntry): ConversationDisplayRow | null {
  if (entry.kind === 'message') return { id: entry.id, kind: 'message', message: entry.message }
  if (entry.kind === 'timeline') {
    if (entry.entry.kind === 'reasoning') {
      return { id: entry.id, kind: 'message', message: { id: entry.id, turnId: entry.turnId, role: 'system', text: entry.entry.text, messageType: 'reasoning' } }
    }
    return {
      id: entry.id,
      kind: 'message',
      message: { id: entry.id, turnId: entry.turnId, role: 'system', text: '', messageType: `tool.${entry.entry.tool.kind}`, tool: entry.entry.tool },
    }
  }
  if (entry.kind === 'plan') {
    return { id: entry.id, kind: 'message', message: { id: entry.id, turnId: entry.turnId, role: 'assistant', text: entry.plan.text, messageType: 'plan' } }
  }
  if (entry.kind === 'turn') {
    return { id: entry.id, kind: 'turn', status: entry.status, durationMs: entry.durationMs, error: entry.error }
  }
  // Approval cards and live activity already have dedicated Core-derived
  // surfaces in this product.  Do not append them a second time to the feed.
  return null
}

const props = defineProps<{
  cwd?: string
  threadTitle?: string
  messages: UiMessage[]
  feed?: ConversationFeedEntry[]
  pendingRequests: UiServerRequest[]
  liveOverlay: UiLiveOverlay | null
  isLoading: boolean
  loadError: string
  activeThreadId: string
  scrollState: ConversationScrollState | null
  shareSelectionActive?: boolean
  initialShareSelectedMessageIds?: string[]
}>()

const emit = defineEmits<{
  updateScrollState: [payload: { threadId: string; state: ConversationScrollState }]
  respondServerRequest: [payload: UiServerRequestReply]
  retryLoad: []
  openCode: [location: { path?: string; line?: number; mode?: 'file' | 'diff' }]
  confirmShareSelection: [messageIds: string[]]
  cancelShareSelection: []
}>()
const approvalScopeOptions = APPROVAL_SCOPE_OPTIONS
const { t } = useLocale()
const { activeSkin } = useTheme()
const identityAvatarsEnabled = computed(() => activeSkin.value.recipes.identity === 'avatars')
const growthCwd = computed(() => props.cwd ?? '')
const {
  snapshot: codyGrowth,
  isLoading: isCodyGrowthLoading,
  error: codyGrowthError,
} = useCodyGrowth({ cwd: growthCwd, enabled: identityAvatarsEnabled })

const conversationListRef = ref<HTMLElement | null>(null)
const bottomAnchorRef = ref<HTMLElement | null>(null)
const modalImageUrl = ref('')
const copiedMessageId = ref('')
const isFollowingBottom = ref(props.scrollState?.isAtBottom !== false)
const isLiveOverlayExpanded = ref((props.liveOverlay?.reasoningText ?? '').trim().length > 0)
const openToolMessageIds = ref<Record<string, boolean>>({})
const expandedToolOutputIds = ref<Record<string, boolean>>({})
const previousToolTimelineDefaults = ref<Record<string, boolean>>({})
const selectedShareMessageIds = ref(new Set<string>(
  props.shareSelectionActive ? (props.initialShareSelectedMessageIds ?? []) : [],
))
const toolQuestionAnswers = ref<Record<string, string>>({})
const toolQuestionOtherAnswers = ref<Record<string, string>>({})
const BOTTOM_THRESHOLD_PX = 16
const HISTORY_TOP_THRESHOLD_PX = 12

let scrollRestoreFrame = 0
let bottomLockFrame = 0
let bottomLockFramesLeft = 0
let copiedMessageTimer: number | null = null
let hasAppliedInitialScroll = false
let pendingEarlierScrollAnchor: {
  messageId: string
  viewportOffset: number
  scrollHeight: number
  hiddenMessageCount: number
} | null = null
let isRestoringEarlierMessages = false
const trackedPendingImages = new WeakSet<HTMLImageElement>()
const requestedVisibleMessageCount = ref(DEFAULT_VISIBLE_MESSAGE_COUNT)

const hasLiveOverlayDetails = computed(() => {
  return hasThreadLiveOverlayDetails(props.liveOverlay)
})
const liveOverlayDetailsLabel = computed(() => liveOverlayDetailsToggleLabel(isLiveOverlayExpanded.value))
const conversationRequestCards = computed(() => buildServerRequestCards(props.pendingRequests))
const displayRows = computed<ConversationDisplayRow[]>(() => {
  if (!props.feed) return props.messages.map((message) => ({ id: message.id, kind: 'message' as const, message }))
  return props.feed.flatMap((entry) => {
    const row = messageRowFromFeedEntry(entry)
    return row ? [row] : []
  })
})
const displayMessages = computed<UiMessage[]>(() => displayRows.value.flatMap((row) => row.kind === 'message' ? [row.message] : []))
const normalizedVisibleMessagesCount = computed(() => normalizedVisibleMessageCount(
  displayRows.value.length,
  requestedVisibleMessageCount.value,
))
const visibleMessagesStartIndex = computed(() => visibleMessageStartIndex(
  displayRows.value.length,
  normalizedVisibleMessagesCount.value,
))
const hiddenMessagesCount = computed(() => coreHiddenMessageCount(
  displayRows.value.length,
  normalizedVisibleMessagesCount.value,
))
const visibleRows = computed(() => displayRows.value.slice(visibleMessagesStartIndex.value))
const visibleMessages = computed(() => visibleRows.value.flatMap((row) => row.kind === 'message' ? [row.message] : []))
const visibleFileChangeGroups = computed(() => buildFileChangeMessageGroups(visibleMessages.value))
const fileChangeGroupsByHeadId = computed<Record<string, FileChangeMessageGroup<UiMessage>>>(() => Object.fromEntries(
  visibleFileChangeGroups.value.map((group) => [group.headId, group]),
))
const groupedFileChangeContinuationIds = computed(() => new Set(
  visibleFileChangeGroups.value.flatMap((group) => group.messageIds.slice(1)),
))
const visibleShareMessages = computed(() => visibleMessages.value.filter(isShareSelectableMessage))
const allVisibleShareMessagesSelected = computed(() => visibleShareMessages.value.length > 0
  && visibleShareMessages.value.every((message) => selectedShareMessageIds.value.has(message.id)))

// A command log remains open while its output is changing. Once it reaches a
// terminal state, close it once so the conversation returns to its compact
// shape. We retain subsequent user toggles in `openToolMessageIds`.
watch(
  () => displayMessages.value.flatMap((message) => message.tool
    ? [{ id: message.id, openByDefault: defaultToolTimelineOpen(message) }]
    : []),
  (tools) => {
    const previous = previousToolTimelineDefaults.value
    const next = Object.fromEntries(tools.map((tool) => [tool.id, tool.openByDefault]))
    const collapsedIds = tools
      .filter((tool) => previous[tool.id] === true && tool.openByDefault === false)
      .map((tool) => tool.id)
    if (collapsedIds.length > 0) {
      openToolMessageIds.value = {
        ...openToolMessageIds.value,
        ...Object.fromEntries(collapsedIds.map((id) => [id, false])),
      }
    }
    previousToolTimelineDefaults.value = next
  },
  { immediate: true, flush: 'sync' },
)

function isShareSelectableMessage(message: UiMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false
  return message.text.trim().length > 0 || (message.images?.length ?? 0) > 0
}

function toggleShareMessage(messageId: string): void {
  const next = new Set(selectedShareMessageIds.value)
  if (next.has(messageId)) next.delete(messageId)
  else next.add(messageId)
  selectedShareMessageIds.value = next
}

function toggleAllShareMessages(): void {
  const visibleIds = visibleShareMessages.value.map((message) => message.id)
  const next = new Set(selectedShareMessageIds.value)
  if (allVisibleShareMessagesSelected.value) visibleIds.forEach((id) => next.delete(id))
  else visibleIds.forEach((id) => next.add(id))
  selectedShareMessageIds.value = next
}

function confirmShareSelection(): void {
  if (selectedShareMessageIds.value.size === 0) return
  emit('confirmShareSelection', [...selectedShareMessageIds.value])
}

watch(() => props.shareSelectionActive, (isActive) => {
  selectedShareMessageIds.value = new Set(isActive ? (props.initialShareSelectedMessageIds ?? []) : [])
})

function isIdentityMessage(message: UiMessage): boolean {
  return (message.role === 'assistant' || message.role === 'user')
    && (message.text.trim().length > 0 || (message.images?.length ?? 0) > 0)
}

function messageUsesIdentityLane(message: UiMessage): boolean {
  if (!identityAvatarsEnabled.value) return false
  if (message.role === 'user') return isIdentityMessage(message)
  if (message.role === 'assistant') return isIdentityMessage(message) || Boolean(message.tool)
  return message.role === 'system' && Boolean(message.tool)
}

function isFileChangeGroupHead(message: UiMessage): boolean {
  return fileChangeGroupsByHeadId.value[message.id] !== undefined
}

function fileChangeGroupFor(message: UiMessage): FileChangeMessageGroup<UiMessage> {
  return fileChangeGroupsByHeadId.value[message.id] ?? {
    headId: message.id,
    messages: [message],
    messageIds: [message.id],
    fileCount: fileChangeMessageCount(message),
    updateCount: 1,
    status: message.tool?.status ?? 'unknown',
  }
}

function shouldRenderConversationMessage(message: UiMessage): boolean {
  return !groupedFileChangeContinuationIds.value.has(message.id)
}

function shouldShowMessageIdentity(message: UiMessage, renderedIndex: number): boolean {
  if (!identityAvatarsEnabled.value || !isIdentityMessage(message)) return false
  for (let index = renderedIndex - 1; index >= 0; index -= 1) {
    const previous = visibleMessages.value[index]
    if (!previous || !isIdentityMessage(previous)) continue
    return previous.role !== message.role
  }
  return true
}

function outboxStatusLabel(message: UiMessage): string {
  if (message.outbox?.status === 'sending') return t('conversation.outbox.sending')
  if (message.outbox?.status === 'failed') return t('conversation.outbox.failed')
  return t('conversation.outbox.queued')
}
const historyButtonLabel = computed(() => historyPageButtonLabel(hiddenMessagesCount.value, MESSAGE_HISTORY_PAGE_SIZE))
const visibleMessageWindowLabel = computed(() => visibleMessageWindowSummary(
  displayRows.value.length,
  normalizedVisibleMessagesCount.value,
))
const showBlockingLoading = computed(() => shouldShowBlockingConversationLoading({
  isLoading: props.isLoading,
  messageCount: displayRows.value.length,
  pendingRequestCount: props.pendingRequests.length,
  hasLiveOverlay: props.liveOverlay !== null,
}))
const threadLoadingLabel = computed(
  () => props.threadTitle?.trim() || t('conversation.loading.threadFallback'),
)
const showRefreshStatus = computed(() => shouldShowConversationRefreshStatus({
  isLoading: props.isLoading,
  messageCount: displayRows.value.length,
  pendingRequestCount: props.pendingRequests.length,
  hasLiveOverlay: props.liveOverlay !== null,
}))
const showBlockingLoadError = computed(() => shouldShowBlockingConversationLoadError({
  isLoading: props.isLoading,
  loadError: props.loadError,
  messageCount: displayRows.value.length,
  pendingRequestCount: props.pendingRequests.length,
  hasLiveOverlay: props.liveOverlay !== null,
}))
const showInlineLoadError = computed(() => shouldShowInlineConversationLoadError({
  isLoading: props.isLoading,
  loadError: props.loadError,
  messageCount: displayRows.value.length,
  pendingRequestCount: props.pendingRequests.length,
  hasLiveOverlay: props.liveOverlay !== null,
}))
const showEmptyConversation = computed(() =>
  !showBlockingLoadError.value &&
  displayRows.value.length === 0 &&
  props.pendingRequests.length === 0 &&
  props.liveOverlay === null,
)

const showScrollToBottomButton = computed(() => {
  return shouldShowThreadScrollToBottomButton({
    activeThreadId: props.activeThreadId,
    isLoading: props.isLoading,
    messageCount: displayRows.value.length,
    pendingRequestCount: props.pendingRequests.length,
    hasLiveOverlay: props.liveOverlay !== null,
    scrollState: { scrollTop: 0, scrollRatio: 0, isAtBottom: isFollowingBottom.value },
  })
})

function toAbsoluteMessageIndex(renderedMessageIndex: number): number {
  return visibleMessagesStartIndex.value + renderedMessageIndex
}

function messageRenderIndex(renderedRowIndex: number): number {
  return visibleRows.value
    .slice(0, renderedRowIndex)
    .filter((row): row is Extract<ConversationDisplayRow, { kind: 'message' }> => row.kind === 'message')
    .length
}

function shouldShowCopyButton(message: UiMessage, renderedMessageIndex: number): boolean {
  return shouldShowThreadCopyButton(displayMessages.value, message, toAbsoluteMessageIndex(renderedMessageIndex))
}

function buildCopyTextAt(message: UiMessage, renderedMessageIndex: number): string {
  return buildThreadCopyTextAt(displayMessages.value, message, toAbsoluteMessageIndex(renderedMessageIndex))
}

function defaultToolTimelineOpen(message: UiMessage): boolean {
  return message.tool ? isToolTimelineExpandedByDefault(message.tool) : false
}

function isToolTimelineOpen(message: UiMessage): boolean {
  const saved = openToolMessageIds.value[message.id]
  return typeof saved === 'boolean' ? saved : defaultToolTimelineOpen(message)
}

function shouldMountToolTimelineBody(message: UiMessage): boolean {
  return isToolTimelineOpen(message)
}

function isToolOutputPreviewable(message: UiMessage): boolean {
  return message.tool?.output ? isToolOutputTruncated(message.tool.output) : false
}

function isToolOutputExpanded(messageId: string): boolean {
  return expandedToolOutputIds.value[messageId] === true
}

function renderedToolOutput(message: UiMessage): string {
  const output = message.tool?.output ?? ''
  if (!output || isToolOutputExpanded(message.id) || !isToolOutputTruncated(output)) return output
  return buildToolOutputPreview(output)
}

function toolOutputButtonLabel(messageId: string): string {
  return toolOutputToggleLabel(isToolOutputExpanded(messageId))
}

function toggleToolOutput(messageId: string): void {
  expandedToolOutputIds.value = {
    ...expandedToolOutputIds.value,
    [messageId]: !isToolOutputExpanded(messageId),
  }
}

function onToolTimelineToggle(messageId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement)) return
  openToolMessageIds.value = {
    ...openToolMessageIds.value,
    [messageId]: target.open,
  }
}

function isMessageCopied(messageId: string): boolean {
  return copiedMessageId.value === messageId
}

function copyButtonAriaLabel(messageId: string): string {
  return messageCopyAriaLabel(isMessageCopied(messageId))
}

function copyButtonTitle(messageId: string): string {
  return messageCopyTitle(isMessageCopied(messageId))
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

async function copyMessage(message: UiMessage, renderedMessageIndex: number): Promise<void> {
  const text = buildCopyTextAt(message, renderedMessageIndex)
  if (text.length === 0) return

  await writeClipboardText(text)
  copiedMessageId.value = message.id

  if (copiedMessageTimer !== null) {
    window.clearTimeout(copiedMessageTimer)
  }
  copiedMessageTimer = window.setTimeout(() => {
    if (copiedMessageId.value === message.id) {
      copiedMessageId.value = ''
    }
    copiedMessageTimer = null
  }, 1400)
}

function toggleLiveOverlay(): void {
  if (!hasLiveOverlayDetails.value) return
  isLiveOverlayExpanded.value = !isLiveOverlayExpanded.value
}

function readQuestionAnswer(requestId: number, questionId: string, fallback: string): string {
  return readToolQuestionAnswer(toolQuestionAnswers.value, requestId, questionId, fallback)
}

function readQuestionOtherAnswer(requestId: number, questionId: string): string {
  return readToolQuestionOtherAnswer(toolQuestionOtherAnswers.value, requestId, questionId)
}

function onQuestionAnswerChange(requestId: number, questionId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const key = toolQuestionKey(requestId, questionId)
  toolQuestionAnswers.value = {
    ...toolQuestionAnswers.value,
    [key]: target.value,
  }
}

function onQuestionOtherAnswerInput(requestId: number, questionId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const key = toolQuestionKey(requestId, questionId)
  toolQuestionOtherAnswers.value = {
    ...toolQuestionOtherAnswers.value,
    [key]: target.value,
  }
}

function onRespondApproval(requestId: number, decision: ApprovalDecision): void {
  emit('respondServerRequest', buildApprovalDecisionReply(requestId, decision))
}

function onRespondApprovalScope(requestId: number, scope: ApprovalDecisionScope): void {
  emit('respondServerRequest', buildApprovalScopeReply(requestId, scope))
}

function onRespondToolRequestUserInput(request: UiServerRequest): void {
  emit('respondServerRequest', buildToolUserInputReply({
    request,
    answersByKey: toolQuestionAnswers.value,
    otherAnswersByKey: toolQuestionOtherAnswers.value,
  }))
}

function onRespondToolCallFailure(requestId: number): void {
  emit('respondServerRequest', buildToolCallFailureReply(requestId))
}

function onRespondToolCallSuccess(requestId: number): void {
  emit('respondServerRequest', buildToolCallSuccessReply(requestId))
}

function onRespondEmptyResult(requestId: number): void {
  emit('respondServerRequest', buildEmptyServerRequestReply(requestId))
}

function onRejectUnknownRequest(requestId: number): void {
  emit('respondServerRequest', buildRejectedServerRequestReply(
    requestId,
    'Rejected from CodyWeb UI.',
  ))
}

function scrollToBottom(): void {
  const container = conversationListRef.value
  const anchor = bottomAnchorRef.value
  if (!container || !anchor) return
  container.scrollTop = container.scrollHeight
  anchor.scrollIntoView({ block: 'end' })
}

function onScrollToBottomClick(): void {
  isFollowingBottom.value = true
  enforceBottomState()
  scheduleBottomLock(3)
}

async function revealEarlierMessages(): Promise<void> {
  if (!props.activeThreadId || hiddenMessagesCount.value <= 0 || isRestoringEarlierMessages) return
  const container = conversationListRef.value
  if (!container) return
  const containerRect = container.getBoundingClientRect()
  const visibleAnchor = [...container.querySelectorAll<HTMLElement>('[data-message-id]')]
    .find((element) => {
      const rect = element.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > containerRect.top && rect.top < containerRect.bottom
    })
  pendingEarlierScrollAnchor = {
    messageId: visibleAnchor?.dataset.messageId ?? '',
    viewportOffset: visibleAnchor
      ? visibleAnchor.getBoundingClientRect().top - containerRect.top
      : 0,
    scrollHeight: container.scrollHeight,
    hiddenMessageCount: hiddenMessagesCount.value,
  }
  isRestoringEarlierMessages = true
  isFollowingBottom.value = false
  requestedVisibleMessageCount.value = nextVisibleMessageCount(
    displayRows.value.length,
    normalizedVisibleMessagesCount.value,
    MESSAGE_HISTORY_PAGE_SIZE,
  )
}

function onLoadEarlierMessages(): void {
  void revealEarlierMessages()
}

function emitScrollState(container: HTMLElement): void {
  if (!props.activeThreadId) return
  const state = buildConversationScrollState({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    bottomThresholdPx: BOTTOM_THRESHOLD_PX,
  })
  emit('updateScrollState', {
    threadId: props.activeThreadId,
    state,
  })
}

function applySavedScrollState(): void {
  const container = conversationListRef.value
  if (!container) return

  const savedState = props.scrollState
  if (!savedState || shouldRestoreConversationToBottom(savedState)) {
    isFollowingBottom.value = true
    enforceBottomState()
    return
  }
  isFollowingBottom.value = false

  const metrics = buildConversationScrollMetrics({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    bottomThresholdPx: BOTTOM_THRESHOLD_PX,
  })
  container.scrollTop = shouldPreserveConversationViewport(savedState)
    ? preservedConversationScrollTop(savedState, metrics.maxScrollTop)
    : restoredConversationScrollTop(savedState, metrics.maxScrollTop)
  emitScrollState(container)
}

function enforceBottomState(): void {
  const container = conversationListRef.value
  if (!container) return
  scrollToBottom()
  emitScrollState(container)
}

function shouldLockToBottom(): boolean {
  return isFollowingBottom.value && !isRestoringEarlierMessages
}

function runBottomLockFrame(): void {
  if (!shouldLockToBottom()) {
    bottomLockFramesLeft = 0
    bottomLockFrame = 0
    return
  }

  enforceBottomState()
  bottomLockFramesLeft -= 1
  if (bottomLockFramesLeft <= 0) {
    bottomLockFrame = 0
    return
  }
  bottomLockFrame = requestAnimationFrame(runBottomLockFrame)
}

function scheduleBottomLock(frames = 6): void {
  if (!shouldLockToBottom()) return
  if (bottomLockFrame) {
    cancelAnimationFrame(bottomLockFrame)
    bottomLockFrame = 0
  }
  bottomLockFramesLeft = normalizedConversationBottomLockFrames(frames)
  bottomLockFrame = requestAnimationFrame(runBottomLockFrame)
}

function onPendingImageSettled(): void {
  scheduleBottomLock(3)
}

function bindPendingImageHandlers(): void {
  if (!shouldLockToBottom()) return
  const container = conversationListRef.value
  if (!container) return

  const images = container.querySelectorAll<HTMLImageElement>('img.message-image-preview')
  for (const image of images) {
    if (image.complete || trackedPendingImages.has(image)) continue
    trackedPendingImages.add(image)
    image.addEventListener('load', onPendingImageSettled, { once: true })
    image.addEventListener('error', onPendingImageSettled, { once: true })
  }
}

async function scheduleScrollRestore(): Promise<void> {
  await nextTick()
  if (scrollRestoreFrame) {
    cancelAnimationFrame(scrollRestoreFrame)
  }
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = 0
    if (!hasAppliedInitialScroll) {
      applySavedScrollState()
      hasAppliedInitialScroll = true
    } else if (isFollowingBottom.value) {
      enforceBottomState()
    } else {
      const container = conversationListRef.value
      if (container) emitScrollState(container)
    }
    bindPendingImageHandlers()
    scheduleBottomLock()
  })
}

watch(
  displayRows,
  async () => {
    if (props.isLoading) return
    await scheduleScrollRestore()
  },
)

watch(
  hiddenMessagesCount,
  async (nextCount) => {
    const pending = pendingEarlierScrollAnchor
    if (!pending || nextCount >= pending.hiddenMessageCount) return
    pendingEarlierScrollAnchor = null
    await nextTick()
    const container = conversationListRef.value
    if (container) {
      const anchor = [...container.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((element) => element.dataset.messageId === pending.messageId)
      if (anchor && pending.messageId) {
        const containerTop = container.getBoundingClientRect().top
        const nextViewportOffset = anchor.getBoundingClientRect().top - containerTop
        container.scrollTop += nextViewportOffset - pending.viewportOffset
      } else {
        container.scrollTop += container.scrollHeight - pending.scrollHeight
      }
      emitScrollState(container)
    }
    isRestoringEarlierMessages = false
    bindPendingImageHandlers()
  },
)

watch(
  () => props.loadError,
  (loadError) => {
    if (loadError && pendingEarlierScrollAnchor) {
      pendingEarlierScrollAnchor = null
      isRestoringEarlierMessages = false
    }
  },
)

watch(
  () => props.liveOverlay,
  async (overlay) => {
    if (!overlay) return
    if (overlay.reasoningText.trim().length > 0) {
      isLiveOverlayExpanded.value = true
    } else if (!hasLiveOverlayDetails.value) {
      isLiveOverlayExpanded.value = false
    }
    await nextTick()
    if (isFollowingBottom.value) {
      enforceBottomState()
    }
    scheduleBottomLock(8)
  },
  { deep: true },
)

watch(
  () => props.isLoading,
  async (loading) => {
    if (loading) return
    await scheduleScrollRestore()
  },
)

watch(
  () => props.activeThreadId,
  () => {
    modalImageUrl.value = ''
    isLiveOverlayExpanded.value = false
    openToolMessageIds.value = {}
    expandedToolOutputIds.value = {}
    previousToolTimelineDefaults.value = {}
    pendingEarlierScrollAnchor = null
    isRestoringEarlierMessages = false
    requestedVisibleMessageCount.value = DEFAULT_VISIBLE_MESSAGE_COUNT
    hasAppliedInitialScroll = false
    isFollowingBottom.value = props.scrollState?.isAtBottom !== false
    if (bottomLockFrame) {
      cancelAnimationFrame(bottomLockFrame)
      bottomLockFrame = 0
    }
  },
  { flush: 'post' },
)

function onConversationScroll(): void {
  const container = conversationListRef.value
  if (!container || props.isLoading) return
  if (
    container.scrollTop <= HISTORY_TOP_THRESHOLD_PX &&
    hiddenMessagesCount.value > 0 &&
    !isRestoringEarlierMessages
  ) {
    void revealEarlierMessages()
  }
  const state = buildConversationScrollState({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    bottomThresholdPx: BOTTOM_THRESHOLD_PX,
  })
  isFollowingBottom.value = state.isAtBottom
  if (!state.isAtBottom && bottomLockFrame) {
    cancelAnimationFrame(bottomLockFrame)
    bottomLockFrame = 0
    bottomLockFramesLeft = 0
  }
  if (props.activeThreadId) emit('updateScrollState', { threadId: props.activeThreadId, state })
}

function openImageModal(imageUrl: string): void {
  modalImageUrl.value = imageUrl
}

function closeImageModal(): void {
  modalImageUrl.value = ''
}

onBeforeUnmount(() => {
  if (scrollRestoreFrame) {
    cancelAnimationFrame(scrollRestoreFrame)
  }
  if (bottomLockFrame) {
    cancelAnimationFrame(bottomLockFrame)
  }
  if (copiedMessageTimer !== null) {
    window.clearTimeout(copiedMessageTimer)
  }
})
function turnReceiptPayload(message: UiMessage): Record<string, unknown> | null {
  if (!message.rawPayload) return null
  if (typeof message.rawPayload === 'object' && !Array.isArray(message.rawPayload)) {
    return message.rawPayload as Record<string, unknown>
  }
  if (typeof message.rawPayload !== 'string') return null
  try {
    const value = JSON.parse(message.rawPayload) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function turnReceiptHeadline(message: UiMessage): string {
  const payload = turnReceiptPayload(message)
  if (typeof payload?.label === 'string') return payload.label
  const [headline] = message.text.split(' · ')
  return headline || message.text
}

function turnEntryHeadline(durationMs: number | null): string {
  return durationMs === null ? 'Answered' : `Worked for ${formatTurnDuration(durationMs)}`
}

</script>

<style scoped>
@reference "../../style.css";

.conversation-root {
  @apply relative h-full min-h-0 p-0 flex flex-col overflow-y-hidden overflow-x-visible bg-transparent border-none rounded-none;
}

.conversation-loading-page {
  @apply relative flex-1 min-h-0 overflow-hidden px-6 py-8 flex flex-col items-center justify-center gap-6;
}

.conversation-loading-panel {
  @apply relative z-10 w-full max-w-2xl rounded-xl border theme-border theme-bg-panel px-6 py-6 text-center shadow-sm;
  background:
    radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 48%),
    var(--color-panel);
}

.conversation-loading-signal {
  @apply relative mx-auto mb-4 h-11 w-11 rounded-full border flex items-center justify-center;
  border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
}

.conversation-loading-signal span:first-child {
  @apply h-3 w-3 rounded-full;
  background: var(--color-accent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--color-accent) 58%, transparent);
}

.conversation-loading-signal span:last-child {
  @apply absolute inset-1 rounded-full border;
  border-color: color-mix(in srgb, var(--color-accent) 52%, transparent);
  animation: conversation-loading-ring 1.4s ease-in-out infinite;
}

.conversation-loading-eyebrow {
  @apply m-0 text-[0.65rem] font-semibold uppercase tracking-[0.16em] theme-muted;
  font-family: var(--font-mono);
}

.conversation-loading-panel h2 {
  @apply m-0 mt-2 text-xl font-semibold theme-text;
}

.conversation-loading-copy {
  @apply mx-auto mb-0 mt-2 max-w-xl text-sm leading-6 theme-muted;
}

.conversation-loading-steps {
  @apply mx-auto mt-5 mb-0 max-w-xl list-none p-0 grid grid-cols-3 gap-2;
}

.conversation-loading-steps li {
  @apply min-w-0 rounded-md border theme-border px-2 py-2 text-left text-[0.68rem] theme-muted flex items-center gap-2;
  background: color-mix(in srgb, var(--color-surface) 68%, transparent);
}

.conversation-loading-steps li[data-state='active'] {
  color: var(--color-text);
  border-color: color-mix(in srgb, var(--color-accent) 36%, var(--color-border));
}

.conversation-loading-step-marker {
  @apply relative h-2.5 w-2.5 shrink-0 rounded-full border;
  border-color: var(--color-border);
}

.conversation-loading-steps li[data-state='complete'] .conversation-loading-step-marker {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.conversation-loading-steps li[data-state='complete'] .conversation-loading-step-marker::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 1px;
  width: 3px;
  height: 5px;
  border: solid var(--color-panel);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.conversation-loading-steps li[data-state='active'] .conversation-loading-step-marker {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 26%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 10%, transparent);
  animation: conversation-loading-pulse 1.4s ease-in-out infinite;
}

.conversation-loading-skeleton {
  @apply w-full max-w-2xl flex flex-col gap-3 opacity-65;
}

.conversation-loading-skeleton-card {
  @apply rounded-xl border theme-border theme-bg-panel px-5 py-4 flex flex-col gap-2.5;
}

.conversation-loading-skeleton-meta,
.conversation-loading-skeleton-line {
  @apply block overflow-hidden rounded;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-elevated) 82%, transparent) 24%,
      color-mix(in srgb, var(--color-accent) 9%, var(--color-surface)) 50%,
      color-mix(in srgb, var(--color-elevated) 82%, transparent) 76%
    );
  background-size: 220% 100%;
  animation: conversation-loading-shimmer 1.45s ease-in-out infinite;
}

.conversation-loading-skeleton-meta {
  @apply h-2.5 w-24 mb-1;
}

.conversation-loading-skeleton-line {
  @apply h-3;
}

.conversation-loading-skeleton-line[data-width='wide'] {
  width: 92%;
}

.conversation-loading-skeleton-line[data-width='medium'] {
  width: 72%;
}

.conversation-loading-skeleton-line[data-width='short'] {
  width: 48%;
}

.conversation-empty {
  @apply m-0 px-6 text-sm theme-muted;
}

.conversation-load-error {
  @apply mx-6 max-w-2xl rounded-lg border theme-border-danger theme-bg-danger-soft px-4 py-3 text-sm theme-text-danger shadow-sm;
  background: color-mix(in srgb, var(--color-danger) 10%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-danger) 36%, var(--color-border));
  color: var(--color-text);
}

.conversation-load-error-inline {
  @apply mx-0 w-full max-w-180;
}

.conversation-load-error-title {
  @apply m-0 font-semibold;
}

.conversation-load-error-message {
  @apply m-0 mt-1 break-words text-xs leading-5 theme-text-danger;
  color: color-mix(in srgb, var(--color-danger) 34%, var(--color-text-muted));
}

.conversation-load-error-retry {
  @apply mt-3 inline-flex h-8 items-center rounded-md border theme-border-danger theme-bg-panel px-3 text-xs font-semibold theme-text-danger transition hover:theme-bg-danger-soft focus:outline-none focus:ring-2 focus:ring-rose-200;
  background: var(--color-surface);
  border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
  color: color-mix(in srgb, var(--color-danger) 34%, var(--color-text));
}

.conversation-load-error-retry:hover {
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
}

@keyframes conversation-loading-ring {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

@keyframes conversation-loading-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

@keyframes conversation-loading-shimmer {
  from { background-position: 180% 0; }
  to { background-position: -40% 0; }
}

@media (max-width: 640px) {
  .conversation-loading-page {
    @apply px-4 py-5 gap-4;
  }

  .conversation-loading-panel {
    @apply px-4 py-5;
  }

  .conversation-loading-steps {
    @apply grid-cols-1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .conversation-loading-signal span:last-child,
  .conversation-loading-steps li[data-state='active'] .conversation-loading-step-marker,
  .conversation-loading-skeleton-meta,
  .conversation-loading-skeleton-line {
    animation: none;
  }
}

.conversation-list {
  @apply h-full min-h-0 list-none m-0 px-6 py-0 overflow-y-auto overflow-x-visible flex flex-col gap-3;
}

.conversation-root:has(.conversation-share-selection-bar) .conversation-list {
  padding-bottom: 6.5rem;
}

.conversation-item {
  @apply m-0 w-full flex;
}

.conversation-item[data-share-selectable='true'] {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr);
  align-items: start;
  column-gap: .75rem;
}

.conversation-item[data-share-selectable='true'] > .message-row {
  min-width: 0;
  margin-inline: auto;
}

.conversation-item[data-share-selected='true'] > .message-row {
  border-radius: calc(var(--radius-md) + 4px);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 72%, transparent);
  outline-offset: 5px;
}

.conversation-share-checkbox {
  @apply mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-xl border transition focus:outline-none;
  border-color: var(--color-border);
  background: color-mix(in srgb, var(--color-panel) 92%, transparent);
  color: transparent;
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  touch-action: manipulation;
}

.conversation-share-checkbox:hover {
  border-color: color-mix(in srgb, var(--color-accent) 62%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel));
}

.conversation-share-checkbox[aria-checked='true'] {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.conversation-share-checkbox:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.conversation-share-checkbox svg {
  width: 1.15rem;
  height: 1.15rem;
}

.conversation-share-selection-bar {
  position: absolute;
  z-index: 30;
  right: clamp(1rem, 4vw, 3rem);
  bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  min-height: 4rem;
  padding: .6rem .7rem .6rem 1rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  border-radius: 1rem;
  background: color-mix(in srgb, var(--color-panel) 94%, transparent);
  color: var(--color-text);
  box-shadow: 0 18px 44px color-mix(in srgb, #000 26%, transparent);
  backdrop-filter: blur(16px);
}

.conversation-share-selection-count {
  min-width: 7rem;
  font-size: .82rem;
  font-weight: 700;
}

.conversation-share-selection-actions {
  display: flex;
  align-items: center;
  gap: .45rem;
}

.conversation-share-selection-actions button {
  min-height: 2.75rem;
  padding: 0 .85rem;
  border: 1px solid var(--color-border);
  border-radius: .7rem;
  background: transparent;
  color: var(--color-text);
  font-weight: 650;
  cursor: pointer;
  touch-action: manipulation;
}

.conversation-share-selection-actions button:hover {
  background: var(--color-surface-muted);
}

.conversation-share-selection-actions button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.conversation-share-selection-actions .conversation-share-selection-next {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.conversation-share-selection-actions button:disabled {
  cursor: not-allowed;
  opacity: .42;
}

@media (max-width: 700px) {
  .conversation-list {
    padding-inline: .75rem;
  }

  .conversation-item[data-share-selectable='true'] {
    column-gap: .5rem;
  }

  .conversation-share-checkbox {
    width: 2.75rem;
  }

  .conversation-share-selection-bar {
    right: .75rem;
    bottom: .75rem;
    left: .75rem;
    align-items: stretch;
    flex-direction: column;
    gap: .45rem;
  }

  .conversation-share-selection-actions {
    display: grid;
    grid-template-columns: 1fr 1fr 1.15fr;
  }
}

.conversation-item-request {
  @apply justify-center;
}

.conversation-item-overlay {
  @apply justify-center;
}

.conversation-item-history {
  @apply flex-col items-center justify-center gap-1;
}

.conversation-item-refresh {
  @apply justify-center;
}

.conversation-refresh-status {
  @apply m-0 rounded-full border theme-border theme-bg-panel px-3 py-1 text-xs font-medium theme-muted shadow-sm;
}

.conversation-history-button {
  @apply mx-auto flex items-center gap-2 rounded-full border theme-border theme-bg-panel px-3 py-1.5 text-xs font-medium theme-muted shadow-sm transition hover:theme-border hover:theme-bg-subtle hover:theme-text focus:outline-none focus:ring-2 focus:ring-slate-300;
}

.conversation-history-button span {
  @apply theme-muted;
}

.conversation-history-window {
  @apply m-0 text-[0.68rem] leading-4 theme-muted;
}

.message-row {
  @apply relative w-full max-w-180 mx-auto flex;
}

.message-row[data-role='user'] {
  @apply justify-end gap-2;
}

.message-row[data-role='assistant'],
.message-row[data-role='system'] {
  @apply justify-start gap-2;
}

.conversation-bottom-anchor {
  @apply h-px;
}

.conversation-scroll-bottom {
  @apply absolute bottom-3 right-8 z-20 flex h-9 w-9 items-center justify-center rounded-full border theme-border theme-bg-panel theme-muted shadow-lg transition hover:theme-border hover:theme-bg-subtle hover:theme-text focus:outline-none focus:ring-2 focus:ring-slate-300;
}

.conversation-scroll-bottom-icon {
  @apply h-5 w-5;
}

.message-stack {
  @apply flex flex-col w-full;
}

.request-card {
  @apply w-full max-w-180 rounded-xl border theme-border-warning theme-bg-warning-soft px-4 py-3 flex flex-col gap-2;
}

.request-title {
  @apply m-0 text-sm leading-5 font-semibold theme-text-warning;
}

.request-meta {
  @apply m-0 text-xs leading-4 theme-text-warning;
}

.request-subject {
  @apply m-0 max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-5 theme-text-warning;
}

.request-risk-line {
  @apply flex flex-wrap items-center gap-1.5;
}

.request-risk-badge {
  @apply rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold uppercase leading-4;
}

.request-risk-badge[data-level='low'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.request-risk-badge[data-level='medium'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.request-risk-badge[data-level='high'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.request-risk-label {
  @apply rounded-full border theme-border-warning theme-bg-panel px-2 py-0.5 text-[0.68rem] leading-4 theme-text-warning;
}

.request-reason {
  @apply m-0 text-sm leading-5 theme-text-warning whitespace-pre-wrap;
}

.request-impact-list {
  @apply m-0 list-disc space-y-1 pl-4 text-xs leading-4 theme-text-warning;
}

.request-scope-line {
  @apply flex flex-wrap gap-1.5;
}

.request-scope {
  @apply rounded-md border theme-border-info theme-bg-info-soft px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-normal theme-text-info;
}

.request-scope[data-enabled='false'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.request-recommendation {
  @apply m-0 rounded-md border theme-border-warning bg-white/70 px-2 py-1.5 text-xs leading-4 theme-text-warning;
}

.request-actions {
  @apply flex flex-wrap gap-2;
}

.request-button {
  @apply rounded-md border theme-border-warning theme-bg-panel px-3 py-1.5 text-xs theme-text-warning hover:theme-bg-warning-soft transition;
}

.request-button-primary {
  @apply theme-border-warning theme-bg-warning theme-on-warning;
}

.request-button-danger {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger hover:theme-bg-danger-soft;
}

.request-user-input {
  @apply flex flex-col gap-3;
}

.request-question {
  @apply flex flex-col gap-1;
}

.request-question-title {
  @apply m-0 text-sm leading-5 font-medium theme-text-warning;
}

.request-question-text {
  @apply m-0 text-xs leading-4 theme-text-warning;
}

.request-select {
  @apply h-8 rounded-md border theme-border-warning theme-bg-panel px-2 text-sm theme-text-warning;
}

.request-input {
  @apply h-8 rounded-md border theme-border-warning theme-bg-panel px-2 text-sm theme-text-warning placeholder:text-amber-500;
}

.live-overlay-inline {
  @apply w-full max-w-180 px-0 py-1 flex flex-col gap-2;
}

.live-overlay-toggle {
  @apply flex w-fit max-w-full items-center gap-1.5 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-left transition hover:theme-border hover:theme-bg-subtle disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent;
}

.live-overlay-chevron {
  @apply h-3.5 w-3.5 shrink-0 theme-muted transition-transform;
}

.live-overlay-chevron[data-expanded='true'] {
  @apply rotate-90;
}

.live-overlay-label {
  @apply min-w-0 truncate text-sm leading-5 font-medium theme-muted;
}

.live-overlay-hint {
  @apply shrink-0 text-xs leading-5 theme-muted;
}

.live-overlay-details {
  @apply ml-6 flex max-w-170 flex-col gap-2 border-l theme-border pl-3;
}

.live-overlay-detail-list {
  @apply m-0 flex list-none flex-col gap-1 p-0;
}

.live-overlay-detail-item {
  @apply m-0 text-sm leading-5 theme-muted;
}

.live-overlay-reasoning {
  @apply m-0 text-sm leading-5 theme-muted whitespace-pre-wrap;
}

.live-overlay-error {
  @apply m-0 text-sm leading-5 text-rose-600 whitespace-pre-wrap;
}

.message-body {
  @apply relative flex flex-col max-w-full;
  width: fit-content;
}

.message-body[data-role='user'] {
  @apply ml-auto items-end;
  align-self: flex-end;
}

.message-body[data-has-tool='true'] {
  width: 100%;
}

.message-image-list {
  @apply list-none m-0 mb-2 p-0 flex flex-wrap gap-2;
}

.message-skill-list {
  @apply list-none m-0 mb-2 p-0 flex flex-wrap gap-2;
}

.message-skill-list[data-role='user'] {
  @apply ml-auto justify-end;
}

.message-skill-item {
  @apply m-0 rounded-md border theme-border theme-bg-control px-2 py-1 font-mono text-xs theme-text;
}

.message-image-list[data-role='user'] {
  @apply ml-auto justify-end;
}

.message-image-item {
  @apply m-0;
}

.message-image-button {
  @apply block rounded-xl overflow-hidden border theme-border theme-bg-panel p-0 transition hover:border-slate-400;
}

.message-image-preview {
  @apply block w-16 h-16 object-cover;
}

.system-event-divider {
  @apply grid w-full max-w-[min(760px,100%)] gap-1.5 py-2 text-center;
}

.system-event-divider-heading {
  @apply grid w-full grid-cols-[minmax(2.5rem,1fr)_auto_minmax(2.5rem,1fr)] items-center gap-4;
}

.system-event-divider-line {
  height: 1px;
  background: color-mix(in srgb, var(--color-success) 62%, var(--color-border));
  opacity: .72;
}

.system-event-divider strong {
  @apply text-[0.7rem] font-semibold uppercase tracking-[0.12em] theme-text-success;
}

.context-compaction-divider small {
  @apply mx-auto max-w-100 text-[0.68rem] leading-4 theme-muted;
}

.tool-timeline-card {
  @apply w-full max-w-[min(760px,100%)] rounded-lg border theme-border theme-bg-subtle px-3 py-2.5 theme-text;
}

.tool-timeline-card summary::-webkit-details-marker {
  display: none;
}

.tool-timeline-card[data-tone='success'] {
  @apply theme-border-success theme-bg-success-soft;
}

.tool-timeline-card[data-tone='danger'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.tool-timeline-card[data-tone='working'] {
  @apply theme-border-info theme-bg-info-soft;
}

.tool-timeline-summary-row {
  @apply grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)] items-start gap-2;
}

.tool-timeline-chevron {
  @apply mt-0.5 select-none text-base leading-4 theme-muted transition-transform;
}

.tool-timeline-card[open] .tool-timeline-chevron {
  transform: rotate(90deg);
}

.tool-timeline-summary-copy {
  @apply min-w-0;
}

.tool-timeline-header {
  @apply flex items-center gap-2;
}

.tool-timeline-title {
  @apply min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-normal theme-muted;
}

.tool-timeline-status {
  @apply shrink-0 rounded-full border theme-border theme-bg-panel px-2 py-0.5 text-[0.68rem] leading-4 font-medium theme-muted;
}

.tool-timeline-card[data-tone='success'] .tool-timeline-status {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.tool-timeline-card[data-tone='danger'] .tool-timeline-status {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.tool-timeline-card[data-tone='working'] .tool-timeline-status {
  @apply theme-border-info theme-bg-info-soft theme-text-info;
}

.tool-timeline-summary {
  @apply mt-1 block max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-5 theme-text;
}

.tool-timeline-body {
  @apply ml-6;
}

.tool-timeline-detail-list {
  @apply mt-2 mb-0 grid list-none gap-1 p-0;
}

.tool-timeline-detail {
  @apply m-0 min-w-0 truncate font-mono text-xs leading-4 theme-muted;
}

.tool-timeline-output {
  @apply mt-2 border-t theme-border pt-2;
}

.tool-timeline-output-header {
  @apply mb-1 flex items-center justify-between gap-3;
}

.tool-timeline-output-label {
  @apply m-0 text-xs font-medium theme-muted;
}

.tool-timeline-output-toggle {
  @apply shrink-0 rounded-md border theme-border theme-bg-panel px-2 py-1 text-xs font-medium theme-muted transition hover:theme-border hover:theme-bg-subtle hover:theme-text focus:outline-none focus:ring-2 focus:ring-slate-300;
}

.tool-timeline-output-block {
  @apply m-0 max-h-80 overflow-auto rounded-md border theme-border theme-bg-panel px-2 py-1.5 text-xs leading-5 theme-text;
}

.tool-timeline-output-block code {
  @apply whitespace-pre font-mono;
}

.message-card {
  @apply max-w-[min(76ch,100%)] px-0 py-0 bg-transparent border-none rounded-none;
}

.message-copy-button {
  @apply mt-1 flex h-7 w-7 items-center justify-center rounded-md border theme-border theme-bg-panel theme-muted opacity-45 shadow-sm transition hover:theme-border hover:theme-bg-subtle hover:theme-text hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-300;
}

.message-body[data-role='user'] .message-copy-button {
  @apply self-start;
}

.message-body[data-role='assistant'] .message-copy-button,
.message-body[data-role='system'] .message-copy-button {
  @apply self-end;
}

.message-copy-button[data-copied='true'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success opacity-100;
}

.message-copy-icon {
  @apply h-4 w-4;
}

.message-stack[data-role='user'] {
  @apply items-end;
}

.message-stack[data-role='assistant'],
.message-stack[data-role='system'] {
  @apply items-start;
}

.message-card[data-role='user'] {
  @apply max-w-[min(560px,100%)];
  width: fit-content;
  margin-left: auto;
  align-self: flex-end;
}

.message-card[data-role='assistant'],
.message-card[data-role='system'] {
  @apply px-0 py-0 bg-transparent border-none rounded-none;
}

.message-outbox-status {
  @apply mb-1 mt-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold;
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  color: var(--color-text-muted);
}

.message-outbox-status[data-status='sending'] {
  color: var(--color-accent);
}

.message-outbox-status[data-status='failed'] {
  background: color-mix(in srgb, var(--color-warning) 10%, var(--color-panel));
  border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border));
  color: var(--color-warning);
}

.message-outbox-error {
  @apply mt-2 max-w-full text-xs;
  color: var(--color-warning);
}

.plan-message {
  @apply border-l-2 theme-border pl-3;
}

.plan-message-title {
  @apply mb-2 mt-0 text-xs font-semibold uppercase tracking-normal theme-muted;
}

.conversation-item[data-message-type='worked'] .message-stack,
.conversation-item[data-message-type='worked'] .message-body,
.conversation-item[data-message-type='worked'] .message-card {
  @apply w-full max-w-full;
}

.worked-separator {
  @apply w-full flex items-center gap-4;
}

.worked-separator-line {
  @apply h-px bg-zinc-300/80 flex-1;
}

.worked-separator-text {
  @apply m-0 text-sm leading-relaxed font-normal theme-text;
}

.turn-receipt {
  margin: .35rem auto .2rem;
}

@media (max-width: 720px) {
  .system-event-divider-heading {
    @apply grid-cols-[minmax(1.5rem,1fr)_auto_minmax(1.5rem,1fr)] gap-2.5;
  }
}

.image-modal-backdrop {
  @apply fixed inset-0 z-50 bg-black/40 p-6 flex items-center justify-center;
}

.image-modal-content {
  @apply relative max-w-[min(92vw,1100px)] max-h-[92vh];
}

.image-modal-close {
  @apply absolute top-2 right-2 z-10 w-10 h-10 rounded-full bg-white/90 theme-text border theme-border flex items-center justify-center;
}

.image-modal-image {
  @apply block max-w-full max-h-[90vh] rounded-2xl shadow-2xl theme-bg-panel;
}

.icon-svg {
  @apply w-5 h-5;
}
</style>
