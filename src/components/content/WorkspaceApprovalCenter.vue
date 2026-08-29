<template>
  <section class="workspace-approval-center" aria-label="Workspace approval center" data-testid="workspace-approval-center">
    <header class="workspace-approval-center-header">
      <div>
        <h3 class="workspace-approval-center-title">Approval Center</h3>
        <p class="workspace-approval-center-subtitle">{{ summaryText }}</p>
      </div>
      <span class="workspace-approval-center-badge" :data-tone="badgeTone" data-testid="workspace-approval-center-badge">
        {{ pendingRequests.length }}
      </span>
    </header>

    <ul v-if="approvalCards.length > 0" class="workspace-approval-center-list">
      <li
        v-for="card in approvalCards"
        :key="card.request.id"
        class="workspace-approval-center-card"
        :data-risk="card.summary.level"
        data-testid="workspace-approval-card"
      >
        <div class="workspace-approval-center-main">
          <p class="workspace-approval-center-card-title">{{ card.summary.title }}</p>
          <p class="workspace-approval-center-meta">
            {{ serverRequestMetaLabel({ request: card.request, includeThread: true, timeFormat: 'long' }) }}
          </p>
          <p class="workspace-approval-center-subject">{{ card.summary.subject }}</p>
          <div class="workspace-approval-center-risk-line">
            <span class="workspace-approval-center-risk-badge" :data-level="card.summary.level">
              {{ card.summary.level }}
            </span>
            <span
              v-for="label in card.summary.riskLabels"
              :key="`${card.request.id}:${label}`"
              class="workspace-approval-center-risk-label"
            >
              {{ label }}
            </span>
          </div>
          <p class="workspace-approval-center-description">{{ card.summary.description }}</p>
          <p
            v-if="card.request.commandPolicy"
            class="workspace-approval-center-policy"
            :data-status="card.request.commandPolicy.status"
          >
            policy {{ card.request.commandPolicy.status }}{{ card.request.commandPolicy.matchedPattern ? ` · ${card.request.commandPolicy.matchedPattern}` : '' }} · {{ card.request.commandPolicy.reason }}
          </p>
          <p
            v-if="card.request.fileChangePolicy"
            class="workspace-approval-center-policy"
            :data-status="card.request.fileChangePolicy.status"
          >
            file policy {{ card.request.fileChangePolicy.status }}{{ card.request.fileChangePolicy.matchedPattern ? ` · ${card.request.fileChangePolicy.matchedPattern}` : '' }} · {{ card.request.fileChangePolicy.reason }}
          </p>
          <ul class="workspace-approval-center-impact-list">
            <li v-for="impact in card.summary.impacts" :key="`${card.request.id}:${impact}`">
              {{ impact }}
            </li>
          </ul>
          <div class="workspace-approval-center-scope-line" aria-label="Approval scopes">
            <span
              v-for="scope in approvalScopeOptions"
              :key="`${card.request.id}:${scope.scope}`"
              class="workspace-approval-center-scope"
              :data-enabled="scope.enabled"
              :title="scope.description"
            >
              {{ scope.label }}
            </span>
          </div>
          <p class="workspace-approval-center-recommendation">{{ card.summary.recommendation }}</p>
        </div>

        <div class="workspace-approval-center-actions">
          <button
            v-if="card.request.threadId"
            type="button"
            @click="$emit('selectThread', card.request.threadId)"
          >
            Open
          </button>
          <template v-if="card.isApprovalRequest">
            <button
              v-for="scope in approvalScopeOptions"
              :key="`${card.request.id}:action:${scope.scope}`"
              type="button"
              :data-tone="scope.scope === 'single' ? 'primary' : scope.scope === 'permanent' ? 'danger-soft' : undefined"
              :data-scope="scope.scope"
              data-testid="workspace-approval-scope"
              @click="respondApprovalScope(card.request.id, scope.scope)"
            >
              {{ approvalActionLabel(scope.scope) }}
            </button>
            <button type="button" data-tone="danger" data-testid="workspace-approval-decline" @click="respondApproval(card.request.id, 'decline')">
              Deny and return to agent
            </button>
          </template>
          <template v-else>
            <button type="button" data-tone="primary" data-testid="workspace-request-empty" @click="respondEmptyResult(card.request.id)">
              Empty result
            </button>
            <button type="button" data-tone="danger" data-testid="workspace-request-reject" @click="rejectRequest(card.request.id)">
              Reject
            </button>
          </template>
        </div>
      </li>
    </ul>

    <p v-else class="workspace-approval-center-empty">No pending approvals.</p>

    <section class="workspace-approval-center-grants" aria-label="Stored approval grants">
      <header class="workspace-approval-center-grants-header">
        <div>
          <h4>Stored grants</h4>
          <p>{{ grantSummaryText }}</p>
        </div>
        <button type="button" :disabled="isLoadingGrants || !cwd" @click="loadGrants">
          Refresh
        </button>
      </header>
      <p v-if="grantError" class="workspace-approval-center-error">{{ grantError }}</p>
      <ul v-if="approvalGrants.length > 0" class="workspace-approval-center-grant-list">
        <li v-for="grant in approvalGrants" :key="grant.id" class="workspace-approval-center-grant" :data-scope="grant.scope">
          <div>
            <span>{{ grant.scope }}</span>
            <code>{{ grant.subject }}</code>
            <small>{{ grant.method }} · {{ formatServerRequestTime(grant.createdAtIso, 'long') }}</small>
          </div>
          <button type="button" :disabled="isRevokingGrant === grant.id" @click="revokeGrant(grant.id)">
            Revoke
          </button>
        </li>
      </ul>
      <p v-else class="workspace-approval-center-empty">No stored approval grants.</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fetchApprovalGrants, revokeApprovalGrant } from '../../api/codexGatewayStatusClient'
