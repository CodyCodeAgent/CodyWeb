import { listCatalog } from '../catalogStore.js'
import { NotificationDispatcher } from '../notificationDispatchService.js'
import { handleDailyTokenUsage, handleListCodexSessionEvents, handleListCodexWorkspaceSessions, summarizeGlobalDailyTokenUsage } from '../sessionEventStore.js'
import {
  handleApplyPatchToWorkspaceWorktree, handleApplyWorkspaceWorkflowImplementation, handleCaptureWorkspacePreviewScreenshot,
  handleCommitStagedWorkspaceChanges, handleCreateWorkspacePullRequest, handleCreateToolingCheckpoint,
  handleCreateWorkspaceWorktree, handleDefaultWorkspace, handleDiscardWorkspaceWorkflowImplementation,
  handleGetWorkspaceWorkflowDeliveryDraft, handleGetWorkspaceWorkflowReplay, handleListApprovalGrants,
  handleListTerminalSessions, handleListToolingCheckpoints, handleListWorkspaceAuditEvents,
  handleListWorkspaceFiles, handleListWorkspaceReviewComments, handleListWorkspaceValidationRuns,
  handleListWorkspaceWorkflows, handleListWorkspaceWorktrees, handleMarkWorkspaceWorkflowMerged,
  handleMarkWorkspaceWorkflowReadyToMerge, handleProbeWorkspacePreview, handleCreateWorkspaceReviewComment,
  handleCreateWorkspaceReviewFollowUp, handleReadToolingCheckpointPatch, handleReadWorkspaceAsset,
  handleReadWorkspaceFile, handleRemoveWorkspaceWorktree, handleRevokeApprovalGrant, handleRollbackToolingFile,
  handleSearchWorkspace,
  handleRollbackToolingHunk, handleRollbackToolingWorkspace, handleRunWorkspaceScript, handleStageToolingHunk,
  handleStageWorkspaceGitPaths, handleStartTerminalSession, handleStopTerminalSession,
  handleToolingDiff, handleUnstageWorkspaceGitPaths, handleUpdateWorkspaceReviewCommentStatus,
  handleWorkspaceGitDeliveryDraft, handleWorkspaceGitStatus, handleWorkspacePorts,
  handleWorkspacePullRequestDraft, handleWorkspaceReviewDraft, handleWorkspaceSecuritySnapshot,
  handleWorkspaceSnapshot, handleWriteWorkspaceFile,
} from '../toolingService.js'
import { asRecord, readJsonBody, setJson, type DomainRoute, type DomainRouteContext } from './httpRoute.js'

type ToolingRouteDependencies = {
  checkpointHealth: (context: DomainRouteContext) => Promise<void>
  createWorkflow: (context: DomainRouteContext) => Promise<void>
  updateWorkflowAgentStatus: (context: DomainRouteContext) => Promise<void>
  provisionWorkflowAgentWorktree: (context: DomainRouteContext) => Promise<void>
  runWorkflowValidation: (context: DomainRouteContext) => Promise<void>
}

type DirectHandler = (context: DomainRouteContext) => Promise<void>
const fromUrl = (handler: (url: URL, res: DomainRouteContext['res']) => Promise<void>): DirectHandler => ({ url, res }) => handler(url, res)
const fromRequest = (handler: (req: DomainRouteContext['req'], res: DomainRouteContext['res']) => Promise<void>): DirectHandler => ({ req, res }) => handler(req, res)

