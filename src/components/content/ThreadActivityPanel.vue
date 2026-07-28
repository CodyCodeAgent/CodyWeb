<template>
  <div class="thread-activity-host">
    <button
      class="thread-work-log-trigger"
      type="button"
      :aria-expanded="isWorkLogOpen"
      aria-controls="thread-work-log-panel"
      :aria-label="workLogTriggerLabel"
      :title="workLogTriggerLabel"
      data-testid="thread-work-log-trigger"
      @click="toggleWorkLog"
    >
      <IconTablerClipboardList class="thread-work-log-trigger-icon" />
      <span v-if="workLogBadgeCount > 0" class="thread-work-log-trigger-badge" data-testid="thread-work-log-badge">
        {{ workLogBadgeText }}
      </span>
    </button>

    <aside
      v-if="isWorkLogOpen"
      id="thread-work-log-panel"
      class="thread-activity-panel"
      :aria-label="t('workLog.panelAria')"
      data-testid="thread-work-log-panel"
    >
      <header class="thread-activity-header">
        <div class="thread-activity-header-copy">
          <h2 class="thread-activity-title">{{ t('workLog.title') }}</h2>
          <p class="thread-activity-subtitle">{{ statusText }}</p>
          <div class="thread-activity-view-toggle" :aria-label="t('workLog.diffViewMode')" @pointerdown.stop>
            <button
              class="thread-activity-view-button"
              data-testid="thread-work-log-view-unified"
              type="button"
              :data-active="diffViewMode === 'unified'"
              @click="setDiffViewMode('unified')"
            >
              {{ t('workLog.unified') }}
            </button>
            <button
              class="thread-activity-view-button"
              data-testid="thread-work-log-view-split"
              type="button"
              :data-active="diffViewMode === 'split'"
              @click="setDiffViewMode('split')"
            >
              {{ t('workLog.split') }}
            </button>
          </div>
        </div>
        <button
          class="thread-activity-close"
          type="button"
          :aria-label="t('workLog.close')"
          :title="t('workLog.close')"
          @click="closeWorkLog"
        >
          ×
        </button>
      </header>

      <section class="thread-activity-metrics" :aria-label="t('workLog.summaryAria')">
        <div v-for="metric in workLogMetrics" :key="metric.label" class="thread-activity-metric">
          <span class="thread-activity-metric-value">{{ metric.value }}</span>
          <span class="thread-activity-metric-label">{{ metric.label }}</span>
        </div>
      </section>

      <section class="thread-activity-section thread-activity-section-scroll">
        <div class="thread-activity-section-heading">
          <h3 class="thread-activity-section-title">{{ t('workLog.changedFiles') }}</h3>
          <span v-if="diffReview.files.length > 0" class="thread-activity-section-count">
            {{ filteredDiffFiles.length }} / {{ diffReview.files.length }}
          </span>
        </div>
        <label v-if="diffReview.files.length > 0" class="work-log-file-filter">
          <span>{{ t('workLog.searchFiles') }}</span>
          <input
            v-model="workLogFileQuery"
            data-testid="thread-work-log-file-search"
            type="search"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('workLog.searchPlaceholder')"
          />
        </label>
        <p v-if="diffReview.files.length === 0" class="thread-activity-empty">{{ t('workLog.noFileChanges') }}</p>
        <p v-else-if="filteredDiffFiles.length === 0" class="thread-activity-empty">{{ t('workLog.noFileMatches') }}</p>

        <div
          v-for="file in filteredDiffFiles"
          :key="file.filePath"
          class="work-log-card work-log-file-card"
          data-testid="thread-work-log-file"
        >
          <details class="work-log-file-details" @toggle="onFileDetailsToggle(file.filePath, $event)">
            <summary class="work-log-summary">
              <span class="work-log-primary-stack" :title="file.filePath">
                <span class="work-log-primary">{{ displayFilePath(file.filePath).label }}</span>
                <span v-if="displayFilePath(file.filePath).directory" class="work-log-directory">
                  {{ displayFilePath(file.filePath).directory }}
                </span>
              </span>
              <span class="work-log-status">{{ formatFileStatus(file.status) }}</span>
              <span class="work-log-stat">{{ fileStatLabel(file) }}</span>
              <span class="work-log-summary-spacer" />
            </summary>
            <p v-if="shouldRenderFileDetails(file.filePath) && file.oldPath" class="work-log-meta">{{ t('workLog.fromPath', { path: file.oldPath }) }}</p>
            <div v-if="shouldRenderFileDetails(file.filePath) && file.hunks.length > 0" class="work-log-diff" :aria-label="t('workLog.fileDiffAria')">
              <section v-for="hunk in file.hunks" :key="`${file.filePath}:${hunk.header}`" class="work-log-hunk">
                <div class="work-log-diff-row work-log-diff-row-hunk">
                  <span class="work-log-line-number" />
                  <span class="work-log-line-number" />
                  <span class="work-log-line-prefix" />
                  <code class="work-log-line-code">{{ hunk.header }}</code>
                </div>
                <template v-if="diffViewMode === 'split'">
                  <div
                    v-for="(row, index) in splitRows(previewHunkLines(hunk.lines))"
                    :key="`${file.filePath}:${hunk.header}:split:${index}`"
                    class="work-log-split-row"
                  >
                    <span class="work-log-split-line-number" :data-kind="row.old.kind">{{ formatLineNumber(row.old.lineNumber) }}</span>
                    <code class="work-log-split-code" :data-kind="row.old.kind">{{ row.old.content }}</code>
                    <span class="work-log-split-line-number" :data-kind="row.new.kind">{{ formatLineNumber(row.new.lineNumber) }}</span>
                    <code class="work-log-split-code" :data-kind="row.new.kind">{{ row.new.content }}</code>
                  </div>
                </template>
                <template v-else>
                  <div
                    v-for="(line, index) in previewHunkLines(hunk.lines)"
                    :key="`${file.filePath}:${hunk.header}:${index}`"
                    class="work-log-diff-row"
                    :data-kind="line.kind"
                  >
                    <span class="work-log-line-number">{{ formatLineNumber(line.oldLineNumber) }}</span>
                    <span class="work-log-line-number">{{ formatLineNumber(line.newLineNumber) }}</span>
                    <span class="work-log-line-prefix">{{ diffLinePrefix(line.kind) }}</span>
                    <code class="work-log-line-code">{{ line.content }}</code>
                  </div>
                </template>
                <div v-if="hiddenHunkLineCount(hunk.lines) > 0" class="work-log-diff-truncation">
                  <span>{{ t('workLog.hiddenLines', { count: String(hiddenHunkLineCount(hunk.lines)) }) }}</span>
                  <button type="button" @click="openFullscreenDiff(file.filePath)">{{ t('workLog.openFullscreen') }}</button>
                </div>
              </section>
            </div>
            <pre v-else-if="shouldRenderFileDetails(file.filePath) && file.patch" class="work-log-output"><code>{{ file.patch }}</code></pre>
          </details>
          <button
            class="work-log-fullscreen-button"
            data-testid="thread-work-log-fullscreen"
            type="button"
            :aria-label="t('workLog.openDiffFullscreen')"
            :title="t('workLog.openDiffFullscreen')"
            @click="openFullscreenDiff(file.filePath)"
          >
            ⛶
          </button>
        </div>

        <h3 class="thread-activity-section-title thread-activity-section-title-spaced">{{ t('workLog.commands') }}</h3>
        <p v-if="commandEntries.length === 0" class="thread-activity-empty">{{ t('workLog.noCommands') }}</p>

        <details
          v-for="entry in commandEntries"
          :key="entry.messageId"
          class="work-log-card"
          :data-tone="toolStatusTone(entry.status)"
          @toggle="onCommandDetailsToggle(entry.messageId, $event)"
        >
          <summary class="work-log-summary">
            <span class="work-log-primary">{{ entry.summary }}</span>
            <span class="work-log-summary-spacer" />
            <span class="work-log-status">{{ formatToolStatusLabel(entry.status) }}</span>
            <span v-if="entry.exitCode !== null" class="work-log-stat">{{ t('workLog.exitCode', { code: String(entry.exitCode) }) }}</span>
            <span v-else class="work-log-summary-spacer" />
          </summary>
          <dl v-if="shouldRenderCommandDetails(entry.messageId)" class="work-log-details">
            <div v-if="entry.cwd">
              <dt>{{ t('workLog.cwd') }}</dt>
              <dd>{{ entry.cwd }}</dd>
            </div>
            <div v-if="entry.duration">
              <dt>{{ t('workLog.duration') }}</dt>
              <dd>{{ entry.duration }}</dd>
            </div>
          </dl>
          <template v-if="shouldRenderCommandDetails(entry.messageId)">
            <pre v-if="entry.output" class="work-log-output"><code>{{ entry.output }}</code></pre>
            <p v-else class="work-log-meta">{{ t('workLog.noCommandOutput') }}</p>
          </template>
        </details>
      </section>
    </aside>

    <Teleport to="body">
      <section
        v-if="pendingRequests.length > 0"
        class="thread-action-required-float"
        :aria-label="t('workLog.actionRequired')"
        data-testid="thread-action-required-float"
      >
        <header class="thread-action-required-header">
          <div>
            <h3 class="thread-action-required-title">{{ t('workLog.actionRequired') }}</h3>
            <p class="thread-action-required-subtitle">
              {{ pendingApprovalSubtitle }}
            </p>
          </div>
        </header>

        <div class="thread-action-required-list">
          <article v-for="card in pendingApprovalCards" :key="card.request.id" class="activity-request-card">
            <p class="activity-request-method">{{ formatRequestCardTitle(card) }}</p>
            <p class="activity-request-meta">{{ serverRequestMetaLabel({ request: card.request }) }}</p>
            <p class="activity-request-subject">{{ card.summary.subject }}</p>
            <div class="approval-risk-line">
              <span class="approval-risk-badge" :data-level="card.summary.level">
                {{ formatRiskLevel(card.summary.level) }}
              </span>
              <span
                v-for="label in card.summary.riskLabels"
                :key="`${card.request.id}:${label}`"
                class="approval-risk-label"
              >
                {{ label }}
              </span>
            </div>
            <p class="activity-request-reason">{{ card.summary.description }}</p>
            <ul class="approval-impact-list">
              <li v-for="impact in card.summary.impacts" :key="`${card.request.id}:${impact}`">
                {{ impact }}
              </li>
            </ul>
            <div class="approval-scope-line" :aria-label="t('workLog.approvalScopes')">
              <span
                v-for="scope in approvalScopeOptions"
                :key="`${card.request.id}:${scope.scope}`"
                class="approval-scope"
                :data-enabled="scope.enabled"
                :title="scope.description"
              >
                {{ scope.label }}
              </span>
            </div>
            <p class="approval-recommendation">{{ card.summary.recommendation }}</p>

            <div class="activity-request-actions">
              <template v-if="card.isApprovalRequest">
                <button
                  v-for="scope in approvalScopeOptions"
                  :key="`${card.request.id}:${serverRequestActionKeyPrefix(card.kind)}:${scope.scope}`"
                  class="activity-request-button"
                  data-testid="thread-approval-scope"
                  :class="{ 'activity-request-button-primary': scope.scope === 'single', 'activity-request-button-danger': scope.scope === 'permanent' }"
                  type="button"
                  :data-scope="scope.scope"
                  @click="onRespondApprovalScope(card.request.id, scope.scope)"
                >
                  {{ scope.label }}
                </button>
                <button
                  class="activity-request-button"
                  data-testid="thread-approval-decline"
                  type="button"
                  @click="onRespondApproval(card.request.id, 'decline')"
                >
                  {{ t('workLog.decline') }}
                </button>
              </template>
              <template v-else>
                <button class="activity-request-button activity-request-button-primary" type="button" @click="onRespondEmptyResult(card.request.id)">
                  {{ t('workLog.emptyResult') }}
                </button>
                <button class="activity-request-button" type="button" @click="onRejectRequest(card.request.id)">
                  {{ t('workLog.reject') }}
                </button>
              </template>
            </div>
          </article>
        </div>
      </section>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="fullscreenFile"
        class="work-log-fullscreen-backdrop"
        data-testid="thread-work-log-fullscreen-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('workLog.fullscreenDiff')"
        @click.self="closeFullscreenDiff"
      >
        <section class="work-log-fullscreen-panel">
          <header class="work-log-fullscreen-header">
            <div class="work-log-fullscreen-copy">
              <h3 :title="fullscreenFile.filePath">{{ displayFilePath(fullscreenFile.filePath).label }}</h3>
              <p>
                {{ formatFileStatus(fullscreenFile.status) }} · {{ fileStatLabel(fullscreenFile) }}
              </p>
              <p class="work-log-fullscreen-path">{{ fullscreenFile.filePath }}</p>
            </div>
            <div class="thread-activity-view-toggle work-log-fullscreen-view-toggle" :aria-label="t('workLog.diffViewMode')">
              <button
                class="thread-activity-view-button"
                data-testid="thread-work-log-fullscreen-view-unified"
                type="button"
                :data-active="diffViewMode === 'unified'"
                @click="setDiffViewMode('unified')"
              >
                {{ t('workLog.unified') }}
              </button>
              <button
                class="thread-activity-view-button"
                data-testid="thread-work-log-fullscreen-view-split"
                type="button"
                :data-active="diffViewMode === 'split'"
                @click="setDiffViewMode('split')"
              >
                {{ t('workLog.split') }}
              </button>
            </div>
            <button
              class="work-log-fullscreen-close"
              type="button"
              :aria-label="t('workLog.closeFullscreenDiff')"
              :title="t('workLog.closeShort')"
              @click="closeFullscreenDiff"
              @pointerdown.stop
            >
              ×
            </button>
          </header>

          <div v-if="fullscreenFile.oldPath" class="work-log-fullscreen-meta">
            {{ t('workLog.fromPath', { path: fullscreenFile.oldPath }) }}
          </div>

          <div v-if="fullscreenFile.hunks.length > 0" class="work-log-diff work-log-diff-fullscreen" :aria-label="t('workLog.fullscreenFileDiff')">
            <section v-for="hunk in fullscreenFile.hunks" :key="`fullscreen:${fullscreenFile.filePath}:${hunk.header}`" class="work-log-hunk">
              <div class="work-log-diff-row work-log-diff-row-hunk">
                <span class="work-log-line-number" />
                <span class="work-log-line-number" />
                <span class="work-log-line-prefix" />
                <code class="work-log-line-code">{{ hunk.header }}</code>
              </div>
              <template v-if="diffViewMode === 'split'">
                <div
                  v-for="(row, index) in splitRows(hunk.lines)"
                  :key="`fullscreen:${fullscreenFile.filePath}:${hunk.header}:split:${index}`"
                  class="work-log-split-row"
                >
                  <span class="work-log-split-line-number" :data-kind="row.old.kind">{{ formatLineNumber(row.old.lineNumber) }}</span>
                  <code class="work-log-split-code" :data-kind="row.old.kind">{{ row.old.content }}</code>
                  <span class="work-log-split-line-number" :data-kind="row.new.kind">{{ formatLineNumber(row.new.lineNumber) }}</span>
                  <code class="work-log-split-code" :data-kind="row.new.kind">{{ row.new.content }}</code>
                </div>
              </template>
              <template v-else>
                <div
                  v-for="(line, index) in hunk.lines"
                  :key="`fullscreen:${fullscreenFile.filePath}:${hunk.header}:${index}`"
                  class="work-log-diff-row"
                  :data-kind="line.kind"
                >
                  <span class="work-log-line-number">{{ formatLineNumber(line.oldLineNumber) }}</span>
                  <span class="work-log-line-number">{{ formatLineNumber(line.newLineNumber) }}</span>
                  <span class="work-log-line-prefix">{{ diffLinePrefix(line.kind) }}</span>
                  <code class="work-log-line-code">{{ line.content }}</code>
                </div>
              </template>
            </section>
          </div>
          <pre v-else-if="fullscreenFile.patch" class="work-log-output work-log-output-fullscreen"><code>{{ fullscreenFile.patch }}</code></pre>
          <p v-else class="work-log-fullscreen-empty">{{ t('workLog.noDiffContent') }}</p>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconTablerClipboardList from '../icons/IconTablerClipboardList.vue'