import {
  APPROVAL_SCOPE_OPTIONS,
  approvalGrantSummaryText,
  buildApprovalDecisionReply,
  buildApprovalScopeReply,
  buildEmptyServerRequestReply,
  buildRejectedServerRequestReply,
  buildServerRequestCards,
  formatServerRequestTime,
  serverRequestApprovalCenterSummary,
  serverRequestBadgeTone,
  serverRequestMetaLabel,
  type ApprovalDecision,
  type ApprovalDecisionScope,
} from '@codycodeagent/cody-web-core/presentation'
import type { UiApprovalGrant, UiServerRequest, UiServerRequestReply } from '../../types/codex'

const props = defineProps<{
  cwd: string
  pendingRequests: UiServerRequest[]
}>()

const emit = defineEmits<{
  respondServerRequest: [payload: UiServerRequestReply]
  selectThread: [threadId: string]
}>()
const approvalScopeOptions = APPROVAL_SCOPE_OPTIONS
const approvalGrants = ref<UiApprovalGrant[]>([])
const isLoadingGrants = ref(false)
const isRevokingGrant = ref('')

function approvalActionLabel(scope: ApprovalDecisionScope): string {
  return ({
    single: 'Allow this once',
    session: 'Allow for this task',
    workspace: 'Trust in this workspace',
    permanent: 'Always allow on this machine',
  } as const)[scope]
}
const grantError = ref('')
const approvalCards = computed(() => buildServerRequestCards(props.pendingRequests))
const badgeTone = computed(() => serverRequestBadgeTone(approvalCards.value))
const summaryText = computed(() => serverRequestApprovalCenterSummary(approvalCards.value))
const grantSummaryText = computed(() => approvalGrantSummaryText(props.cwd, approvalGrants.value))

function respondApproval(requestId: number, decision: ApprovalDecision): void {
  emit('respondServerRequest', buildApprovalDecisionReply(requestId, decision))
}

function respondApprovalScope(requestId: number, scope: ApprovalDecisionScope): void {
  emit('respondServerRequest', buildApprovalScopeReply(requestId, scope))
}