const directRoutes: Record<string, DirectHandler> = {
  'GET /codex-api/tooling/diff': fromUrl(handleToolingDiff),
  'GET /codex-api/tooling/workspace-snapshot': fromUrl(handleWorkspaceSnapshot),
  'GET /codex-api/tooling/workspace-security': fromUrl(handleWorkspaceSecuritySnapshot),
  'GET /codex-api/tooling/git-status': fromUrl(handleWorkspaceGitStatus),
  'GET /codex-api/tooling/git-delivery-draft': fromUrl(handleWorkspaceGitDeliveryDraft),
  'GET /codex-api/tooling/review-draft': fromUrl(handleWorkspaceReviewDraft),
  'GET /codex-api/tooling/pull-request-draft': fromUrl(handleWorkspacePullRequestDraft),
  'GET /codex-api/tooling/worktrees': fromUrl(handleListWorkspaceWorktrees),
  'GET /codex-api/tooling/ports': fromUrl(handleWorkspacePorts),
  'GET /codex-api/tooling/terminal-sessions': fromUrl(handleListTerminalSessions),
  'GET /codex-api/tooling/validation-runs': fromUrl(handleListWorkspaceValidationRuns),
  'GET /codex-api/tooling/workflows': fromUrl(handleListWorkspaceWorkflows),
  'GET /codex-api/tooling/workflows/replay': fromUrl(handleGetWorkspaceWorkflowReplay),
  'GET /codex-api/tooling/workflows/delivery-draft': fromUrl(handleGetWorkspaceWorkflowDeliveryDraft),
  'GET /codex-api/tooling/workspace-files': fromUrl(handleListWorkspaceFiles),
  'GET /codex-api/tooling/workspace-file': fromUrl(handleReadWorkspaceFile),
  'GET /codex-api/tooling/workspace-search': fromUrl(handleSearchWorkspace),
  'GET /codex-api/tooling/workspace-asset': fromUrl(handleReadWorkspaceAsset),
  'GET /codex-api/tooling/approval-grants': fromUrl(handleListApprovalGrants),
  'GET /codex-api/tooling/checkpoints': fromUrl(handleListToolingCheckpoints),
  'GET /codex-api/tooling/audit-events': fromUrl(handleListWorkspaceAuditEvents),
  'GET /codex-api/tooling/review-comments': fromUrl(handleListWorkspaceReviewComments),
  'GET /codex-api/tooling/checkpoint-patch': fromUrl(handleReadToolingCheckpointPatch),
  'GET /codex-api/tooling/session-events': fromUrl(handleListCodexSessionEvents),
  'GET /codex-api/tooling/recent-sessions': fromUrl(handleListCodexWorkspaceSessions),
  'POST /codex-api/tooling/git-commit': fromRequest(handleCommitStagedWorkspaceChanges),
  'POST /codex-api/tooling/pull-request': fromRequest(handleCreateWorkspacePullRequest),
  'POST /codex-api/tooling/worktrees': fromRequest(handleCreateWorkspaceWorktree),
  'POST /codex-api/tooling/worktrees/remove': fromRequest(handleRemoveWorkspaceWorktree),
  'POST /codex-api/tooling/worktrees/apply-patch': fromRequest(handleApplyPatchToWorkspaceWorktree),
  'POST /codex-api/tooling/preview-probe': fromRequest(handleProbeWorkspacePreview),
  'POST /codex-api/tooling/preview-screenshot': fromRequest(handleCaptureWorkspacePreviewScreenshot),
  'POST /codex-api/tooling/workflows/apply-implementation': fromRequest(handleApplyWorkspaceWorkflowImplementation),
  'POST /codex-api/tooling/workflows/discard-implementation': fromRequest(handleDiscardWorkspaceWorkflowImplementation),
  'POST /codex-api/tooling/workflows/ready-to-merge': fromRequest(handleMarkWorkspaceWorkflowReadyToMerge),
  'POST /codex-api/tooling/workflows/merged': fromRequest(handleMarkWorkspaceWorkflowMerged),
  'POST /codex-api/tooling/terminal-sessions': fromRequest(handleStartTerminalSession),
  'POST /codex-api/tooling/terminal-sessions/stop': fromRequest(handleStopTerminalSession),
  'POST /codex-api/tooling/git-stage': fromRequest(handleStageWorkspaceGitPaths),
  'POST /codex-api/tooling/git-unstage': fromRequest(handleUnstageWorkspaceGitPaths),
  'POST /codex-api/tooling/workspace-file': fromRequest(handleWriteWorkspaceFile),
  'POST /codex-api/tooling/workspace-script/run': fromRequest(handleRunWorkspaceScript),
  'POST /codex-api/tooling/approval-grants/revoke': fromRequest(handleRevokeApprovalGrant),
  'POST /codex-api/tooling/checkpoints': fromRequest(handleCreateToolingCheckpoint),
  'POST /codex-api/tooling/rollback-file': fromRequest(handleRollbackToolingFile),
  'POST /codex-api/tooling/rollback-workspace': fromRequest(handleRollbackToolingWorkspace),
  'POST /codex-api/tooling/rollback-hunk': fromRequest(handleRollbackToolingHunk),
  'POST /codex-api/tooling/stage-hunk': fromRequest(handleStageToolingHunk),
  'POST /codex-api/tooling/review-comments': fromRequest(handleCreateWorkspaceReviewComment),
  'POST /codex-api/tooling/review-comments/status': fromRequest(handleUpdateWorkspaceReviewCommentStatus),
  'POST /codex-api/tooling/review-comments/follow-up': fromRequest(handleCreateWorkspaceReviewFollowUp),
}

export function createWorkspaceToolingRoutes(dependencies: ToolingRouteDependencies): DomainRoute {
  return async (context) => {
    const { req, res, url } = context
    const key = `${req.method ?? ''} ${url.pathname}`
    const direct = directRoutes[key]
    if (direct) { await direct(context); return true }
    if (key === 'GET /codex-api/tooling/default-workspace') { await handleDefaultWorkspace(res); return true }
    if (key === 'GET /codex-api/tooling/checkpoint-health') { await dependencies.checkpointHealth(context); return true }
    if (key === 'POST /codex-api/tooling/workflows') { await dependencies.createWorkflow(context); return true }
    if (key === 'POST /codex-api/tooling/workflows/agent-status') { await dependencies.updateWorkflowAgentStatus(context); return true }
    if (key === 'POST /codex-api/tooling/workflows/agent-worktree') { await dependencies.provisionWorkflowAgentWorktree(context); return true }
    if (key === 'POST /codex-api/tooling/workflows/validation-run') { await dependencies.runWorkflowValidation(context); return true }
    if (key === 'POST /codex-api/tooling/notifications/test') {
      const body = asRecord(await readJsonBody(req)); const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
      if (!cwd) setJson(res, 400, { error: 'cwd is required' })
      else setJson(res, 200, { result: await new NotificationDispatcher({ workspaceCwd: cwd }).dispatchTestNotification() })
      return true
    }
    if (key === 'GET /codex-api/token-usage/today') {
      if (url.searchParams.get('scope') !== 'global') await handleDailyTokenUsage(url, res)
      else {
        const [visible, hidden] = await Promise.all([listCatalog('visible'), listCatalog('hidden')])
        setJson(res, 200, { result: await summarizeGlobalDailyTokenUsage({
          cwds: [url.searchParams.get('cwd') ?? '', ...visible.projects.map((p) => p.cwd), ...hidden.projects.map((p) => p.cwd)],
          date: url.searchParams.get('date') ?? undefined,
          timezoneOffsetMinutes: Number(url.searchParams.get('timezoneOffsetMinutes') ?? '0'),
        }) })
      }
      return true
    }
    return false
  }
}