import {
  buildThreadCommandEntries,
  buildThreadActivitySummary,
  buildPendingApprovalCards,
  buildWorkLogActionState,
  buildWorkLogDisplayPathParts,
  buildWorkLogFileStatLabel,
  filterWorkLogFiles,
  formatWorkLogLineNumber,
  shouldCloseWorkLogFullscreenFile,
  workLogDiffLinePrefix,
  workLogFullscreenFile,
} from '../../composables/useThreadActivity'
import {
  formatToolStatus,
  toolStatusTone,
} from '../../composables/threadToolTimelineRules'
import {
  APPROVAL_SCOPE_OPTIONS,
  type UiApprovalDecision,
  type UiApprovalRiskLevel,
} from '../../composables/useApprovalRisk'
import { useLocale, type LocaleMessageKey } from '../../composables/useLocale'
import {
  buildApprovalDecisionReply,
  buildApprovalScopeReply,
  buildEmptyServerRequestReply,
  buildRejectedServerRequestReply,
  serverRequestActionKeyPrefix,
  serverRequestMetaLabel,
  type UiServerRequestCard,
} from '../../composables/serverRequestRules'
import { buildDiffReview, buildSplitDiffRows, sliceDiffHunkLines } from '../../composables/useDiffReview'
import type { UiDiffLineKind, UiDiffReviewFile, UiDiffReviewLine, UiDiffSplitRow } from '../../composables/useDiffReview'
import type { UiApprovalDecisionScope, UiMessage, UiServerRequest, UiServerRequestReply, UiToolingRollbackFileResult } from '../../types/codex'