function respondEmptyResult(requestId: number): void {
  emit('respondServerRequest', buildEmptyServerRequestReply(requestId))
}

function rejectRequest(requestId: number): void {
  emit('respondServerRequest', buildRejectedServerRequestReply(
    requestId,
    'Rejected from CodyWeb approval center.',
  ))
}

async function loadGrants(): Promise<void> {
  if (!props.cwd) return
  isLoadingGrants.value = true
  grantError.value = ''
  try {
    approvalGrants.value = (await fetchApprovalGrants(props.cwd)).grants
  } catch (error) {
    grantError.value = error instanceof Error ? error.message : 'Failed to load approval grants.'
  } finally {
    isLoadingGrants.value = false
  }
}

async function revokeGrant(grantId: string): Promise<void> {
  if (!props.cwd) return
  isRevokingGrant.value = grantId
  grantError.value = ''
  try {
    approvalGrants.value = (await revokeApprovalGrant(props.cwd, grantId)).grants
  } catch (error) {
    grantError.value = error instanceof Error ? error.message : 'Failed to revoke approval grant.'
  } finally {
    isRevokingGrant.value = ''
  }
}

onMounted(() => {
  void loadGrants()
})

watch(() => props.cwd, () => {
  approvalGrants.value = []
  void loadGrants()
})
</script>

<style scoped>
@reference "../../style.css";

.workspace-approval-center {
  @apply rounded-lg border theme-border theme-bg-panel p-3;
}

.workspace-approval-center-header {
  @apply flex items-start justify-between gap-3;
}

.workspace-approval-center-title {
  @apply m-0 text-xs font-semibold uppercase tracking-normal theme-muted;
}

.workspace-approval-center-subtitle {
  @apply m-0 mt-1 text-xs theme-muted;
}

.workspace-approval-center-badge {
  @apply inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md border theme-border-success theme-bg-success-soft px-2 text-sm font-semibold theme-text-success;
}