const props = defineProps<{
  messages: UiMessage[]
  pendingRequests: UiServerRequest[]
  cwd: string
  threadId: string
}>()

const emit = defineEmits<{
  respondServerRequest: [payload: UiServerRequestReply]
  rollbackCompleted: [result: UiToolingRollbackFileResult]
}>()
const { t } = useLocale()
const approvalRiskTranslator = (key: string, replacements?: Record<string, string>) =>
  t(key as LocaleMessageKey, replacements)
const approvalScopeOptions = computed(() => APPROVAL_SCOPE_OPTIONS.map((option) => {
  if (option.scope === 'single') {
    return {
      ...option,
      label: t('workLog.approvalScope.single'),
      description: t('workLog.approvalScope.singleDescription'),
    }
  }
  if (option.scope === 'session') {
    return {
      ...option,
      label: t('workLog.approvalScope.session'),
      description: t('workLog.approvalScope.sessionDescription'),
    }
  }
  if (option.scope === 'workspace') {
    return {
      ...option,
      label: t('workLog.approvalScope.workspace'),
      description: t('workLog.approvalScope.workspaceDescription'),
    }
  }
  return {
    ...option,
    label: t('workLog.approvalScope.permanent'),
    description: t('workLog.approvalScope.permanentDescription'),
  }
}))
const WORK_LOG_PREVIEW_HUNK_LINE_LIMIT = 120

const commandEntries = computed(() => buildThreadCommandEntries(props.messages))
const diffReview = computed(() => buildDiffReview(props.messages))
const fullscreenFilePath = ref('')
const isWorkLogOpen = ref(false)
const diffViewMode = ref<'unified' | 'split'>('unified')
const workLogFileQuery = ref('')
const openFileDetailsByPath = ref<Record<string, boolean>>({})
const openCommandDetailsById = ref<Record<string, boolean>>({})
const fullscreenFile = computed(() => workLogFullscreenFile(diffReview.value, fullscreenFilePath.value))
const filteredDiffFiles = computed(() => filterWorkLogFiles(diffReview.value.files, workLogFileQuery.value, props.cwd))
const workLogActionState = computed(() => buildWorkLogActionState({
  isOpen: isWorkLogOpen.value,
  fileCount: diffReview.value.summary.fileCount,
  commandCount: commandEntries.value.length,
}))
const workLogBadgeCount = computed(() => workLogActionState.value.badgeCount)
const workLogBadgeText = computed(() => workLogActionState.value.badgeText)
const workLogTriggerLabel = computed(() => {
  const action = isWorkLogOpen.value ? t('workLog.close') : t('workLog.open')
  const fileCount = diffReview.value.summary.fileCount
  const commandCount = commandEntries.value.length
  const fileLabel = t(fileCount === 1 ? 'workLog.fileSingular' : 'workLog.filePlural')
  const commandLabel = t(commandCount === 1 ? 'workLog.commandSingular' : 'workLog.commandPlural')
  return `${action}: ${String(fileCount)} ${fileLabel} · ${String(commandCount)} ${commandLabel}`
})
const workLogMetrics = computed(() => [
  { label: t('workLog.metric.files'), value: String(diffReview.value.summary.fileCount) },
  { label: t('workLog.metric.commands'), value: String(commandEntries.value.length) },
  { label: t('workLog.metric.added'), value: `+${String(diffReview.value.summary.addedLines)}` },
  { label: t('workLog.metric.removed'), value: `-${String(diffReview.value.summary.removedLines)}` },
])
const summary = computed(() => buildThreadActivitySummary(props.messages, props.pendingRequests))
const pendingApprovalSubtitle = computed(() => t('workLog.approvalWaiting', {
  count: String(props.pendingRequests.length),
  approvalLabel: t(props.pendingRequests.length === 1 ? 'workLog.approvalSingular' : 'workLog.approvalPlural'),
}))
const pendingApprovalCards = computed(() => buildPendingApprovalCards(props.pendingRequests, approvalRiskTranslator))
const statusText = computed(() => {
  if (summary.value.pendingRequestCount > 0) {
    return t('workLog.status.waiting', { count: String(summary.value.pendingRequestCount) })
  }
  const fileCount = diffReview.value.summary.fileCount
  const commandCount = commandEntries.value.length
  if (fileCount > 0 || commandCount > 0) {
    return t('workLog.status.changed', {
      files: String(fileCount),
      fileLabel: t(fileCount === 1 ? 'workLog.fileSingular' : 'workLog.filePlural'),
      commands: String(commandCount),
      commandLabel: t(commandCount === 1 ? 'workLog.commandSingular' : 'workLog.commandPlural'),
    })
  }
  return t('workLog.status.empty')
})

function onRespondApproval(requestId: number, decision: UiApprovalDecision): void {
  emit('respondServerRequest', buildApprovalDecisionReply(requestId, decision))
}

function onRespondApprovalScope(requestId: number, scope: UiApprovalDecisionScope): void {
  emit('respondServerRequest', buildApprovalScopeReply(requestId, scope))
}

function onRespondEmptyResult(requestId: number): void {
  emit('respondServerRequest', buildEmptyServerRequestReply(requestId))
}

function onRejectRequest(requestId: number): void {
  emit('respondServerRequest', buildRejectedServerRequestReply(
    requestId,
    t('workLog.rejectedFromActivityPanel'),
  ))
}

function formatLineNumber(value: number | null): string {
  return formatWorkLogLineNumber(value)
}

function diffLinePrefix(kind: UiDiffLineKind): string {
  return workLogDiffLinePrefix(kind)
}

function formatRiskLevel(level: UiApprovalRiskLevel): string {
  if (level === 'high') return t('workLog.risk.high')
  if (level === 'medium') return t('workLog.risk.medium')
  return t('workLog.risk.low')
}

function formatRequestCardTitle(card: UiServerRequestCard): string {
  if (card.kind === 'command_approval') return t('workLog.request.commandApproval')
  if (card.kind === 'file_change_approval') return t('workLog.request.fileChangeApproval')
  if (card.kind === 'tool_call' || card.kind === 'tool_user_input') return t('workLog.request.toolApproval')
  return card.summary.title
}

function formatToolStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (!normalized) return formatToolStatus(status)
  if (normalized.includes('fail') || normalized.includes('error')) return t('workLog.commandStatus.failed')
  if (
    normalized.includes('decline') ||
    normalized.includes('reject') ||
    normalized.includes('cancel')
  ) {
    return t('workLog.commandStatus.cancelled')
  }
  if (normalized.includes('pending')) return t('workLog.commandStatus.pending')
  if (
    normalized.includes('running') ||
    normalized.includes('progress') ||
    normalized.includes('started')
  ) {
    return t('workLog.commandStatus.running')
  }
  if (
    normalized.includes('success') ||
    normalized.includes('complete') ||
    normalized.includes('done') ||
    normalized.includes('applied')
  ) {
    return t('workLog.commandStatus.completed')
  }
  return formatToolStatus(status)
}