.workspace-approval-center-badge[data-tone='medium'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.workspace-approval-center-badge[data-tone='high'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.workspace-approval-center-list {
  @apply m-0 mt-2 grid list-none gap-2 p-0;
}

.workspace-approval-center-card {
  @apply grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border theme-border theme-bg-subtle p-2;
}

.workspace-approval-center-card[data-risk='medium'] {
  @apply theme-border-warning theme-bg-warning-soft;
}

.workspace-approval-center-card[data-risk='high'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.workspace-approval-center-main {
  @apply min-w-0;
}

.workspace-approval-center-card-title,
.workspace-approval-center-subject,
.workspace-approval-center-description,
.workspace-approval-center-recommendation,
.workspace-approval-center-meta {
  @apply m-0;
}

.workspace-approval-center-card-title {
  @apply text-xs font-semibold theme-text;
}

.workspace-approval-center-meta {
  @apply mt-0.5 truncate font-mono text-[0.68rem] theme-muted;
}

.workspace-approval-center-subject {
  @apply mt-1 break-words font-mono text-xs theme-text;
}

.workspace-approval-center-risk-line {
  @apply mt-1 flex flex-wrap gap-1.5;
}

.workspace-approval-center-risk-badge,
.workspace-approval-center-risk-label {
  @apply rounded-full border theme-border theme-bg-panel px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-normal theme-muted;
}

.workspace-approval-center-risk-badge[data-level='medium'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.workspace-approval-center-risk-badge[data-level='high'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.workspace-approval-center-description,
.workspace-approval-center-policy,
.workspace-approval-center-recommendation {
  @apply mt-1 text-xs leading-4 theme-muted;
}

.workspace-approval-center-policy {
  @apply rounded-md border theme-border theme-bg-panel px-2 py-1 font-mono text-[0.68rem] theme-muted;
}

.workspace-approval-center-policy[data-status='allowed'] {
  @apply theme-border-success theme-bg-success-soft theme-text-success;
}

.workspace-approval-center-policy[data-status='denied'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger;
}

.workspace-approval-center-policy[data-status='not_configured'],
.workspace-approval-center-policy[data-status='not_git_workspace'] {
  @apply theme-border-warning theme-bg-warning-soft theme-text-warning;
}

.workspace-approval-center-impact-list {
  @apply m-0 mt-1 grid list-disc gap-0.5 pl-4 text-xs leading-4 theme-muted;
}

.workspace-approval-center-scope-line {
  @apply mt-2 flex flex-wrap gap-1.5;
}

.workspace-approval-center-scope {
  @apply rounded-md border theme-border-info theme-bg-info-soft px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-normal theme-text-info;
}

.workspace-approval-center-scope[data-enabled='false'] {
  @apply theme-border theme-bg-control theme-muted;
}

.workspace-approval-center-actions {
  @apply flex w-32 shrink-0 flex-col gap-1.5;
}

.workspace-approval-center-actions button {
  @apply inline-flex h-7 items-center justify-center rounded-md border theme-border theme-bg-panel px-2 text-[0.68rem] font-semibold theme-muted transition hover:theme-bg-control;
}

.workspace-approval-center-actions button[data-tone='primary'] {
  @apply theme-border-info theme-bg-accent theme-on-accent hover:bg-blue-700;
}

.workspace-approval-center-actions button[data-tone='danger'] {
  @apply theme-border-danger theme-bg-panel theme-text-danger hover:theme-bg-danger-soft;
}

.workspace-approval-center-actions button[data-tone='danger-soft'] {
  @apply theme-border-danger theme-bg-danger-soft theme-text-danger hover:theme-bg-danger-soft;
}

.workspace-approval-center-grants {
  @apply mt-3 border-t theme-border pt-3;
}

.workspace-approval-center-grants-header {
  @apply flex items-start justify-between gap-3;
}

.workspace-approval-center-grants-header h4,
.workspace-approval-center-grants-header p {
  @apply m-0;
}

.workspace-approval-center-grants-header h4 {
  @apply text-xs font-semibold uppercase tracking-normal theme-muted;
}

.workspace-approval-center-grants-header p {
  @apply mt-1 text-xs theme-muted;
}

.workspace-approval-center-grants-header button,
.workspace-approval-center-grant button {
  @apply inline-flex h-7 items-center justify-center rounded-md border theme-border theme-bg-panel px-2 text-[0.68rem] font-semibold theme-muted transition hover:theme-bg-control disabled:cursor-not-allowed disabled:opacity-60;
}

.workspace-approval-center-error {
  @apply m-0 mt-2 rounded-md border theme-border-danger theme-bg-danger-soft px-2 py-1.5 text-xs theme-text-danger;
}

.workspace-approval-center-grant-list {
  @apply m-0 mt-2 grid list-none gap-2 p-0;
}

.workspace-approval-center-grant {
  @apply flex items-start justify-between gap-2 rounded-md border theme-border theme-bg-subtle p-2;
}

.workspace-approval-center-grant[data-scope='permanent'] {
  @apply theme-border-danger theme-bg-danger-soft;
}

.workspace-approval-center-grant div {
  @apply min-w-0;
}

.workspace-approval-center-grant span {
  @apply inline-flex rounded-full border theme-border-info theme-bg-info-soft px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase theme-text-info;
}

.workspace-approval-center-grant[data-scope='permanent'] span {
  @apply theme-border-danger theme-bg-panel theme-text-danger;
}

.workspace-approval-center-grant code {
  @apply mt-1 block truncate font-mono text-xs theme-text;
}

.workspace-approval-center-grant small {
  @apply mt-0.5 block truncate text-[0.68rem] theme-muted;
}

.workspace-approval-center-empty {
  @apply m-0 mt-2 rounded-md border border-dashed theme-border px-3 py-2 text-xs theme-muted;
}

@media (max-width: 760px) {
  .workspace-approval-center-card {
    @apply grid-cols-1;
  }

  .workspace-approval-center-actions {
    @apply w-full flex-row flex-wrap;
  }
}
</style>