function formatFileStatus(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'modified') return t('workLog.fileStatus.modified')
  if (normalized === 'added') return t('workLog.fileStatus.added')
  if (normalized === 'deleted' || normalized === 'removed') return t('workLog.fileStatus.deleted')
  if (normalized === 'renamed' || normalized === 'moved') return t('workLog.fileStatus.renamed')
  if (normalized === 'copied') return t('workLog.fileStatus.copied')
  if (normalized === 'completed') return t('workLog.fileStatus.completed')
  return status
}

function splitRows(lines: UiDiffReviewLine[]): UiDiffSplitRow[] {
  return buildSplitDiffRows(lines)
}

function previewHunkLines(lines: UiDiffReviewLine[]): UiDiffReviewLine[] {
  return sliceDiffHunkLines(lines, WORK_LOG_PREVIEW_HUNK_LINE_LIMIT).lines
}

function hiddenHunkLineCount(lines: UiDiffReviewLine[]): number {
  return sliceDiffHunkLines(lines, WORK_LOG_PREVIEW_HUNK_LINE_LIMIT).hiddenCount
}

function setDiffViewMode(mode: 'unified' | 'split'): void {
  diffViewMode.value = mode
}

function fileStatLabel(file: Pick<UiDiffReviewFile, 'addedLines' | 'removedLines'>): string {
  return buildWorkLogFileStatLabel(file)
}

function displayFilePath(filePath: string) {
  return buildWorkLogDisplayPathParts(filePath, props.cwd)
}

function shouldRenderFileDetails(filePath: string): boolean {
  return openFileDetailsByPath.value[filePath] === true
}

function shouldRenderCommandDetails(messageId: string): boolean {
  return openCommandDetailsById.value[messageId] === true
}

function onFileDetailsToggle(filePath: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement)) return
  openFileDetailsByPath.value = {
    ...openFileDetailsByPath.value,
    [filePath]: target.open,
  }
}

function onCommandDetailsToggle(messageId: string, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement)) return
  openCommandDetailsById.value = {
    ...openCommandDetailsById.value,
    [messageId]: target.open,
  }
}

function openFullscreenDiff(filePath: string): void {
  fullscreenFilePath.value = filePath
}

function closeFullscreenDiff(): void {
  fullscreenFilePath.value = ''
}

function closeWorkLog(): void {
  isWorkLogOpen.value = false
}

function toggleWorkLog(): void {
  isWorkLogOpen.value = !isWorkLogOpen.value
}

watch(diffReview, (review) => {
  if (shouldCloseWorkLogFullscreenFile(review, fullscreenFilePath.value)) {
    fullscreenFilePath.value = ''
  }
})

watch(() => props.threadId, () => {
  workLogFileQuery.value = ''
  openFileDetailsByPath.value = {}
  openCommandDetailsById.value = {}
  fullscreenFilePath.value = ''
})
</script>

<style scoped>
@reference "../../style.css";

.thread-activity-host {
  @apply relative z-40 flex items-center;
}

.thread-work-log-trigger {
  @apply relative inline-flex h-9 w-9 items-center justify-center rounded-md border theme-border theme-bg-panel theme-muted shadow-sm transition hover:theme-border-info hover:theme-bg-info-soft hover:theme-text-info focus-visible:outline-2 focus-visible:outline-offset-2;
}

.thread-work-log-trigger[aria-expanded='true'] { @apply theme-border-info theme-bg-info-soft theme-text-info; }

.thread-work-log-trigger-icon {
  @apply h-5 w-5;
}

.thread-work-log-trigger-badge {
  @apply absolute -right-1.5 -top-1.5 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full theme-bg-danger px-1 font-mono text-[0.58rem] font-bold leading-none theme-on-danger;
  box-shadow: 0 0 0 2px var(--color-background);
}

.thread-activity-panel {
  @apply absolute right-0 top-[calc(100%+0.5rem)] z-50 flex max-h-[min(72vh,48rem)] min-h-0 w-[min(34rem,calc(100vw-3rem))] flex-col gap-3 overflow-hidden rounded-lg border theme-border theme-bg-panel p-3 shadow-2xl;
}

.thread-activity-header {
  @apply flex shrink-0 items-start justify-between gap-3;
}

.thread-activity-header-copy {
  @apply min-w-0;
}

.thread-activity-close {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border theme-border theme-bg-panel text-lg leading-none theme-muted transition hover:theme-bg-control hover:theme-text;
}

.thread-activity-title {
  @apply m-0 text-sm font-semibold theme-text;
}

.thread-activity-subtitle {
  @apply m-0 mt-0.5 text-xs theme-muted;
}

.thread-activity-view-toggle {
  @apply mt-2 inline-flex rounded-md border theme-border theme-bg-control p-0.5;
}

.thread-activity-view-button {
  @apply rounded px-2 py-1 text-[0.68rem] font-semibold leading-4 theme-muted transition hover:theme-bg-panel hover:theme-text;
}

.thread-activity-view-button[data-active='true'] {
  @apply theme-bg-panel theme-text-info shadow-sm;
}

.thread-activity-metrics {
  @apply grid shrink-0 grid-cols-4 gap-1.5;
}

.thread-activity-metric {
  @apply min-w-0 rounded-md border theme-border theme-bg-subtle px-2 py-1.5;
}

.thread-activity-metric[data-alert='true'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.thread-activity-metric-value {
  @apply block text-sm font-semibold leading-5 theme-text;
}

.thread-activity-metric-label {
  @apply block truncate text-[0.68rem] leading-4 theme-muted;
}

.thread-activity-section {
  @apply flex shrink-0 flex-col gap-2;
}

.thread-activity-section-scroll {
  @apply min-h-0 flex-1 overflow-y-auto pr-0.5;
}

.thread-activity-section-title {
  @apply m-0 text-xs font-semibold uppercase tracking-normal theme-muted;
}

.thread-activity-section-heading {
  @apply flex items-center justify-between gap-2;
}

.thread-activity-section-count {
  @apply shrink-0 text-[0.68rem] font-medium leading-4 theme-muted;
}

.thread-activity-section-title-spaced {
  @apply mt-3;
}

.thread-activity-empty {
  @apply m-0 rounded-md border border-dashed theme-border px-3 py-2 text-xs theme-muted;
}

.work-log-file-filter {
  @apply grid gap-1 rounded-md border theme-border theme-bg-panel px-2 py-1.5;
}

.work-log-file-filter span {
  @apply text-[0.68rem] font-semibold uppercase leading-4 theme-muted;
}

.work-log-file-filter input {
  @apply min-w-0 border-0 bg-transparent p-0 text-xs theme-text outline-none placeholder:theme-muted;
}

.thread-action-required-float {
  @apply fixed z-[70] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 overflow-hidden rounded-lg border theme-border-warning theme-bg-warning-soft p-3 shadow-2xl;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  max-height: min(72vh, 42rem, calc(100vh - 2rem));
  max-height: min(72dvh, 42rem, calc(100dvh - 2rem));
}

.thread-action-required-header {
  @apply flex shrink-0 items-start justify-between gap-3 border-b theme-border-warning pb-2;
}

.thread-action-required-title {
  @apply m-0 text-xs font-semibold uppercase tracking-normal theme-text-warning;
}

.thread-action-required-subtitle {
  @apply m-0 mt-0.5 text-xs theme-text-warning;
}

.thread-action-required-list {
  @apply min-h-0 overflow-y-auto pr-0.5;
}

.thread-action-required-list .activity-request-card + .activity-request-card {
  @apply mt-2;
}

@media (max-width: 640px) {
  .thread-action-required-float {
    right: max(0.75rem, env(safe-area-inset-right));
    bottom: max(0.75rem, env(safe-area-inset-bottom));
    left: max(0.75rem, env(safe-area-inset-left));
    width: auto;
    max-height: calc(100vh - 1.5rem);
    max-height: calc(100dvh - 1.5rem);
  }
}

.work-log-card {
  @apply rounded-lg border theme-border theme-bg-subtle px-3 py-2;
}

.work-log-card + .work-log-card {
  @apply mt-2;
}

.work-log-card[data-tone='success'] {
  @apply theme-border-success theme-bg-success-soft;
}

.work-log-card[data-tone='danger'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.work-log-card[data-tone='working'] {
  @apply theme-border-info theme-bg-info-soft;
}

.work-log-file-card {
  @apply relative;
}

.work-log-file-details {
  @apply block;
}

.work-log-summary {
  @apply grid cursor-pointer grid-cols-[minmax(0,1fr)_2rem_auto_auto] items-center gap-2 text-xs;
}

.work-log-file-card .work-log-summary {
  @apply grid-cols-[minmax(0,1fr)_auto_auto_2rem];
}

.work-log-primary {
  @apply min-w-0 truncate font-mono font-semibold theme-text;
}

.work-log-primary-stack {
  @apply grid min-w-0 gap-0.5;
}

.work-log-directory {
  @apply min-w-0 truncate font-mono text-[0.68rem] leading-4 theme-muted;
}

.work-log-status,
.work-log-stat {
  @apply shrink-0 rounded-full border theme-border theme-bg-panel px-2 py-0.5 text-[0.68rem] font-medium leading-4 theme-muted;
}

.work-log-fullscreen-button {
  @apply absolute right-3 top-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border theme-border theme-bg-panel text-sm leading-none theme-muted transition hover:theme-border-info hover:theme-bg-info-soft hover:theme-text-info;
}

.work-log-card[data-tone='success'] .work-log-status {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.work-log-card[data-tone='danger'] .work-log-status {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.work-log-card[data-tone='working'] .work-log-status {
  @apply theme-border-info theme-bg-info-soft theme-text-info;
}

.work-log-meta {
  @apply m-0 mt-2 break-words text-xs leading-4 theme-muted;
}

.work-log-details {
  @apply m-0 mt-2 grid gap-1;
}

.work-log-details div {
  @apply grid grid-cols-[4rem_minmax(0,1fr)] gap-2;
}

.work-log-details dt {
  @apply text-[0.68rem] font-semibold uppercase leading-4 theme-muted;
}

.work-log-details dd {
  @apply m-0 min-w-0 truncate font-mono text-[0.68rem] leading-4 theme-muted;
}

.work-log-output {
  @apply m-0 mt-2 max-h-80 overflow-auto rounded-md border theme-border theme-bg-panel px-2 py-1.5 text-xs leading-5 theme-text;
}

.work-log-output code {
  @apply whitespace-pre font-mono;
}

.work-log-diff {
  @apply mt-2 overflow-auto rounded-md border theme-border theme-bg-panel;
}

.work-log-diff-fullscreen {
  @apply m-0 min-h-0 flex-1 rounded-none border-0;
}

.work-log-hunk + .work-log-hunk {
  @apply border-t theme-border;
}

.work-log-diff-row {
  @apply grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(34rem,1fr)] border-b theme-border font-mono text-xs leading-5;
}

.work-log-diff-row:last-child {
  @apply border-b-0;
}

.work-log-diff-row[data-kind='add'] {
  background: color-mix(in srgb, var(--color-success) 13%, var(--color-panel));
}

.work-log-diff-row[data-kind='remove'] {
  background: color-mix(in srgb, var(--color-danger) 13%, var(--color-panel));
}

.work-log-diff-row[data-kind='meta'],
.work-log-diff-row-hunk {
  background: color-mix(in srgb, var(--color-info) 12%, var(--color-panel));
}

.work-log-line-number {
  @apply select-none border-r theme-border px-2 text-right text-[0.68rem] theme-muted;
  background: var(--color-elevated);
}

.work-log-diff-row[data-kind='add'] .work-log-line-number {
  background: color-mix(in srgb, var(--color-success) 20%, var(--color-panel));
}

.work-log-diff-row[data-kind='remove'] .work-log-line-number {
  background: color-mix(in srgb, var(--color-danger) 20%, var(--color-panel));
}

.work-log-diff-row-hunk .work-log-line-number,
.work-log-diff-row[data-kind='meta'] .work-log-line-number {
  background: color-mix(in srgb, var(--color-info) 20%, var(--color-panel));
}

.work-log-line-prefix {
  @apply select-none px-2 theme-muted;
}

.work-log-diff-row[data-kind='add'] .work-log-line-prefix {
  @apply theme-text-success;
}

.work-log-diff-row[data-kind='remove'] .work-log-line-prefix {
  @apply theme-text-danger;
}

.work-log-line-code {
  @apply whitespace-pre px-2 theme-text;
}

.work-log-diff-row-hunk .work-log-line-code {
  @apply theme-text-info;
}

.work-log-split-row {
  @apply grid min-w-[54rem] grid-cols-[3.25rem_minmax(22rem,1fr)_3.25rem_minmax(22rem,1fr)] border-b theme-border font-mono text-xs leading-5;
}

.work-log-split-row:last-child {
  @apply border-b-0;
}

.work-log-split-line-number {
  @apply select-none border-r theme-border px-2 text-right text-[0.68rem] theme-muted;
  background: var(--color-elevated);
}

.work-log-split-line-number:nth-child(3) {
  @apply border-l;
}

.work-log-split-code {
  @apply whitespace-pre px-2 theme-text;
}

.work-log-split-line-number[data-kind='add'],
.work-log-split-code[data-kind='add'] {
  background: color-mix(in srgb, var(--color-success) 13%, var(--color-panel));
}

.work-log-split-line-number[data-kind='remove'],
.work-log-split-code[data-kind='remove'] {
  background: color-mix(in srgb, var(--color-danger) 13%, var(--color-panel));
}

.work-log-split-line-number[data-kind='meta'],
.work-log-split-code[data-kind='meta'] {
  background: color-mix(in srgb, var(--color-info) 12%, var(--color-panel));
}

.work-log-split-line-number[data-kind='empty'],
.work-log-split-code[data-kind='empty'] {
  background: var(--color-surface-muted);
}

.work-log-diff-truncation {
  @apply flex min-w-max items-center justify-between gap-3 border-t theme-border theme-bg-subtle px-3 py-2 text-xs leading-4 theme-muted;
}

.work-log-diff-truncation button {
  @apply shrink-0 rounded-md border theme-border theme-bg-panel px-2 py-1 text-xs font-semibold theme-muted transition hover:theme-border hover:theme-bg-control focus:outline-none focus:ring-2 focus:ring-slate-300;
}

.work-log-fullscreen-backdrop {
  @apply fixed inset-0 z-[70] flex bg-slate-950/70 p-4 backdrop-blur-sm;
}

.work-log-fullscreen-panel {
  @apply flex min-h-0 w-full flex-col overflow-hidden rounded-lg border theme-border theme-bg-panel shadow-2xl;
}

.work-log-fullscreen-header {
  @apply flex shrink-0 items-start justify-between gap-3 border-b theme-border theme-bg-subtle px-4 py-3;
}

.work-log-fullscreen-copy {
  @apply min-w-0;
}

.work-log-fullscreen-view-toggle {
  @apply m-0 ml-auto shrink-0;
}

.work-log-fullscreen-copy h3 {
  @apply m-0 truncate font-mono text-sm font-semibold theme-text;
}

.work-log-fullscreen-copy p,
.work-log-fullscreen-meta,
.work-log-fullscreen-empty {
  @apply m-0 mt-1 text-xs theme-muted;
}

.work-log-fullscreen-path {
  @apply break-all font-mono;
}

.work-log-fullscreen-close {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border theme-border theme-bg-panel text-lg leading-none theme-muted transition hover:theme-bg-control hover:theme-text;
}

.work-log-fullscreen-meta {
  @apply mt-0 shrink-0 border-b theme-border theme-bg-panel px-4 py-2 font-mono;
}

.work-log-output-fullscreen {
  @apply m-0 min-h-0 flex-1 rounded-none border-0;
}

.work-log-fullscreen-empty {
  @apply px-4 py-3;
}

.activity-request-card,
.activity-entry-card {
  @apply rounded-lg border theme-border theme-bg-subtle px-3 py-2;
}

.thread-action-required-list .activity-request-card {
  @apply theme-border-warning theme-bg-panel;
}

:global(.app-dark) .thread-action-required-float {
  border-color: color-mix(in srgb, var(--color-warning) 52%, var(--color-border));
  background: color-mix(in srgb, var(--color-warning) 16%, var(--color-panel));
  color: color-mix(in srgb, var(--color-warning) 28%, var(--color-text));
}

:global(.app-dark) .thread-action-required-header {
  border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
}

:global(.app-dark) .thread-action-required-title,
:global(.app-dark) .thread-action-required-subtitle {
  color: color-mix(in srgb, var(--color-warning) 28%, var(--color-text));
}

:global(.app-dark) .thread-action-required-list .activity-request-card {
  border-color: color-mix(in srgb, var(--color-warning) 52%, var(--color-border));
  background: var(--color-panel);
}

:global(.app-dark) .thread-work-log-trigger,
:global(.app-dark) .thread-activity-close {
  border-color: var(--color-border);
  background: var(--color-elevated);
  color: var(--color-text-muted);
}

:global(.app-dark) .thread-work-log-trigger:hover,
:global(.app-dark) .thread-activity-close:hover {
  border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel));
  color: color-mix(in srgb, var(--color-accent) 28%, var(--color-text));
}

:global(.app-dark) .thread-work-log-trigger-badge {
  --tw-ring-color: var(--color-panel);
}

:global(.app-dark) .thread-activity-view-toggle {
  border-color: var(--color-border);
  background: var(--color-panel);
}

:global(.app-dark) .thread-activity-view-button {
  color: var(--color-text-muted);
}

:global(.app-dark) .thread-activity-view-button:hover,
:global(.app-dark) .thread-activity-view-button[data-active='true'] {
  background: var(--color-elevated);
  color: var(--color-accent);
}

:global(.app-dark) .thread-activity-section-count,
:global(.app-dark) .work-log-directory,
:global(.app-dark) .work-log-file-filter span {
  color: var(--color-text-muted);
}

:global(.app-dark) .work-log-file-filter {
  border-color: var(--color-border);
  background: var(--color-panel);
}

:global(.app-dark) .work-log-file-filter input {
  color: var(--color-text);
}

:global(.app-dark) .work-log-file-filter input::placeholder {
  color: color-mix(in srgb, var(--color-text-muted) 70%, transparent);
}

:global(.app-dark) .work-log-fullscreen-panel {
  border-color: var(--color-border);
  background: var(--color-panel);
  color: var(--color-text);
}

:global(.app-dark) .work-log-fullscreen-header,
:global(.app-dark) .work-log-fullscreen-meta {
  border-color: var(--color-border);
  background: var(--color-elevated);
}

:global(.app-dark) .work-log-fullscreen-copy h3,
:global(.app-dark) .work-log-fullscreen-copy p,
:global(.app-dark) .work-log-fullscreen-meta,
:global(.app-dark) .work-log-fullscreen-empty {
  color: var(--color-text-muted);
}

:global(.app-dark) .work-log-fullscreen-close,
:global(.app-dark) .work-log-fullscreen-button {
  border-color: var(--color-border);
  background: var(--color-elevated);
  color: var(--color-text-muted);
}

:global(.app-dark) .work-log-fullscreen-close:hover,
:global(.app-dark) .work-log-fullscreen-button:hover {
  border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel));
  color: color-mix(in srgb, var(--color-accent) 28%, var(--color-text));
}

:global(.app-dark) .work-log-split-row {
  border-color: var(--color-border);
}

:global(.app-dark) .work-log-split-line-number {
  border-color: var(--color-border);
  background: var(--color-elevated);
  color: var(--color-text-muted);
}

:global(.app-dark) .work-log-split-code {
  color: var(--color-text);
}

:global(.app-dark) .work-log-split-line-number[data-kind='add'],
:global(.app-dark) .work-log-split-code[data-kind='add'] {
  background: color-mix(in srgb, var(--color-success) 16%, var(--color-panel));
}

:global(.app-dark) .work-log-split-line-number[data-kind='remove'],
:global(.app-dark) .work-log-split-code[data-kind='remove'] {
  background: color-mix(in srgb, var(--color-danger) 16%, var(--color-panel));
}

:global(.app-dark) .work-log-split-line-number[data-kind='meta'],
:global(.app-dark) .work-log-split-code[data-kind='meta'] {
  background: color-mix(in srgb, var(--color-info) 16%, var(--color-panel));
}

:global(.app-dark) .work-log-split-line-number[data-kind='empty'],
:global(.app-dark) .work-log-split-code[data-kind='empty'] {
  background: var(--color-panel);
}

.activity-request-method {
  @apply m-0 truncate font-mono text-xs font-semibold theme-text;
}

.activity-request-meta {
  @apply m-0 mt-0.5 text-xs theme-muted;
}

.activity-request-subject {
  @apply m-0 mt-1 max-w-full whitespace-pre-wrap break-words font-mono text-xs leading-5 theme-text;
}

.approval-risk-line {
  @apply mt-2 flex flex-wrap items-center gap-1.5;
}

.approval-risk-badge {
  @apply rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold uppercase leading-4;
}

.approval-risk-badge[data-level='low'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.approval-risk-badge[data-level='medium'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.approval-risk-badge[data-level='high'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.approval-risk-label {
  @apply rounded-full border theme-border theme-bg-panel px-2 py-0.5 text-[0.68rem] leading-4 theme-muted;
}

.activity-request-reason {
  @apply m-0 mt-2 whitespace-pre-wrap text-xs leading-4 theme-muted;
}

.approval-impact-list {
  @apply m-0 mt-2 list-disc space-y-1 pl-4 text-xs leading-4 theme-muted;
}

.approval-scope-line {
  @apply mt-2 flex flex-wrap gap-1.5;
}

.approval-scope {
  @apply rounded-md border theme-border-info theme-bg-info-soft px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-normal theme-text-info;
}

.approval-scope[data-enabled='false'] {
  @apply theme-border theme-bg-control theme-muted;
}

.approval-recommendation {
  @apply m-0 mt-2 rounded-md border theme-border bg-white/70 px-2 py-1.5 text-xs leading-4 theme-text;
}

.activity-request-actions {
  @apply mt-2 flex flex-wrap gap-1.5;
}

.activity-request-button {
  @apply rounded-md border theme-border-warning theme-bg-panel px-2 py-1 text-xs theme-text-warning transition hover:theme-bg-warning-soft;
}

.activity-request-button-primary {
  @apply theme-border-warning theme-bg-warning theme-on-warning;
}

.activity-request-button-danger {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger hover:theme-bg-danger-soft;
}

.activity-entry-card {
  @apply mb-2;
}

.activity-entry-card[data-tone='success'] {
  @apply theme-border-success theme-bg-success-soft;
}

.activity-entry-card[data-tone='danger'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.activity-entry-card[data-tone='working'] {
  @apply theme-border-info theme-bg-info-soft;
}

.activity-entry-header {
  @apply flex items-center gap-2;
}

.activity-entry-kind {
  @apply min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-normal theme-muted;
}

.activity-entry-status {
  @apply shrink-0 rounded-full border theme-border theme-bg-panel px-2 py-0.5 text-[0.68rem] leading-4 font-medium theme-muted;
}

.activity-entry-card[data-tone='success'] .activity-entry-status {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.activity-entry-card[data-tone='danger'] .activity-entry-status {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.activity-entry-card[data-tone='working'] .activity-entry-status {
  @apply theme-border-info theme-bg-info-soft theme-text-info;
}

.activity-entry-summary {
  @apply m-0 mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 theme-text;
}

.activity-entry-detail-list {
  @apply m-0 mt-2 grid list-none gap-1 p-0;
}

.activity-entry-detail {
  @apply m-0 truncate font-mono text-xs leading-4 theme-muted;
}

.activity-entry-output {
  @apply mt-2 border-t theme-border pt-2 text-xs theme-muted;
}

.activity-entry-output summary {
  @apply cursor-pointer font-medium;
}

.activity-entry-output pre {
  @apply m-0 mt-1 max-h-56 overflow-auto rounded-md border theme-border theme-bg-panel px-2 py-1.5 text-xs leading-5 theme-text;
}

.activity-entry-output code {
  @apply whitespace-pre font-mono;
}
</style>
