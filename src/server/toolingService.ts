import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileException } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import { access, appendFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { cwd as getProcessCwd } from 'node:process'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { parseValidationOutputSummary, type ValidationCoverageSummary, type ValidationTestSummary } from '../utils/validationSummary.js'
import { runControlledProcess } from './controlledProcess.js'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 25 * 1024 * 1024
const MAX_WORKSPACE_FILE_BYTES = 512 * 1024
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 200
const MAX_WORKSPACE_SEARCH_RESULTS = 200
const MAX_WORKSPACE_SEARCH_FILES = 4_000
const MAX_WORKSPACE_SEARCH_PREVIEW = 320
const MAX_WORKSPACE_SCRIPT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_PROBE_BYTES = 768 * 1024
const MAX_PREVIEW_SCREENSHOT_BYTES = 5 * 1024 * 1024
const MAX_WORKSPACE_ASSET_BYTES = 10 * 1024 * 1024
const MAX_PROJECT_CONTEXT_SOURCE_BYTES = 16 * 1024
const MAX_PROJECT_CONTEXT_SOURCES = 24
const PREVIEW_PROBE_TIMEOUT_MS = 10_000
const PREVIEW_SCREENSHOT_TIMEOUT_MS = 20_000
const WORKSPACE_SCRIPT_TIMEOUT_MS = 120_000
const MAX_LISTENING_PORTS = 80
const MAX_TERMINAL_SESSION_OUTPUT_BYTES = 128 * 1024
const MAX_CHECKPOINT_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024
const MAX_CHECKPOINT_UNTRACKED_BYTES = 512 * 1024 * 1024
const MAX_CHECKPOINT_REPOSITORY_BYTES = 2 * 1024 * 1024 * 1024
const MIN_CHECKPOINT_FREE_BYTES = 1024 * 1024 * 1024
const MAX_RETAINED_CHECKPOINTS = 20
const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CHECKPOINT_SCAN_TIMEOUT_MS = 20_000
const checkpointQueueByRepository = new Map<string, Promise<void>>()
const CHECKPOINT_PRUNE_BACKOFF_BASE_MS = 30_000
const CHECKPOINT_PRUNE_BACKOFF_MAX_MS = 5 * 60_000
const checkpointPruneBackoffByPath = new Map<string, { failureCount: number; retryAtMs: number }>()
const CHECKPOINT_PRUNE_SCAN_MAX_ENTRIES = 10_000
const DEFAULT_CHECKPOINT_EXCLUDED_NAMES = new Set([
  '.git', '.tmp-go', '.tmp-go-mod', '.tmp-go-cache', '.cache', '.gradle', '.m2',
  'node_modules', 'dist', 'dist-cli', 'build', 'coverage', 'target', 'vendor',
  '__pycache__', '.venv', 'venv',
])
const HIDDEN_WORKSPACE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-cli',
  '.next',
  '.nuxt',
  'coverage',
])
const DEFAULT_SENSITIVE_PATH_PATTERNS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '*.pem',
  '**/*.pem',
  '*.key',
  '**/*.key',
  'id_rsa',
  '**/id_rsa',
  'id_dsa',
  '**/id_dsa',
  'id_ed25519',
  '**/id_ed25519',
]
const WORKSPACE_IGNORE_FILES = ['.aiignore', '.gitignore']
const SECURITY_SECRET_PATTERNS: Array<{
  id: string
  title: string
  expression: RegExp
}> = [
  {
    id: 'aws-access-key',
    title: 'AWS access key',
    expression: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/u,
  },
  {
    id: 'github-token',
    title: 'GitHub token',
    expression: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/u,
  },
  {
    id: 'slack-token',
    title: 'Slack token',
    expression: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/u,
  },
  {
    id: 'private-key',
    title: 'Private key material',
    expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    id: 'credential-assignment',
    title: 'Credential assignment',
    expression: /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s]{12,}/iu,
  },
]
const SECURITY_HIGH_RISK_PATH_PATTERNS = [
  /(^|\/)(auth|authentication|authorization|permission|permissions|rbac|acl)(\/|\.|-|_)/iu,
  /(^|\/)(payment|payments|billing|checkout|stripe|paypal)(\/|\.|-|_)/iu,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum)$/iu,
]

export type ToolingCheckpoint = {
  id: string
  label: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  paths: string[]
  patchPath: string
  patchBytes: number
  hasPatch: boolean
  untrackedBytes?: number
  skippedUntrackedPaths?: string[]
  partial?: boolean
  pruneFailedCheckpointIds?: string[]
}

export type ToolingCheckpointHealth = {
  cwd: string
  repoRoot: string
  checkpointRoot: string
  generatedAtIso: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  rootWritable: boolean
  checkpointCount: number
  knownBytes: number
  unknownSizeCheckpointIds: string[]
  blockedCheckpointIds: string[]
  scanError: string
}

export type ToolingDiffSnapshot = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  status: string
  patch: string
}

export type ToolingRollbackFileResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  checkpoint: ToolingCheckpoint
  rollbackApplied: boolean
  remainingStatus: string
}

export type ToolingRollbackHunkResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  hunkIndex: number
  hunkHeader: string
  checkpoint: ToolingCheckpoint
  rollbackApplied: boolean
  remainingStatus: string
}

export type ToolingRollbackWorkspaceResult = {
  cwd: string
  repoRoot: string
  checkpoint: ToolingCheckpoint
  rollbackApplied: boolean
  restoredFileCount: number
  removedUntrackedCount: number
  remainingStatus: ToolingGitStatusSnapshot
}

export type ToolingStageHunkResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  hunkIndex: number
  hunkHeader: string
  status: ToolingGitStatusSnapshot
}

export type ToolingCheckpointPatch = {
  checkpoint: ToolingCheckpoint
  patch: string
}

export type ToolingAuditSeverity = 'info' | 'success' | 'warning' | 'danger'

export type ToolingAuditEvent = {
  id: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  actor: 'local-user' | 'system'
  kind: string
  severity: ToolingAuditSeverity
  title: string
  summary: string
  metadata: Record<string, unknown>
}

export type ToolingAuditTrail = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  events: ToolingAuditEvent[]
  truncated: boolean
}

export type ToolingApprovalDecisionScope = 'single' | 'session' | 'workspace' | 'permanent'

export type ToolingApprovalDecisionAuditInput = {
  cwd?: string
  requestId: number
  method: string
  subject: string
  receivedAtIso: string
  resolvedAtIso: string
  threadId: string
  turnId: string
  itemId: string
  decision: string
  scope: ToolingApprovalDecisionScope
  mode: 'manual' | 'automatic'
  errorMessage: string
}

export type ToolingApprovalGrant = {
  id: string
  cwd: string
  repoRoot: string
  scope: Extract<ToolingApprovalDecisionScope, 'workspace' | 'permanent'>
  method: string
  subject: string
  key: string
  decision: 'accept'
  createdAtIso: string
  threadId: string
  turnId: string
  itemId: string
  sourceRequestId: number
}

export type ToolingApprovalGrantList = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  grants: ToolingApprovalGrant[]
}

export type ToolingCommandPolicyEvaluationStatus = 'allowed' | 'denied' | 'not_configured' | 'not_git_workspace'

export type ToolingCommandPolicyEvaluation = {
  status: ToolingCommandPolicyEvaluationStatus
  cwd: string
  repoRoot: string
  command: string
  checkedValues: string[]
  allowPatterns: string[]
  denyPatterns: string[]
  matchedPattern: string
  reason: string
}

export type ToolingFileChangePolicyEvaluationStatus = 'allowed' | 'denied' | 'not_git_workspace'

export type ToolingFileChangePolicyEvaluation = {
  status: ToolingFileChangePolicyEvaluationStatus
  cwd: string
  repoRoot: string
  grantRoot: string
  relativePath: string
  sandboxMode: ToolingWorkspaceConfig['sandboxMode']
  category: 'workspace' | 'outside_workspace' | 'sensitive' | 'ignored' | 'read_only' | 'missing_grant_root' | 'not_git_workspace'
  matchedPattern: string
  reason: string
}

type ApprovalGrantLogRow =
  | {
      recordKind: 'grant'
      grant: ToolingApprovalGrant
    }
  | {
      recordKind: 'revoke'
      grantId: string
      revokedAtIso: string
      cwd: string
      repoRoot: string
      scope: ToolingApprovalGrant['scope']
    }

export type ToolingWorkspaceStatusFile = {
  path: string
  status: string
  indexStatus: string
  worktreeStatus: string
}

export type ToolingGitStatusSnapshot = {
  cwd: string
  repoRoot: string
  branch: string
  upstream: string
  generatedAtIso: string
  stagedFileCount: number
  unstagedFileCount: number
  untrackedFileCount: number
  conflictedFileCount: number
  files: ToolingWorkspaceStatusFile[]
}

export type ToolingGitPathActionResult = {
  cwd: string
  repoRoot: string
  action: 'stage' | 'unstage'
  paths: string[]
  status: ToolingGitStatusSnapshot
}

export type ToolingGitDeliveryFile = {
  path: string
  status: string
  insertions: number | null
  deletions: number | null
}

export type ToolingGitDeliveryDraft = {
  cwd: string
  repoRoot: string
  branch: string
  upstream: string
  generatedAtIso: string
  hasStagedChanges: boolean
  files: ToolingGitDeliveryFile[]
  fileCount: number
  insertions: number
  deletions: number
  stat: string
  commitMessage: string
  prBody: string
  riskSummary: string[]
  validationPlan: string[]
}

export type ToolingWorkspaceReviewDraft = ToolingGitDeliveryDraft & {
  source: 'workspace_diff'
  hasReviewChanges: boolean
  untrackedFiles: string[]
  warnings: string[]
}

export type ToolingGitCommitResult = {
  cwd: string
  repoRoot: string
  branch: string
  commitHash: string
  commitMessage: string
  committedAtIso: string
  draft: ToolingGitDeliveryDraft
  status: ToolingGitStatusSnapshot
}

export type ToolingPullRequestDraft = {
  cwd: string
  repoRoot: string
  branch: string
  baseBranch: string
  remote: string
  generatedAtIso: string
  commitCount: number
  commits: string[]
  files: ToolingGitDeliveryFile[]
  fileCount: number
  insertions: number
  deletions: number
  title: string
  body: string
  warnings: string[]
}

export type ToolingPullRequestCreateResult = {
  cwd: string
  repoRoot: string
  branch: string
  baseBranch: string
  title: string
  body: string
  draft: boolean
  dryRun: boolean
  command: string[]
  url: string
  stdout: string
  stderr: string
  createdAtIso: string
}

export type ToolingWorktree = {
  path: string
  branch: string
  head: string
  detached: boolean
  bare: boolean
  prunable: boolean
  prunableReason: string
  isCurrent: boolean
  isManaged: boolean
}

export type ToolingWorktreeSnapshot = {
  cwd: string
  repoRoot: string
  managedRoot: string
  generatedAtIso: string
  worktrees: ToolingWorktree[]
  warnings: string[]
}

export type ToolingWorktreeCreateResult = {
  worktree: ToolingWorktree
  snapshot: ToolingWorktreeSnapshot
}

export type ToolingWorktreeRemoveResult = {
  removedPath: string
  snapshot: ToolingWorktreeSnapshot
}

export type ToolingWorktreeApplyPatchResult = {
  worktree: ToolingWorktree
  snapshot: ToolingWorktreeSnapshot
  targetStatus: ToolingGitStatusSnapshot
  patchBytes: number
  appliedAtIso: string
}

export type ToolingWorkflowAppliedImplementation = {
  agentId: string
  agentName: string
  branchName: string | null
  worktreePath: string
  appliedAtIso: string
  patchBytes: number
  changedFileCount: number
  checkpointId: string
}

export type ToolingWorkflowDiscardedImplementation = {
  agentId: string
  agentName: string
  branchName: string | null
  worktreePath: string | null
  discardedAtIso: string
  reason: string
}

export type ToolingWorkflowDeliveryState = {
  readyToMergeAtIso: string | null
  mergedAtIso: string | null
  commitHash: string | null
  pullRequestUrl: string | null
  note: string
}

export type ToolingWorkspaceSnapshot = {
  cwd: string
  repoRoot: string
  isGitRepo: boolean
  branch: string
  upstream: string
  generatedAtIso: string
  gitStatus: {
    dirtyFileCount: number
    stagedFileCount: number
    unstagedFileCount: number
    untrackedFileCount: number
    conflictedFileCount: number
    files: ToolingWorkspaceStatusFile[]
  }
  packageManager: string
  scripts: Array<{ name: string; command: string }>
  validationPlan: ToolingWorkspaceValidationPlan
  projectContext: ToolingWorkspaceProjectContext
  workspaceConfig: ToolingWorkspaceConfig
  configFiles: {
    codyWebUi: boolean
    agents: boolean
    aiIgnore: boolean
    gitIgnore: boolean
  }
  warnings: string[]
}

export type ToolingWorkspaceSecurityFinding = {
  id: string
  severity: 'info' | 'warning' | 'danger'
  category: 'secret' | 'sensitive_path' | 'high_risk_file'
  title: string
  summary: string
  path: string
  lineNumber: number | null
  source: 'unstaged_diff' | 'staged_diff' | 'untracked_file' | 'workspace_policy'
  evidence: string
}

export type ToolingWorkspaceSecuritySnapshot = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  findings: ToolingWorkspaceSecurityFinding[]
  secretFindingCount: number
  sensitivePathFindingCount: number
  highRiskFileCount: number
  warnings: string[]
}

export type ToolingWorkspaceKnownPort = {
  name: string
  port: number
  url: string | null
  required: boolean
}

export type ToolingWorkspaceValidationCommand = {
  name: string
  command: string
}

export type ToolingValidationPlanKind =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'preview'
  | 'browser_smoke'
  | 'screenshot'
  | 'manual'

export type ToolingValidationPlanItem = {
  id: string
  kind: ToolingValidationPlanKind
  title: string
  priority: 'required' | 'recommended' | 'optional'
  source: 'workspace_config' | 'package_script' | 'workspace_port' | 'inferred'
  status: 'ready' | 'covered' | 'failed' | 'blocked' | 'manual'
  command: string
  scriptName: string | null
  targetUrl: string | null
  reason: string
  evidence: {
    status: ToolingWorkspaceScriptRun['status'] | 'missing' | 'manual' | 'not_applicable'
    runAtIso: string | null
    durationMs: number | null
    exitCode: number | null
    problemCount: number
    testSummary: ValidationTestSummary | null
    coverageSummary: ValidationCoverageSummary | null
  }
}

export type ToolingWorkspaceValidationPlan = {
  generatedAtIso: string
  items: ToolingValidationPlanItem[]
  requiredCount: number
  recommendedCount: number
  optionalCount: number
  coveredCount: number
  failedCount: number
  missingEvidenceCount: number
}

export type ToolingWorkspaceContextKind =
  | 'agents'
  | 'codex_config'
  | 'cody_web_ui'
  | 'ai_ignore'
  | 'git_ignore'
  | 'local_skill'
  | 'mcp_config'
  | 'custom_rules'

export type ToolingWorkspaceContextSource = {
  id: string
  kind: ToolingWorkspaceContextKind
  title: string
  path: string
  present: boolean
  bytes: number
  excerpt: string
  truncated: boolean
  summary: string
}

export type ToolingWorkspaceProjectContext = {
  generatedAtIso: string
  sources: ToolingWorkspaceContextSource[]
  presentCount: number
  warnings: string[]
}

export type ToolingWorkspaceNotificationEvent =
  | 'task_started'
  | 'approval_required'
  | 'user_input_required'
  | 'command_failed'
  | 'test_failed'
  | 'task_failed'
  | 'task_completed'
  | 'ready_for_review'
  | 'security_risk'
  | 'rate_limit'
  | 'token_budget'

export type ToolingWorkspaceNotificationChannelType = 'webhook' | 'slack' | 'lark'

export type ToolingWorkspaceNotificationChannel = {
  name: string
  type: ToolingWorkspaceNotificationChannelType
  enabled: boolean
  events: ToolingWorkspaceNotificationEvent[]
  target: string
}

export type ToolingWorkspaceNotificationConfig = {
  enabled: boolean
  events: ToolingWorkspaceNotificationEvent[]
  channels: ToolingWorkspaceNotificationChannel[]
}

export type ToolingWorkspaceNotificationDispatchChannel = ToolingWorkspaceNotificationChannel & {
  url: string
}

export type ToolingWorkspaceNotificationDispatchConfig = {
  enabled: boolean
  events: ToolingWorkspaceNotificationEvent[]
  channels: ToolingWorkspaceNotificationDispatchChannel[]
  warnings: string[]
}

export type ToolingWorkspaceConfig = {
  path: string | null
  loaded: boolean
  errors: string[]
  trust: 'trusted' | 'untrusted' | 'unknown'
  sandboxMode: 'read-only' | 'workspace-write' | 'danger' | 'unknown'
  approvalPolicy: string
  defaultModel: string
  reasoningEffort: string
  collaborationMode: string
  commandPolicy: {
    allow: string[]
    deny: string[]
  }
  validationCommands: ToolingWorkspaceValidationCommand[]
  knownPorts: ToolingWorkspaceKnownPort[]
  portPolicy: ToolingPortPolicyConfig
  notifications: ToolingWorkspaceNotificationConfig
  theme: {
    skinId: string
    accentColor: string
    density: 'compact' | 'comfortable' | 'spacious' | ''
    layoutPresetId: 'chat-focus' | 'review-focus' | 'ops-dashboard' | 'ide-mode' | 'mobile-review' | ''
    followSystem: boolean | null
  }
  sensitivePaths: string[]
  ignorePatterns: string[]
}

export type ToolingWorkspaceFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file'
  sizeBytes: number
  modifiedAtIso: string
}

export type ToolingWorkspaceFileList = {
  cwd: string
  root: string
  path: string
  parentPath: string
  entries: ToolingWorkspaceFileEntry[]
  truncated: boolean
}

export type ToolingWorkspaceFileContent = {
  cwd: string
  root: string
  path: string
  name: string
  sizeBytes: number
  modifiedAtIso: string
  content: string
  truncated: boolean
  isBinary: boolean
}

export type ToolingWorkspaceSearchScope = 'files' | 'content'

export type ToolingWorkspaceSearchItem = {
  path: string
  line: number | null
  column: number | null
  preview: string
}

export type ToolingWorkspaceSearchResult = {
  cwd: string
  root: string
  query: string
  scope: ToolingWorkspaceSearchScope
  path: string
  items: ToolingWorkspaceSearchItem[]
  truncated: boolean
}

export type ToolingWorkspaceFileWriteResult = {
  file: ToolingWorkspaceFileContent
  checkpoint: ToolingCheckpoint
}

export type ToolingWorkspaceProblem = {
  id: string
  severity: 'error' | 'warning' | 'info'
  source: string
  message: string
  filePath: string
  line: number | null
  column: number | null
  command: string
  rawLine: string
}

export type ToolingWorkspaceScriptRun = {
  cwd: string
  repoRoot: string
  packageManager: string
  scriptName: string
  command: string
  status: 'passed' | 'failed' | 'timed_out'
  exitCode: number | null
  signal: string | null
  startedAtIso: string
  endedAtIso: string
  durationMs: number
  stdout: string
  stderr: string
  output: string
  truncated: boolean
  problems: ToolingWorkspaceProblem[]
  testSummary: ValidationTestSummary | null
  coverageSummary: ValidationCoverageSummary | null
}

export type ToolingWorkspaceValidationRunHistory = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  runs: ToolingWorkspaceScriptRun[]
  truncated: boolean
}

export type ToolingDefaultWorkspace = {
  cwd: string
  label: string
}

export type ToolingPortExposure = 'loopback' | 'wildcard' | 'external'

export type ToolingListeningPort = {
  protocol: 'tcp'
  host: string
  port: number
  address: string
  processName: string
  pid: number
  url: string
  exposure: ToolingPortExposure
  policy: ToolingPortPolicyEvaluation
}

export type ToolingPortsSnapshot = {
  cwd: string
  root: string
  generatedAtIso: string
  ports: ToolingListeningPort[]
  knownPorts: ToolingWorkspaceKnownPort[]
  policy: ToolingPortPolicyConfig
  warnings: string[]
}

export type ToolingPortPolicyConfig = {
  allow: string[]
  deny: string[]
  allowExternal: boolean
  allowWildcard: boolean
}

export type ToolingPortPolicyEvaluationStatus = 'allowed' | 'denied' | 'not_configured'

export type ToolingPortPolicyEvaluation = {
  status: ToolingPortPolicyEvaluationStatus
  severity: ToolingAuditSeverity
  port: number
  exposure: ToolingPortExposure
  matchedRule: string
  reason: string
}

export type ToolingPreviewProbe = {
  cwd: string
  root: string
  url: string
  requestedAtIso: string
  durationMs: number
  status: 'passed' | 'failed'
  statusCode: number | null
  statusText: string
  contentType: string
  title: string
  bodyPreview: string
  bytesRead: number
  truncated: boolean
  errorMessage: string
  warnings: string[]
}

export type ToolingPreviewScreenshot = {
  cwd: string
  root: string
  url: string
  capturedAtIso: string
  durationMs: number
  status: 'captured' | 'failed'
  source: 'browser' | 'evidence-card'
  mimeType: 'image/png' | 'image/svg+xml'
  dataUrl: string
  width: number
  height: number
  title: string
  bodyPreview: string
  bytes: number
  errorMessage: string
  warnings: string[]
}

export type ToolingReviewCommentStatus = 'open' | 'follow_up_created' | 'resolved'

export type ToolingReviewCommentAnchor = {
  filePath: string
  hunkHeader: string
  lineKind: 'add' | 'remove' | 'context' | 'meta'
  oldLineNumber: number | null
  newLineNumber: number | null
  lineContent: string
}

export type ToolingReviewComment = {
  id: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  updatedAtIso: string
  author: 'local-user'
  status: ToolingReviewCommentStatus
  body: string
  anchor: ToolingReviewCommentAnchor
  followUpRunId: string | null
}

export type ToolingReviewCommentList = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  comments: ToolingReviewComment[]
}

export type ToolingReviewFollowUpResult = {
  comment: ToolingReviewComment
  workflowRun: ToolingWorkflowRun
}

export type ToolingTerminalSession = {
  id: string
  cwd: string
  root: string
  packageManager: string
  scriptName: string
  command: string
  status: 'running' | 'exited' | 'failed' | 'stopped'
  pid: number | null
  startedAtIso: string
  endedAtIso: string | null
  durationMs: number | null
  exitCode: number | null
  signal: string | null
  output: string
  truncated: boolean
}

export type ToolingTerminalSessionList = {
  cwd: string
  root: string
  generatedAtIso: string
  sessions: ToolingTerminalSession[]
}

export type ToolingWorkflowAgentRole =
  | 'research'
  | 'implementation'
  | 'review'
  | 'test'
  | 'security'
  | 'docs'

export type ToolingWorkflowStepStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'skipped'

export type ToolingWorkflowRunStatus =
  | 'queued'
  | 'planning'
  | 'ready_for_execution'
  | 'running'
  | 'blocked'
  | 'ready_for_review'
  | 'ready_to_merge'
  | 'completed'
  | 'merged'
  | 'failed'
  | 'archived'

export type ToolingWorkflowTemplateStep = {
  id: string
  title: string
  role: ToolingWorkflowAgentRole
  objective: string
  deliverables: string[]
  requiresWorktree: boolean
  dependsOn: string[]
}

export type ToolingWorkflowTemplate = {
  id: string
  name: string
  description: string
  recommendedFor: string[]
  defaultStatus: ToolingWorkflowRunStatus
  validationPlan: string[]
  riskLabels: string[]
  steps: ToolingWorkflowTemplateStep[]
}

export type ToolingWorkflowAgentStep = ToolingWorkflowTemplateStep & {
  status: ToolingWorkflowStepStatus
  agentName: string
  model: string
  reasoningEffort: string
  permissionProfile: 'read-only' | 'workspace-write' | 'danger' | 'unknown'
  worktreePolicy: 'required' | 'recommended' | 'not-needed'
  branchName: string | null
  worktreeStatus: 'not_required' | 'pending' | 'ready' | 'failed' | 'discarded'
  worktreePath: string | null
  worktreeReadyAtIso: string | null
  briefing: string
}

export type ToolingWorkflowImplementationOption = {
  agentId: string
  agentName: string
  agentStatus: ToolingWorkflowStepStatus
  worktreeStatus: ToolingWorkflowAgentStep['worktreeStatus']
  branchName: string | null
  worktreePath: string | null
  comparisonStatus:
    | 'pending_worktree'
    | 'no_changes'
    | 'changes_available'
    | 'validation_missing'
    | 'validation_failed'
    | 'ready_to_merge'
    | 'discarded'
  changedFileCount: number
  committedFileCount: number
  uncommittedFileCount: number
  insertions: number
  deletions: number
  validationStatus: 'missing' | 'passed' | 'failed' | 'unknown'
  validationCommand: string | null
  risks: string[]
  summary: string
}

export type ToolingWorkflowAcceptanceGateStatus =
  | 'pending_worktree'
  | 'waiting_for_agents'
  | 'waiting_for_validation'
  | 'validation_failed'
  | 'ready_for_review'
  | 'accepted'
  | 'blocked'

export type ToolingWorkflowAcceptanceGate = {
  status: ToolingWorkflowAcceptanceGateStatus
  label: string
  summary: string
  validationStatus: ToolingWorkflowImplementationOption['validationStatus']
  validationCommand: string | null
  requiredValidationCount: number
  completedAgentCount: number
  totalAgentCount: number
  readyImplementationOptionCount: number
  totalImplementationOptionCount: number
  risks: string[]
}

export type ToolingWorkflowRun = {
  id: string
  cwd: string
  repoRoot: string
  templateId: string
  templateName: string
  goal: string
  status: ToolingWorkflowRunStatus
  createdAtIso: string
  updatedAtIso: string
  branch: string
  dirtyFileCount: number
  agents: ToolingWorkflowAgentStep[]
  validationPlan: string[]
  riskLabels: string[]
  warnings: string[]
  summary: string
  implementationOptions?: ToolingWorkflowImplementationOption[]
  acceptance?: ToolingWorkflowAcceptanceGate
  appliedImplementation?: ToolingWorkflowAppliedImplementation
  discardedImplementations?: ToolingWorkflowDiscardedImplementation[]
  deliveryState?: ToolingWorkflowDeliveryState
}

export type ToolingWorkflowDashboard = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  templates: ToolingWorkflowTemplate[]
  runs: ToolingWorkflowRun[]
  truncated: boolean
}

export type ToolingWorkflowReplayEvent = {
  id: string
  createdAtIso: string
  kind: string
  severity: ToolingAuditSeverity
  title: string
  summary: string
  agentId: string | null
  agentName: string | null
  metadata: Record<string, unknown>
}

export type ToolingWorkflowReplay = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  run: ToolingWorkflowRun
  events: ToolingWorkflowReplayEvent[]
  agentSnapshots: Array<{
    id: string
    agentName: string
    role: ToolingWorkflowAgentRole
    status: ToolingWorkflowStepStatus
    worktreeStatus: ToolingWorkflowAgentStep['worktreeStatus']
    branchName: string | null
    worktreePath: string | null
  }>
  validationEvidence: {
    totalRuns: number
    matchedRuns: number
    latestStatus: ToolingWorkspaceScriptRun['status'] | null
    latestCommand: string | null
    latestEndedAtIso: string | null
  }
  evidenceSummary: string[]
}

export type ToolingWorkflowValidationResult = {
  run: ToolingWorkflowRun
  validationRun: ToolingWorkspaceScriptRun
  replay: ToolingWorkflowReplay
}

export type ToolingWorkflowImplementationApplyResult = {
  run: ToolingWorkflowRun
  appliedImplementation: ToolingWorkflowAppliedImplementation
  checkpoint: ToolingCheckpoint
  targetStatus: ToolingGitStatusSnapshot
}

export type ToolingWorkflowImplementationDiscardResult = {
  run: ToolingWorkflowRun
  discardedImplementation: ToolingWorkflowDiscardedImplementation
  removedWorktreePath: string | null
}

export type ToolingWorkflowDeliveryDraft = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  runId: string
  templateName: string
  goal: string
  status: ToolingWorkflowRunStatus
  title: string
  body: string
  commitMessage: string
  reviewDraft: ToolingWorkspaceReviewDraft
  acceptance: ToolingWorkflowAcceptanceGate | null
  appliedImplementation: ToolingWorkflowAppliedImplementation | null
  discardedImplementations: ToolingWorkflowDiscardedImplementation[]
  validationEvidence: ToolingWorkflowReplay['validationEvidence']
  riskSummary: string[]
  warnings: string[]
}

export type ToolingWorkflowDeliveryStatusResult = {
  run: ToolingWorkflowRun
  deliveryState: ToolingWorkflowDeliveryState
}

type GitWorkspace = {
  cwd: string
  repoRoot: string
  gitCommonDir: string
}

type WorkspaceRoot = {
  cwd: string
  root: string
}

type PorcelainEntry = {
  status: string
  path: string
}

type RollbackFileRequest = {
  cwd?: unknown
  filePath?: unknown
  label?: unknown
}

type RollbackHunkRequest = {
  cwd?: unknown
  filePath?: unknown
  hunkIndex?: unknown
  label?: unknown
}

type RollbackWorkspaceRequest = {
  cwd?: unknown
  label?: unknown
}

type StageHunkRequest = {
  cwd?: unknown
  filePath?: unknown
  hunkIndex?: unknown
}

type CheckpointRequest = {
  cwd?: unknown
  label?: unknown
  paths?: unknown
}

type WorkspaceFileWriteRequest = {
  cwd?: unknown
  path?: unknown
  content?: unknown
}

type WorkspaceScriptRunRequest = {
  cwd?: unknown
  scriptName?: unknown
}

type GitPathActionRequest = {
  cwd?: unknown
  paths?: unknown
}

type GitCommitRequest = {
  cwd?: unknown
  commitMessage?: unknown
}

type PullRequestCreateRequest = {
  cwd?: unknown
  title?: unknown
  body?: unknown
  baseBranch?: unknown
  draft?: unknown
  dryRun?: unknown
}

type WorktreeCreateRequest = {
  cwd?: unknown
  branchName?: unknown
  baseRef?: unknown
}

type WorktreeRemoveRequest = {
  cwd?: unknown
  path?: unknown
}

type WorktreeApplyPatchRequest = {
  cwd?: unknown
  path?: unknown
}

type WorkflowImplementationApplyRequest = {
  cwd?: unknown
  runId?: unknown
  agentId?: unknown
}

type WorkflowImplementationDiscardRequest = {
  cwd?: unknown
  runId?: unknown
  agentId?: unknown
  reason?: unknown
}

type WorkflowDeliveryStatusRequest = {
  cwd?: unknown
  runId?: unknown
  commitHash?: unknown
  pullRequestUrl?: unknown
  note?: unknown
}

type TerminalSessionStartRequest = {
  cwd?: unknown
  scriptName?: unknown
}

type PreviewProbeRequest = {
  cwd?: unknown
  url?: unknown
}

type PreviewScreenshotRequest = {
  cwd?: unknown
  url?: unknown
  width?: unknown
  height?: unknown
}

type ReviewCommentCreateRequest = {
  cwd?: unknown
  body?: unknown
  anchor?: unknown
}

type ReviewCommentStatusRequest = {
  cwd?: unknown
  commentId?: unknown
  status?: unknown
}

type ReviewFollowUpRequest = {
  cwd?: unknown
  commentId?: unknown
}

type TerminalSessionStopRequest = {
  cwd?: unknown
  sessionId?: unknown
}

type WorkflowCreateRequest = {
  cwd?: unknown
  templateId?: unknown
  goal?: unknown
}

type WorkflowAgentStatusRequest = {
  cwd?: unknown
  runId?: unknown
  agentId?: unknown
  status?: unknown
  note?: unknown
}

type WorkflowAgentWorktreeRequest = {
  cwd?: unknown
  runId?: unknown
  agentId?: unknown
  baseRef?: unknown
}

type WorkflowValidationRunRequest = {
  cwd?: unknown
  runId?: unknown
  scriptName?: unknown
}

type WorkspaceTarget = {
  absolutePath: string
  relativePath: string
}

type WorkspacePathProtection = {
  isBlocked: boolean
  category: 'sensitive' | 'ignored'
  pattern: string
  reason: string
}

type WorkspacePathProtectionPolicy = {
  sensitivePatterns: string[]
  ignorePatterns: string[]
}

type TerminalSessionRecord = {
  session: ToolingTerminalSession
  process: ChildProcessWithoutNullStreams | null
}

const TERMINAL_SESSIONS_KEY = '__codyWebUiLocalTerminalSessions__'

function terminalSessionStore(): Map<string, TerminalSessionRecord> {
  const globalScope = globalThis as typeof globalThis & {
    [TERMINAL_SESSIONS_KEY]?: Map<string, TerminalSessionRecord>
  }
  if (!globalScope[TERMINAL_SESSIONS_KEY]) {
    globalScope[TERMINAL_SESSIONS_KEY] = new Map()
  }
  return globalScope[TERMINAL_SESSIONS_KEY]
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) return null
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return null
  return JSON.parse(raw) as unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function assertPackageScriptName(value: string): string {
  const scriptName = value.trim()
  if (!scriptName) throw new Error('scriptName is required')
  if (scriptName.length > 120 || /[\r\n\0]/u.test(scriptName)) {
    throw new Error('scriptName is invalid')
  }
  return scriptName
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await runControlledProcess({
    command: 'git',
    args,
    cwd,
    timeoutMs: 15_000,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  })
  return result.stdout
}

async function runCommandOptional(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const result = await runControlledProcess({
      command,
      args,
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    })
    return result.stdout
  } catch {
    return ''
  }
}

async function runGitOptional(args: string[], cwd: string): Promise<string> {
  try {
    return await runGit(args, cwd)
  } catch {
    return ''
  }
}

function runCommandWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return runControlledProcess({
    command,
    args,
    cwd,
    input,
    timeoutMs: 20_000,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }))
}

function isInside(parent: string, child: string): boolean {
  const diff = relative(parent, child)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}

async function getGitWorkspace(cwd: string): Promise<GitWorkspace> {
  const requestedCwd = cwd.trim()
  if (!requestedCwd) {
    throw new Error('cwd is required')
  }

  const resolvedCwd = await realpath(resolve(requestedCwd))
  const cwdStat = await stat(resolvedCwd)
  if (!cwdStat.isDirectory()) {
    throw new Error('cwd must be a directory')
  }

  const repoRoot = (await runGit(['rev-parse', '--show-toplevel'], resolvedCwd)).trim()
  const gitCommonDirRaw = (await runGit(['rev-parse', '--git-common-dir'], resolvedCwd)).trim()
  const gitCommonDir = isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : resolve(repoRoot, gitCommonDirRaw)

  if (!isInside(repoRoot, resolvedCwd)) {
    throw new Error('cwd is outside the git workspace root')
  }

  return {
    cwd: resolvedCwd,
    repoRoot,
    gitCommonDir,
  }
}

async function getWorkspaceRoot(cwd: string): Promise<WorkspaceRoot> {
  const requestedCwd = cwd.trim()
  if (!requestedCwd) throw new Error('cwd is required')

  const resolvedCwd = await realpath(resolve(requestedCwd))
  const cwdStat = await stat(resolvedCwd)
  if (!cwdStat.isDirectory()) throw new Error('cwd must be a directory')

  try {
    const workspace = await getGitWorkspace(resolvedCwd)
    return {
      cwd: resolvedCwd,
      root: workspace.repoRoot,
    }
  } catch {
    return {
      cwd: resolvedCwd,
      root: resolvedCwd,
    }
  }
}

export async function getDefaultWorkspace(): Promise<ToolingDefaultWorkspace> {
  const cwd = await realpath(getProcessCwd())
  return {
    cwd,
    label: cwd.split(sep).filter(Boolean).at(-1) ?? cwd,
  }
}

function checkpointRoot(workspace: GitWorkspace): string {
  return join(workspace.gitCommonDir, 'cody-web-ui-checkpoints')
}

function auditRoot(workspace: GitWorkspace): string {
  return join(workspace.gitCommonDir, 'cody-web-ui-audit')
}

function auditLogPath(workspace: GitWorkspace): string {
  return join(auditRoot(workspace), 'events.jsonl')
}

function validationRunsPath(workspace: GitWorkspace): string {
  return join(auditRoot(workspace), 'validation-runs.jsonl')
}

function reviewCommentsPath(workspace: GitWorkspace): string {
  return join(auditRoot(workspace), 'review-comments.jsonl')
}

function workspaceApprovalGrantsPath(workspace: GitWorkspace): string {
  return join(auditRoot(workspace), 'approval-grants.jsonl')
}

function permanentApprovalGrantsRoot(): string {
  return join(homedir(), '.cody-web-ui')
}

function permanentApprovalGrantsPath(): string {
  return join(permanentApprovalGrantsRoot(), 'approval-grants.jsonl')
}

function workflowRunsRoot(workspace: GitWorkspace): string {
  return join(auditRoot(workspace), 'workflow-runs')
}

function sanitizeCheckpointId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '-')
}

function assertCheckpointId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('checkpointId is required')
  }
  if (trimmed !== sanitizeCheckpointId(trimmed) || trimmed.includes('..')) {
    throw new Error('checkpointId is invalid')
  }
  return trimmed
}

function normalizeWorkspacePath(workspace: GitWorkspace, filePath: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) throw new Error('filePath is required')

  const absolutePath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(workspace.repoRoot, trimmed)

  if (!isInside(workspace.repoRoot, absolutePath)) {
    throw new Error('filePath must stay inside the git workspace root')
  }

  const relativePath = relative(workspace.repoRoot, absolutePath)
  if (!relativePath || relativePath.split(sep).includes('..')) {
    throw new Error('filePath must point to a file inside the git workspace')
  }

  return relativePath.split(sep).join('/')
}

function normalizeWorkspaceTarget(root: string, targetPath: string | null | undefined): WorkspaceTarget {
  const trimmed = targetPath?.trim() ?? ''
  const absolutePath = trimmed
    ? (isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed))
    : root

  if (!isInside(root, absolutePath)) {
    throw new Error('path must stay inside the workspace root')
  }

  const relativePath = relative(root, absolutePath).split(sep).join('/')
  if (relativePath.split('/').includes('..')) {
    throw new Error('path must stay inside the workspace root')
  }

  return {
    absolutePath,
    relativePath,
  }
}

function normalizeWorkspacePattern(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
}

function readIgnorePatternsFromContent(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\/+/u, ''))
    .filter(Boolean)
}

async function readWorkspaceIgnoreFilePatterns(root: string): Promise<string[]> {
  const patterns: string[] = []
  for (const fileName of WORKSPACE_IGNORE_FILES) {
    try {
      patterns.push(...readIgnorePatternsFromContent(await readFile(join(root, fileName), 'utf8')))
    } catch {
      // Missing ignore files are fine; workspace warnings cover absent .aiignore.
    }
  }
  return patterns
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
}

function globPatternToRegex(pattern: string): RegExp {
  let regex = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        regex += '.*'
        index += 1
      } else {
        regex += '[^/]*'
      }
    } else {
      regex += escapeRegex(char)
    }
  }
  return new RegExp(`^${regex}$`, 'u')
}

function pathMatchesWorkspacePattern(relativePath: string, rawPattern: string): boolean {
  const path = relativePath.replace(/\\/gu, '/').replace(/^\/+/u, '')
  const pattern = normalizeWorkspacePattern(rawPattern)
  if (!pattern) return false

  const directoryPattern = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern.endsWith('/') ? pattern.slice(0, -1) : ''
  if (directoryPattern && (path === directoryPattern || path.startsWith(`${directoryPattern}/`))) return true

  const candidates = pattern.includes('/')
    ? [path]
    : [path.split('/').at(-1) ?? path, path]
  return candidates.some((candidate) => globPatternToRegex(pattern).test(candidate))
}

async function readWorkspacePathProtectionPolicy(root: string): Promise<WorkspacePathProtectionPolicy> {
  const config = await readWorkspaceConfig(root)
  const sensitivePatterns = [
    ...DEFAULT_SENSITIVE_PATH_PATTERNS,
    ...config.sensitivePaths,
  ].map(normalizeWorkspacePattern).filter(Boolean)
  const ignorePatterns = [
    ...config.ignorePatterns,
    ...(await readWorkspaceIgnoreFilePatterns(root)),
  ].map(normalizeWorkspacePattern).filter(Boolean)

  return {
    sensitivePatterns: sensitivePatterns.filter((pattern, index, all) => all.indexOf(pattern) === index),
    ignorePatterns: ignorePatterns.filter((pattern, index, all) => all.indexOf(pattern) === index),
  }
}

function checkWorkspacePathProtection(
  policy: WorkspacePathProtectionPolicy,
  relativePath: string,
): WorkspacePathProtection | null {
  for (const pattern of policy.sensitivePatterns) {
    if (pathMatchesWorkspacePattern(relativePath, pattern)) {
      return {
        isBlocked: true,
        category: 'sensitive',
        pattern,
        reason: `Path is protected by sensitive path policy (${pattern})`,
      }
    }
  }
  for (const pattern of policy.ignorePatterns) {
    if (pathMatchesWorkspacePattern(relativePath, pattern)) {
      return {
        isBlocked: true,
        category: 'ignored',
        pattern,
        reason: `Path is hidden by workspace ignore policy (${pattern})`,
      }
    }
  }
  return null
}

async function assertWorkspaceTargetAllowed(root: string, relativePath: string): Promise<void> {
  const protection = checkWorkspacePathProtection(await readWorkspacePathProtectionPolicy(root), relativePath)
  if (protection) throw new Error(protection.reason)
}

function parsePorcelainZ(value: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  const parts = value.split('\0').filter(Boolean)

  for (let index = 0; index < parts.length; index += 1) {
    const row = parts[index] ?? ''
    if (row.length < 4) continue

    const status = row.slice(0, 2)
    const path = row.slice(3)
    entries.push({ status, path })

    if (status.includes('R') || status.includes('C')) {
      index += 1
    }
  }

  return entries
}

function statusFileFromPorcelainEntry(entry: PorcelainEntry): ToolingWorkspaceStatusFile {
  const indexStatus = entry.status.slice(0, 1).trim()
  const worktreeStatus = entry.status.slice(1, 2).trim()
  return {
    path: entry.path,
    status: entry.status,
    indexStatus,
    worktreeStatus,
  }
}

function isToolingAuditEvent(value: unknown): value is ToolingAuditEvent {
  const row = asRecord(value)
  if (!row) return false
  return (
    typeof row.id === 'string' &&
    typeof row.cwd === 'string' &&
    typeof row.repoRoot === 'string' &&
    typeof row.createdAtIso === 'string' &&
    (row.actor === 'local-user' || row.actor === 'system') &&
    typeof row.kind === 'string' &&
    typeof row.title === 'string' &&
    typeof row.summary === 'string' &&
    ['info', 'success', 'warning', 'danger'].includes(String(row.severity)) &&
    asRecord(row.metadata) !== null
  )
}

function normalizeApprovalGrantSubject(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function buildApprovalGrantKey(method: string, subject: string): string {
  return `${method.trim()}\n${normalizeApprovalGrantSubject(subject)}`
}

function isToolingApprovalGrant(value: unknown): value is ToolingApprovalGrant {
  const row = asRecord(value)
  return Boolean(
    row &&
      typeof row.id === 'string' &&
      typeof row.cwd === 'string' &&
      typeof row.repoRoot === 'string' &&
      (row.scope === 'workspace' || row.scope === 'permanent') &&
      typeof row.method === 'string' &&
      typeof row.subject === 'string' &&
      typeof row.key === 'string' &&
      row.decision === 'accept' &&
      typeof row.createdAtIso === 'string' &&
      typeof row.threadId === 'string' &&
      typeof row.turnId === 'string' &&
      typeof row.itemId === 'string' &&
      typeof row.sourceRequestId === 'number',
  )
}

function isApprovalGrantLogRow(value: unknown): value is ApprovalGrantLogRow {
  const row = asRecord(value)
  if (!row) return false
  if (row.recordKind === 'grant') return isToolingApprovalGrant(row.grant)
  return (
    row.recordKind === 'revoke' &&
    typeof row.grantId === 'string' &&
    typeof row.revokedAtIso === 'string' &&
    typeof row.cwd === 'string' &&
    typeof row.repoRoot === 'string' &&
    (row.scope === 'workspace' || row.scope === 'permanent')
  )
}

async function readApprovalGrantLogRows(path: string): Promise<ApprovalGrantLogRow[]> {
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }

  const rows: ApprovalGrantLogRow[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isApprovalGrantLogRow(parsed)) rows.push(parsed)
    } catch {
      // Ignore malformed rows; valid later grants remain usable.
    }
  }
  return rows
}

function activeApprovalGrantsFromRows(rows: ApprovalGrantLogRow[]): ToolingApprovalGrant[] {
  const grants = new Map<string, ToolingApprovalGrant>()
  const revoked = new Set<string>()
  for (const row of rows) {
    if (row.recordKind === 'grant') {
      grants.set(row.grant.id, row.grant)
      continue
    }
    revoked.add(row.grantId)
    grants.delete(row.grantId)
  }
  return Array.from(grants.values()).filter((grant) => !revoked.has(grant.id))
}

async function appendApprovalGrantRow(scope: ToolingApprovalGrant['scope'], workspace: GitWorkspace | null, row: ApprovalGrantLogRow): Promise<void> {
  const root = scope === 'workspace' && workspace ? auditRoot(workspace) : permanentApprovalGrantsRoot()
  const path = scope === 'workspace' && workspace ? workspaceApprovalGrantsPath(workspace) : permanentApprovalGrantsPath()
  await mkdir(root, { recursive: true })
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8')
}

async function appendWorkspaceAuditEvent(
  workspace: GitWorkspace,
  event: Omit<ToolingAuditEvent, 'id' | 'cwd' | 'repoRoot' | 'createdAtIso' | 'actor'> & {
    actor?: ToolingAuditEvent['actor']
  },
): Promise<void> {
  try {
    const createdAtIso = new Date().toISOString()
    const row: ToolingAuditEvent = {
      id: randomUUID(),
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      createdAtIso,
      actor: event.actor ?? 'local-user',
      kind: event.kind,
      severity: event.severity,
      title: event.title,
      summary: event.summary,
      metadata: event.metadata,
    }

    await mkdir(auditRoot(workspace), { recursive: true })
    await appendFile(auditLogPath(workspace), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    // Audit logging must never make the underlying workspace action fail.
  }
}

function isApprovalDecisionAccepted(decision: string, errorMessage: string): boolean {
  if (errorMessage.trim().length > 0) return false
  return decision === 'accept' || decision === 'acceptForSession' || decision === 'approved' || decision === 'responded'
}

function approvalDecisionSeverity(
  decision: string,
  scope: ToolingApprovalDecisionScope,
  errorMessage: string,
): ToolingAuditSeverity {
  if (!isApprovalDecisionAccepted(decision, errorMessage)) return 'warning'
  if (scope === 'permanent') return 'danger'
  if (scope === 'workspace') return 'warning'
  return 'success'
}

export async function recordApprovalDecisionAuditEvent(input: ToolingApprovalDecisionAuditInput): Promise<void> {
  const cwd = input.cwd?.trim() || getProcessCwd()

  try {
    const workspace = await getGitWorkspace(cwd)
    const accepted = isApprovalDecisionAccepted(input.decision, input.errorMessage)
    const subject = input.subject || input.method
    const summary = accepted
      ? `${input.method} approved for ${input.scope} scope.`
      : `${input.method} resolved as ${input.decision || 'rejected'}.`

    await appendWorkspaceAuditEvent(workspace, {
      kind: 'approval.decision',
      severity: approvalDecisionSeverity(input.decision, input.scope, input.errorMessage),
      title: accepted ? 'Approval granted' : 'Approval rejected',
      summary,
      metadata: {
        requestId: input.requestId,
        method: input.method,
        subject,
        scope: input.scope,
        decision: input.decision,
        mode: input.mode,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        receivedAtIso: input.receivedAtIso,
        resolvedAtIso: input.resolvedAtIso,
        errorMessage: input.errorMessage,
      },
    })
  } catch {
    // Approval responses must not fail because their audit trail is unavailable.
  }
}

export async function createPersistentApprovalGrant(input: ToolingApprovalDecisionAuditInput): Promise<ToolingApprovalGrant | null> {
  if (!isApprovalDecisionAccepted(input.decision, input.errorMessage)) return null
  if (input.scope !== 'workspace' && input.scope !== 'permanent') return null

  const cwd = input.cwd?.trim() || getProcessCwd()
  let workspace: GitWorkspace | null = null
  let resolvedCwd = cwd
  let repoRoot = ''

  try {
    workspace = await getGitWorkspace(cwd)
    resolvedCwd = workspace.cwd
    repoRoot = workspace.repoRoot
  } catch {
    if (input.scope === 'workspace') return null
    try {
      resolvedCwd = await realpath(resolve(cwd))
    } catch {
      resolvedCwd = cwd
    }
  }

  const grant: ToolingApprovalGrant = {
    id: randomUUID(),
    cwd: resolvedCwd,
    repoRoot,
    scope: input.scope,
    method: input.method,
    subject: normalizeApprovalGrantSubject(input.subject || input.method),
    key: buildApprovalGrantKey(input.method, input.subject || input.method),
    decision: 'accept',
    createdAtIso: input.resolvedAtIso || new Date().toISOString(),
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    sourceRequestId: input.requestId,
  }

  try {
    await appendApprovalGrantRow(input.scope, workspace, {
      recordKind: 'grant',
      grant,
    })
    if (workspace) {
      await appendWorkspaceAuditEvent(workspace, {
        kind: 'approval.grant_created',
        severity: input.scope === 'permanent' ? 'danger' : 'warning',
        title: input.scope === 'permanent' ? 'Permanent approval grant created' : 'Workspace approval grant created',
        summary: `${input.method} can be auto-approved for ${input.scope} scope when the subject matches exactly.`,
        metadata: {
          grantId: grant.id,
          method: grant.method,
          subject: grant.subject,
          scope: grant.scope,
          sourceRequestId: grant.sourceRequestId,
          threadId: grant.threadId,
          turnId: grant.turnId,
          itemId: grant.itemId,
        },
      })
    }
    return grant
  } catch {
    return null
  }
}

async function listPermanentApprovalGrants(): Promise<ToolingApprovalGrant[]> {
  return activeApprovalGrantsFromRows(await readApprovalGrantLogRows(permanentApprovalGrantsPath()))
    .filter((grant) => grant.scope === 'permanent')
}

async function listWorkspaceApprovalGrants(workspace: GitWorkspace): Promise<ToolingApprovalGrant[]> {
  return activeApprovalGrantsFromRows(await readApprovalGrantLogRows(workspaceApprovalGrantsPath(workspace)))
    .filter((grant) => grant.scope === 'workspace' && grant.repoRoot === workspace.repoRoot)
}

export async function listApprovalGrants(cwd: string): Promise<ToolingApprovalGrantList> {
  const workspace = await getGitWorkspace(cwd)
  const grants = [
    ...(await listWorkspaceApprovalGrants(workspace)),
    ...(await listPermanentApprovalGrants()),
  ].sort((first, second) => second.createdAtIso.localeCompare(first.createdAtIso))

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    grants,
  }
}

export async function findMatchingApprovalGrant(input: {
  cwd: string
  method: string
  subject: string
}): Promise<ToolingApprovalGrant | null> {
  const key = buildApprovalGrantKey(input.method, input.subject)
  let workspace: GitWorkspace | null = null
  try {
    workspace = await getGitWorkspace(input.cwd)
  } catch {
    workspace = null
  }

  const workspaceGrants = workspace ? await listWorkspaceApprovalGrants(workspace) : []
  const permanentGrants = await listPermanentApprovalGrants()
  return [...workspaceGrants, ...permanentGrants]
    .sort((first, second) => second.createdAtIso.localeCompare(first.createdAtIso))
    .find((grant) => grant.key === key) ?? null
}

export async function recordApprovalGrantUse(input: {
  cwd: string
  grant: ToolingApprovalGrant
  requestId: number
  method: string
  subject: string
  threadId: string
  turnId: string
  itemId: string
}): Promise<void> {
  try {
    const workspace = await getGitWorkspace(input.cwd)
    await appendWorkspaceAuditEvent(workspace, {
      actor: 'system',
      kind: 'approval.grant_used',
      severity: input.grant.scope === 'permanent' ? 'warning' : 'success',
      title: 'Stored approval grant used',
      summary: `${input.method} was auto-approved from a ${input.grant.scope} grant.`,
      metadata: {
        grantId: input.grant.id,
        scope: input.grant.scope,
        requestId: input.requestId,
        method: input.method,
        subject: normalizeApprovalGrantSubject(input.subject),
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
      },
    })
  } catch {
    // Automatic approvals should still proceed if git-backed audit is unavailable.
  }
}

export async function revokeApprovalGrant(params: {
  cwd: string
  grantId: string
}): Promise<ToolingApprovalGrantList> {
  const workspace = await getGitWorkspace(params.cwd)
  const grantId = params.grantId.trim()
  if (!grantId) throw new Error('grantId is required')

  const existing = [
    ...(await listWorkspaceApprovalGrants(workspace)),
    ...(await listPermanentApprovalGrants()),
  ].find((grant) => grant.id === grantId)
  if (!existing) throw new Error('approval grant not found')

  await appendApprovalGrantRow(existing.scope, existing.scope === 'workspace' ? workspace : null, {
    recordKind: 'revoke',
    grantId,
    revokedAtIso: new Date().toISOString(),
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    scope: existing.scope,
  })

  await appendWorkspaceAuditEvent(workspace, {
    kind: 'approval.grant_revoked',
    severity: 'warning',
    title: 'Approval grant revoked',
    summary: `${existing.method} ${existing.scope} approval grant was revoked.`,
    metadata: {
      grantId: existing.id,
      method: existing.method,
      subject: existing.subject,
      scope: existing.scope,
    },
  })

  return listApprovalGrants(params.cwd)
}

function isReviewCommentStatus(value: unknown): value is ToolingReviewCommentStatus {
  return value === 'open' || value === 'follow_up_created' || value === 'resolved'
}

function isReviewCommentLineKind(value: unknown): value is ToolingReviewCommentAnchor['lineKind'] {
  return value === 'add' || value === 'remove' || value === 'context' || value === 'meta'
}

function isToolingReviewComment(value: unknown): value is ToolingReviewComment {
  const row = asRecord(value)
  const anchor = asRecord(row?.anchor)
  return Boolean(
    row &&
      anchor &&
      typeof row.id === 'string' &&
      typeof row.cwd === 'string' &&
      typeof row.repoRoot === 'string' &&
      typeof row.createdAtIso === 'string' &&
      typeof row.updatedAtIso === 'string' &&
      row.author === 'local-user' &&
      isReviewCommentStatus(row.status) &&
      typeof row.body === 'string' &&
      typeof anchor.filePath === 'string' &&
      typeof anchor.hunkHeader === 'string' &&
      isReviewCommentLineKind(anchor.lineKind) &&
      (typeof anchor.oldLineNumber === 'number' || anchor.oldLineNumber === null) &&
      (typeof anchor.newLineNumber === 'number' || anchor.newLineNumber === null) &&
      typeof anchor.lineContent === 'string' &&
      (typeof row.followUpRunId === 'string' || row.followUpRunId === null),
  )
}

function reviewCommentBody(value: string): string {
  const body = value.trim()
  if (!body) throw new Error('comment body is required')
  if (body.length > 4_000) throw new Error('comment body is too long')
  return body
}

function reviewCommentAnchor(value: unknown): ToolingReviewCommentAnchor {
  const row = asRecord(value)
  if (!row) throw new Error('comment anchor is required')
  const filePath = readString(row.filePath)
  const hunkHeader = readString(row.hunkHeader)
  const lineContent = readString(row.lineContent)
  const lineKind = readString(row.lineKind)
  const oldLineNumber = typeof row.oldLineNumber === 'number' && Number.isFinite(row.oldLineNumber) ? row.oldLineNumber : null
  const newLineNumber = typeof row.newLineNumber === 'number' && Number.isFinite(row.newLineNumber) ? row.newLineNumber : null
  if (!filePath) throw new Error('comment filePath is required')
  if (!hunkHeader) throw new Error('comment hunkHeader is required')
  if (!isReviewCommentLineKind(lineKind)) throw new Error('comment lineKind is invalid')
  return {
    filePath,
    hunkHeader,
    lineKind,
    oldLineNumber,
    newLineNumber,
    lineContent: lineContent.slice(0, 1_000),
  }
}

async function readWorkspaceReviewComments(workspace: GitWorkspace): Promise<ToolingReviewComment[]> {
  let raw = ''
  try {
    raw = await readFile(reviewCommentsPath(workspace), 'utf8')
  } catch {
    return []
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      try {
        return JSON.parse(row) as unknown
      } catch {
        return null
      }
    })
    .filter(isToolingReviewComment)
    .filter((comment) => comment.repoRoot === workspace.repoRoot)
}

async function writeWorkspaceReviewComments(
  workspace: GitWorkspace,
  comments: ToolingReviewComment[],
): Promise<void> {
  await mkdir(auditRoot(workspace), { recursive: true })
  const body = comments.map((comment) => JSON.stringify(comment)).join('\n')
  await writeFile(reviewCommentsPath(workspace), body ? `${body}\n` : '', 'utf8')
}

function isToolingWorkspaceScriptRun(value: unknown): value is ToolingWorkspaceScriptRun {
  const row = asRecord(value)
  return Boolean(
    row &&
      typeof row.cwd === 'string' &&
      typeof row.repoRoot === 'string' &&
      typeof row.scriptName === 'string' &&
      typeof row.command === 'string' &&
      ['passed', 'failed', 'timed_out'].includes(String(row.status)) &&
      typeof row.startedAtIso === 'string' &&
      typeof row.endedAtIso === 'string' &&
      typeof row.durationMs === 'number' &&
      typeof row.output === 'string' &&
      Array.isArray(row.problems),
  )
}

async function appendWorkspaceValidationRun(
  workspace: GitWorkspace,
  run: ToolingWorkspaceScriptRun,
): Promise<void> {
  try {
    await mkdir(auditRoot(workspace), { recursive: true })
    await appendFile(validationRunsPath(workspace), `${JSON.stringify(run)}\n`, 'utf8')

    const raw = await readFile(validationRunsPath(workspace), 'utf8')
    const rows = raw.split('\n').filter(Boolean)
    if (rows.length > 100) {
      await writeFile(validationRunsPath(workspace), `${rows.slice(-100).join('\n')}\n`, 'utf8')
    }
  } catch {
    // Validation history should not make the underlying command fail.
  }
}

function isConflictStatus(status: string): boolean {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status)
}

function gitStatusCounts(files: ToolingWorkspaceStatusFile[]): {
  stagedFileCount: number
  unstagedFileCount: number
  untrackedFileCount: number
  conflictedFileCount: number
} {
  return {
    stagedFileCount: files.filter((file) => file.indexStatus.length > 0 && file.status !== '??').length,
    unstagedFileCount: files.filter((file) => file.worktreeStatus.length > 0 && file.status !== '??').length,
    untrackedFileCount: files.filter((file) => file.status === '??').length,
    conflictedFileCount: files.filter((file) => isConflictStatus(file.status)).length,
  }
}

function parseNameStatus(value: string): Array<{ path: string; status: string }> {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t').filter(Boolean)
      const status = parts[0] ?? ''
      const path = parts.at(-1) ?? ''
      return { path, status }
    })
    .filter((entry) => entry.path.length > 0)
}

function parseNumStat(value: string): Map<string, { insertions: number | null; deletions: number | null }> {
  const rows = new Map<string, { insertions: number | null; deletions: number | null }>()
  for (const line of value.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [rawInsertions, rawDeletions] = parts
    const path = parts.slice(2).join('\t').trim()
    if (!path) continue

    rows.set(path, {
      insertions: rawInsertions === '-' ? null : Number(rawInsertions),
      deletions: rawDeletions === '-' ? null : Number(rawDeletions),
    })
  }
  return rows
}

function branchNameFromRef(value: string): string {
  return value.replace(/^refs\/heads\//u, '').trim()
}

export function parseGitWorktreePorcelain(raw: string, currentPath: string, managedRoot: string): ToolingWorktree[] {
  const worktrees: ToolingWorktree[] = []
  let current: Partial<ToolingWorktree> | null = null

  function pushCurrent(): void {
    if (!current?.path) return
    const worktreePath = resolve(current.path)
    worktrees.push({
      path: worktreePath,
      branch: current.branch ?? '',
      head: current.head ?? '',
      detached: Boolean(current.detached),
      bare: Boolean(current.bare),
      prunable: Boolean(current.prunable),
      prunableReason: current.prunableReason ?? '',
      isCurrent: resolve(currentPath) === worktreePath,
      isManaged: isInside(managedRoot, worktreePath),
    })
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      pushCurrent()
      current = null
      continue
    }

    if (line.startsWith('worktree ')) {
      pushCurrent()
      current = {
        path: line.slice('worktree '.length).trim(),
      }
      continue
    }

    if (!current) continue

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = branchNameFromRef(line.slice('branch '.length))
    } else if (line === 'detached') {
      current.detached = true
    } else if (line === 'bare') {
      current.bare = true
    } else if (line.startsWith('prunable')) {
      current.prunable = true
      current.prunableReason = line.slice('prunable'.length).trim()
    }
  }

  pushCurrent()
  return worktrees
}

function managedWorktreeRoot(repoRoot: string): string {
  return resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`)
}

function assertWorktreeBranchName(value: string): string {
  const branchName = value.trim()
  if (!branchName) throw new Error('branchName is required')
  if (
    branchName.length > 120 ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.includes('..') ||
    /[\s~^:?*[\\\0]/u.test(branchName) ||
    branchName.endsWith('.lock')
  ) {
    throw new Error('branchName is invalid')
  }
  return branchName
}

function assertWorktreeBaseRef(value: string | undefined): string {
  const baseRef = value?.trim() || 'HEAD'
  if (
    baseRef.length > 120 ||
    baseRef.startsWith('-') ||
    baseRef.includes('..') ||
    /[\s~^:?*[\\\0]/u.test(baseRef) ||
    baseRef.endsWith('.lock')
  ) {
    throw new Error('baseRef is invalid')
  }
  return baseRef
}

function assertPullRequestBaseBranch(value: string | undefined): string | undefined {
  const branchName = value?.trim().replace(/^refs\/heads\//u, '').replace(/^origin\//u, '') ?? ''
  if (!branchName) return undefined
  if (
    branchName.length > 120 ||
    branchName.startsWith('-') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.includes('..') ||
    /[\s~^:?*[\\\0]/u.test(branchName) ||
    branchName.endsWith('.lock')
  ) {
    throw new Error('baseBranch is invalid')
  }
  return branchName
}

function branchNameToDirectoryName(branchName: string): string {
  return branchName.replace(/[^a-zA-Z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'worktree'
}

type DiffFilePatchParts = {
  headerLines: string[]
  hunks: Array<{
    header: string
    lines: string[]
  }>
  supportsHunkRollback: boolean
}

function parseSingleFilePatchForHunks(patch: string): DiffFilePatchParts {
  const headerLines: string[] = []
  const hunks: Array<{ header: string; lines: string[] }> = []
  const lines = patch.replace(/\r\n/gu, '\n').split('\n')
  let currentHunk: { header: string; lines: string[] } | null = null

  for (const line of lines) {
    if (line.startsWith('@@')) {
      currentHunk = {
        header: line,
        lines: [line],
      }
      hunks.push(currentHunk)
      continue
    }

    if (currentHunk) {
      currentHunk.lines.push(line)
    } else if (line.trim().length > 0) {
      headerLines.push(line)
    }
  }

  const header = headerLines.join('\n')
  const supportsHunkRollback = (
    !header.includes('\nnew file mode ') &&
    !header.includes('\ndeleted file mode ') &&
    !header.includes('\nrename from ') &&
    !header.includes('\nrename to ') &&
    !header.includes('\nBinary files ') &&
    headerLines.some((line) => line.startsWith('--- a/')) &&
    headerLines.some((line) => line.startsWith('+++ b/'))
  )

  return {
    headerLines,
    hunks: hunks.map((hunk) => ({
      header: hunk.header,
      lines: hunk.lines.filter((line, index, all) => index < all.length - 1 || line.length > 0),
    })),
    supportsHunkRollback,
  }
}

function buildSingleHunkPatch(parts: DiffFilePatchParts, hunkIndex: number): {
  header: string
  patch: string
} {
  if (!parts.supportsHunkRollback) {
    throw new Error('Hunk rollback only supports ordinary modified text files')
  }
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= parts.hunks.length) {
    throw new Error('hunkIndex is invalid')
  }

  const hunk = parts.hunks[hunkIndex]
  if (!hunk) throw new Error('hunkIndex is invalid')
  return {
    header: hunk.header,
    patch: `${parts.headerLines.join('\n')}\n${hunk.lines.join('\n')}\n`,
  }
}

function humanizeArea(value: string): string {
  return value
    .replace(/\.[^.]+$/u, '')
    .split(/[/-]/u)
    .filter(Boolean)
    .slice(-2)
    .join(' ')
}

function deliveryAreaForPath(path: string): string {
  if (/^(docs|documentation)\//iu.test(path) || /\.mdx?$/iu.test(path)) return 'docs'
  if (/(^|\/)(test|tests|__tests__)\//iu.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/iu.test(path)) return 'tests'
  if (/^src\/server\//iu.test(path)) return 'server tooling'
  if (/^src\/api\//iu.test(path)) return 'API client'
  if (/^src\/components\//iu.test(path) || /\.(vue|css)$/iu.test(path)) return 'interface'
  if (/^src\/composables\//iu.test(path)) return 'state logic'
  if (/^src\/types\//iu.test(path) || /types?\.ts$/iu.test(path)) return 'types'
  if (/^package(-lock)?\.json$/iu.test(path)) return 'dependencies'
  return humanizeArea(path) || 'workspace'
}

function summarizeDeliveryAreas(files: ToolingGitDeliveryFile[]): string[] {
  const areas: string[] = []
  for (const file of files) {
    const area = deliveryAreaForPath(file.path)
    if (!areas.includes(area)) areas.push(area)
  }
  return areas.slice(0, 4)
}

function buildCommitSubject(files: ToolingGitDeliveryFile[]): string {
  const areas = summarizeDeliveryAreas(files)
  if (areas.length === 0) return 'Update workspace changes'
  if (areas.length === 1) return `Update ${areas[0]}`
  if (areas.length === 2) return `Update ${areas[0]} and ${areas[1]}`
  return `Update ${areas.slice(0, -1).join(', ')}, and ${areas.at(-1)}`
}

function buildRiskSummary(files: ToolingGitDeliveryFile[]): string[] {
  const risks: string[] = []
  if (files.some((file) => /^package(-lock)?\.json$/u.test(file.path))) {
    risks.push('Dependency or lockfile changes require install/build verification.')
  }
  if (files.some((file) => /^src\/server\//u.test(file.path))) {
    risks.push('Server tooling changes can affect local command and git operations.')
  }
  if (files.some((file) => /^src\/api\//u.test(file.path))) {
    risks.push('API client changes can break browser-to-server workflows.')
  }
  if (files.some((file) => /^src\/components\//u.test(file.path) || file.path.endsWith('.vue'))) {
    risks.push('UI changes should be browser-smoke-tested across the affected workflow.')
  }
  if (files.some((file) => file.status.includes('D'))) {
    risks.push('Deleted files require checking imports, routes, and generated artifacts.')
  }
  return risks.length > 0 ? risks : ['No obvious high-risk paths detected from staged file names.']
}

function buildValidationPlan(files: ToolingGitDeliveryFile[]): string[] {
  const plan = ['npm test', 'npm run build']
  if (files.some((file) => /^src\/components\//u.test(file.path) || file.path.endsWith('.vue'))) {
    plan.push('Browser smoke test affected UI flow')
  }
  if (files.some((file) => /^src\/server\//u.test(file.path))) {
    plan.push('Exercise affected tooling API endpoint')
  }
  return plan
}

function normalizeCommitMessage(value: string): string {
  const lines = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))

  while (lines.length > 0 && !lines[0]?.trim()) lines.shift()
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop()

  const normalized = lines.join('\n').trim()
  if (!normalized) throw new Error('commitMessage is required')
  if (normalized.length > 10_000) throw new Error('commitMessage is too long')
  return normalized
}

const BUILT_IN_WORKFLOW_TEMPLATES: ToolingWorkflowTemplate[] = [
  {
    id: 'feature-build',
    name: 'Feature Build',
    description: 'Research, implement, validate, review, and prepare delivery for a scoped feature.',
    recommendedFor: ['new feature', 'refactor', 'cross-file implementation'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Run targeted tests', 'Run full test suite', 'Run build/typecheck', 'Browser smoke test changed UI'],
    riskLabels: ['scope-drift', 'dirty-worktree', 'ui-regression'],
    steps: [
      {
        id: 'research',
        title: 'Research Agent',
        role: 'research',
        objective: 'Inspect code, docs, project rules, recent threads, and validation history before implementation.',
        deliverables: ['implementation plan', 'risk map', 'affected files'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'implementation',
        title: 'Implementation Agent',
        role: 'implementation',
        objective: 'Modify code in an isolated branch/worktree and keep changes scoped to the approved plan.',
        deliverables: ['patch', 'checkpoint', 'changed file summary'],
        requiresWorktree: true,
        dependsOn: ['research'],
      },
      {
        id: 'test',
        title: 'Test Agent',
        role: 'test',
        objective: 'Run relevant validation commands, parse failures, and rerun after fixes.',
        deliverables: ['validation evidence', 'failure summary', 'remaining risk'],
        requiresWorktree: false,
        dependsOn: ['implementation'],
      },
      {
        id: 'review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Review the final diff for correctness, maintainability, and missing tests.',
        deliverables: ['review findings', 'risk summary', 'merge recommendation'],
        requiresWorktree: false,
        dependsOn: ['implementation', 'test'],
      },
      {
        id: 'docs',
        title: 'Docs Agent',
        role: 'docs',
        objective: 'Prepare release notes, PR body, and user-facing summary when the change is ready.',
        deliverables: ['PR body', 'release note bullets', 'final summary'],
        requiresWorktree: false,
        dependsOn: ['review'],
      },
    ],
  },
  {
    id: 'bug-fix',
    name: 'Bug Fix',
    description: 'Reproduce, diagnose, patch, and regression-test a defect.',
    recommendedFor: ['regression', 'failing test', 'runtime bug'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Reproduce failing behavior', 'Run targeted regression test', 'Run related suite', 'Run build/typecheck'],
    riskLabels: ['repro-required', 'regression-risk'],
    steps: [
      {
        id: 'repro',
        title: 'Reproduction Agent',
        role: 'research',
        objective: 'Create or identify a deterministic reproduction and capture current failing evidence.',
        deliverables: ['reproduction steps', 'failing command or screenshot'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'fix',
        title: 'Fix Agent',
        role: 'implementation',
        objective: 'Patch the root cause with the smallest durable change and add regression coverage.',
        deliverables: ['patch', 'regression test', 'checkpoint'],
        requiresWorktree: true,
        dependsOn: ['repro'],
      },
      {
        id: 'verify',
        title: 'Verification Agent',
        role: 'test',
        objective: 'Rerun the reproduction and affected validations, then summarize evidence.',
        deliverables: ['passing reproduction', 'validation evidence'],
        requiresWorktree: false,
        dependsOn: ['fix'],
      },
      {
        id: 'review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Check the fix for side effects, missed edge cases, and test adequacy.',
        deliverables: ['review findings', 'risk summary'],
        requiresWorktree: false,
        dependsOn: ['fix', 'verify'],
      },
    ],
  },
  {
    id: 'parallel-implementation',
    name: 'Parallel Implementation',
    description: 'Run two isolated implementation agents, compare their worktree outputs, then choose the safer direction.',
    recommendedFor: ['architecture choice', 'large refactor', 'uncertain implementation strategy', 'prototype comparison'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Compare implementation worktree diffs', 'Run targeted tests against the selected option', 'Run build/typecheck', 'Review merge risks before applying'],
    riskLabels: ['multi-implementation', 'selective-merge-gate', 'worktree-isolation'],
    steps: [
      {
        id: 'research',
        title: 'Research Agent',
        role: 'research',
        objective: 'Map constraints, acceptance criteria, risky files, and validation needs before parallel work starts.',
        deliverables: ['constraints', 'comparison criteria', 'validation plan'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'implementation-a',
        title: 'Implementation Agent A',
        role: 'implementation',
        objective: 'Build the first viable approach in an isolated worktree and keep the diff reviewable.',
        deliverables: ['patch', 'changed file summary', 'known tradeoffs'],
        requiresWorktree: true,
        dependsOn: ['research'],
      },
      {
        id: 'implementation-b',
        title: 'Implementation Agent B',
        role: 'implementation',
        objective: 'Build an alternate viable approach in an isolated worktree so the user can compare tradeoffs.',
        deliverables: ['patch', 'changed file summary', 'known tradeoffs'],
        requiresWorktree: true,
        dependsOn: ['research'],
      },
      {
        id: 'review',
        title: 'Comparison Reviewer',
        role: 'review',
        objective: 'Compare both implementation options for correctness, maintainability, risk, and validation evidence.',
        deliverables: ['option comparison', 'merge recommendation', 'follow-up risks'],
        requiresWorktree: false,
        dependsOn: ['implementation-a', 'implementation-b'],
      },
      {
        id: 'test',
        title: 'Test Agent',
        role: 'test',
        objective: 'Run the required validation suite against the selected option and record evidence.',
        deliverables: ['validation evidence', 'failure summary', 'remaining risk'],
        requiresWorktree: false,
        dependsOn: ['review'],
      },
    ],
  },
  {
    id: 'review-diff',
    name: 'Review Diff',
    description: 'Review current workspace changes and turn findings into actionable follow-up work.',
    recommendedFor: ['pre-commit review', 'large diff', 'risky files'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Inspect git diff', 'Check validation history', 'Run missing targeted checks if needed'],
    riskLabels: ['review-only', 'human-merge-gate'],
    steps: [
      {
        id: 'diff-review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Read current diff, identify correctness risks, and prioritize actionable findings.',
        deliverables: ['findings', 'file-line references', 'follow-up tasks'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'validation-review',
        title: 'Test Agent',
        role: 'test',
        objective: 'Check whether existing validation evidence covers the diff and list gaps.',
        deliverables: ['coverage assessment', 'missing checks'],
        requiresWorktree: false,
        dependsOn: ['diff-review'],
      },
    ],
  },
  {
    id: 'address-pr-comments',
    name: 'Address PR Comments',
    description: 'Turn pull request review feedback into scoped fixes, validation evidence, and an updated delivery summary.',
    recommendedFor: ['PR review feedback', 'requested changes', 'code review comments'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Collect unresolved PR comments', 'Map comments to affected files', 'Apply scoped fixes', 'Run targeted validation', 'Update PR summary'],
    riskLabels: ['external-review', 'comment-triage', 'merge-readiness'],
    steps: [
      {
        id: 'triage-comments',
        title: 'PR Comment Triage Agent',
        role: 'research',
        objective: 'Read unresolved PR feedback, group actionable comments, and identify files or tests likely affected.',
        deliverables: ['comment map', 'action plan', 'non-actionable notes'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'fix-comments',
        title: 'PR Fix Agent',
        role: 'implementation',
        objective: 'Apply the requested changes in an isolated branch/worktree while keeping fixes tied to review feedback.',
        deliverables: ['patch', 'addressed comment list', 'remaining questions'],
        requiresWorktree: true,
        dependsOn: ['triage-comments'],
      },
      {
        id: 'verify',
        title: 'Verification Agent',
        role: 'test',
        objective: 'Run targeted validation for the addressed comments and capture any remaining failures.',
        deliverables: ['validation evidence', 'failure summary', 'unverified areas'],
        requiresWorktree: false,
        dependsOn: ['fix-comments'],
      },
      {
        id: 'review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Check that each actionable comment was addressed without broadening the diff unnecessarily.',
        deliverables: ['coverage checklist', 'risk summary', 'merge recommendation'],
        requiresWorktree: false,
        dependsOn: ['fix-comments', 'verify'],
      },
      {
        id: 'reply',
        title: 'Docs Agent',
        role: 'docs',
        objective: 'Prepare a concise PR update explaining addressed comments, validation evidence, and any follow-up.',
        deliverables: ['PR reply draft', 'validation summary', 'remaining follow-up'],
        requiresWorktree: false,
        dependsOn: ['review'],
      },
    ],
  },
  {
    id: 'run-tests-and-fix',
    name: 'Run Tests And Fix',
    description: 'Run configured validation commands, diagnose failures, patch, and rerun.',
    recommendedFor: ['red build', 'CI parity', 'post-refactor validation'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Run configured validation commands', 'Parse failures', 'Apply fixes', 'Rerun failed commands'],
    riskLabels: ['test-failure', 'repeat-until-green'],
    steps: [
      {
        id: 'test',
        title: 'Test Agent',
        role: 'test',
        objective: 'Run validation commands and summarize failures with file references.',
        deliverables: ['failure list', 'problem summary', 'raw command evidence'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'fix',
        title: 'Fix Agent',
        role: 'implementation',
        objective: 'Patch root causes from validation failures in an isolated branch/worktree.',
        deliverables: ['patch', 'checkpoint'],
        requiresWorktree: true,
        dependsOn: ['test'],
      },
      {
        id: 'rerun',
        title: 'Regression Agent',
        role: 'test',
        objective: 'Rerun failed commands and report remaining failures or green evidence.',
        deliverables: ['rerun evidence', 'remaining risk'],
        requiresWorktree: false,
        dependsOn: ['fix'],
      },
    ],
  },
  {
    id: 'security-scan',
    name: 'Security Scan',
    description: 'Inspect sensitive paths, dependency changes, auth/payment/permission code, and dangerous commands.',
    recommendedFor: ['auth changes', 'payment changes', 'dependency updates', 'public exposure'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Inspect sensitive file changes', 'Check dependency and lockfile diff', 'Review command and port policy'],
    riskLabels: ['security-review', 'secrets', 'permissions'],
    steps: [
      {
        id: 'security',
        title: 'Security Agent',
        role: 'security',
        objective: 'Audit current workspace state for secrets, unsafe paths, broad permissions, and risky code areas.',
        deliverables: ['security findings', 'risk labels', 'approval recommendations'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Turn security findings into prioritized remediation tasks or approve as low risk.',
        deliverables: ['remediation plan', 'human approval gates'],
        requiresWorktree: false,
        dependsOn: ['security'],
      },
    ],
  },
  {
    id: 'release-notes',
    name: 'Release Notes',
    description: 'Summarize merged or staged work into release notes and delivery artifacts.',
    recommendedFor: ['handoff', 'PR prep', 'changelog'],
    defaultStatus: 'ready_for_execution',
    validationPlan: ['Inspect staged diff or recent commits', 'Check validation history', 'Draft release notes'],
    riskLabels: ['docs-only', 'delivery'],
    steps: [
      {
        id: 'summarize',
        title: 'Docs Agent',
        role: 'docs',
        objective: 'Extract user-visible changes, validation evidence, risks, and migration notes.',
        deliverables: ['release notes', 'PR summary', 'validation summary'],
        requiresWorktree: false,
        dependsOn: [],
      },
      {
        id: 'review',
        title: 'Reviewer Agent',
        role: 'review',
        objective: 'Check the delivery notes against the actual diff or commit history.',
        deliverables: ['accuracy review', 'missing note list'],
        requiresWorktree: false,
        dependsOn: ['summarize'],
      },
    ],
  },
]

function buildPrBody(params: {
  files: ToolingGitDeliveryFile[]
  insertions: number
  deletions: number
  stat: string
  riskSummary: string[]
  validationPlan: string[]
  changeLabel?: string
}): string {
  const areas = summarizeDeliveryAreas(params.files)
  const fileRows = params.files.slice(0, 12).map((file) => `- ${file.status} ${file.path}`)
  const changeLabel = params.changeLabel || 'staged'
  const remainingFiles = params.files.length > fileRows.length
    ? [`- ...and ${String(params.files.length - fileRows.length)} more ${changeLabel} file(s)`]
    : []

  return [
    '## Summary',
    `- Updates ${String(params.files.length)} ${changeLabel} file(s) across ${areas.join(', ') || 'workspace changes'}.`,
    `- Diff size: +${String(params.insertions)} / -${String(params.deletions)}.`,
    '',
    '## Staged Files',
    ...fileRows,
    ...remainingFiles,
    '',
    '## Validation',
    ...params.validationPlan.map((item) => `- [ ] ${item}`),
    '',
    '## Risk',
    ...params.riskSummary.map((item) => `- ${item}`),
    '',
    '## Diff Stat',
    '```text',
    params.stat.trim() || 'No stat available.',
    '```',
  ].join('\n')
}

function normalizePullRequestTitle(value: string): string {
  const title = value.replace(/\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!title) throw new Error('title is required')
  if (title.length > 300) throw new Error('title is too long')
  return title
}

function normalizePullRequestBody(value: string): string {
  const body = value.replace(/\r\n?/gu, '\n').trim()
  if (!body) throw new Error('body is required')
  if (body.length > 60_000) throw new Error('body is too long')
  return body
}

function normalizeOptionalCommitHash(value: string | undefined): string | null {
  const hash = (value ?? '').trim()
  if (!hash) return null
  if (!/^[a-f0-9]{7,64}$/iu.test(hash)) throw new Error('commitHash is invalid')
  return hash
}

function normalizeOptionalPullRequestUrl(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text) return null
  const url = new URL(text)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('pullRequestUrl must be http or https')
  return url.toString()
}

function buildPullRequestBody(params: {
  branch: string
  baseBranch: string
  files: ToolingGitDeliveryFile[]
  insertions: number
  deletions: number
  commits: string[]
  warnings: string[]
}): string {
  const areas = summarizeDeliveryAreas(params.files)
  const risks = params.files.length > 0
    ? buildRiskSummary(params.files)
    : ['No changed files were found against the selected base branch.']
  const validationPlan = params.files.length > 0
    ? buildValidationPlan(params.files)
    : ['Review selected base branch and commit range']
  const fileRows = params.files.slice(0, 16).map((file) => `- ${file.status} ${file.path}`)
  const remainingFiles = params.files.length > fileRows.length
    ? [`- ...and ${String(params.files.length - fileRows.length)} more changed file(s)`]
    : []
  const commitRows = params.commits.slice(0, 12).map((commit) => `- ${commit}`)
  const remainingCommits = params.commits.length > commitRows.length
    ? [`- ...and ${String(params.commits.length - commitRows.length)} more commit(s)`]
    : []
  const warningRows = params.warnings.length > 0
    ? params.warnings.map((warning) => `- ${warning}`)
    : ['- No automated PR warnings.']

  return [
    '## Summary',
    `- Merges ${params.branch || 'current HEAD'} into ${params.baseBranch}.`,
    `- Updates ${String(params.files.length)} file(s) across ${areas.join(', ') || 'workspace changes'}.`,
    `- Diff size: +${String(params.insertions)} / -${String(params.deletions)}.`,
    '',
    '## Commits',
    ...(commitRows.length > 0 ? commitRows : ['- No commits found against the selected base branch.']),
    ...remainingCommits,
    '',
    '## Changed Files',
    ...(fileRows.length > 0 ? fileRows : ['- No file changes found.']),
    ...remainingFiles,
    '',
    '## Validation',
    ...validationPlan.map((item) => `- [ ] ${item}`),
    '',
    '## Risk',
    ...risks.map((item) => `- ${item}`),
    '',
    '## Warnings',
    ...warningRows,
  ].join('\n')
}

function parseLsofAddress(value: string): { host: string; port: number } | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const ipv6Match = trimmed.match(/^\[([^\]]+)\]:(\d+)$/u)
  if (ipv6Match) {
    return {
      host: ipv6Match[1] ?? '',
      port: Number(ipv6Match[2]),
    }
  }

  const separatorIndex = trimmed.lastIndexOf(':')
  if (separatorIndex < 0) return null

  const host = trimmed.slice(0, separatorIndex).trim()
  const port = Number(trimmed.slice(separatorIndex + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null

  return {
    host,
    port,
  }
}

function portExposure(host: string): ToolingPortExposure {
  if (host === '*' || host === '0.0.0.0' || host === '::') return 'wildcard'
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return 'loopback'
  return 'external'
}

function previewUrlForPort(host: string, port: number): string {
  const exposure = portExposure(host)
  if (exposure === 'wildcard') return `http://127.0.0.1:${String(port)}/`
  if (host === '::1') return `http://[::1]:${String(port)}/`
  return `http://${host}:${String(port)}/`
}

function defaultPortPolicyEvaluation(port: number, exposure: ToolingPortExposure): ToolingPortPolicyEvaluation {
  return {
    status: 'not_configured',
    severity: exposure === 'loopback' ? 'info' : 'warning',
    port,
    exposure,
    matchedRule: '',
    reason: exposure === 'loopback'
      ? 'No workspace port policy matched this loopback listener.'
      : 'No workspace port policy matched this exposed listener.',
  }
}

function portRuleMatches(rule: string, port: number): boolean {
  const trimmed = rule.trim()
  if (!trimmed) return false
  if (trimmed === '*') return true

  const rangeMatch = /^(\d{1,5})\s*-\s*(\d{1,5})$/u.exec(trimmed)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = Number(rangeMatch[2])
    return Number.isInteger(start) && Number.isInteger(end) && port >= Math.min(start, end) && port <= Math.max(start, end)
  }

  const value = Number(trimmed)
  return Number.isInteger(value) && value === port
}

export function evaluatePortPolicy(params: {
  config: ToolingPortPolicyConfig
  port: number
  exposure: ToolingPortExposure
}): ToolingPortPolicyEvaluation {
  const denyMatch = params.config.deny.find((rule) => portRuleMatches(rule, params.port))
  if (denyMatch) {
    return {
      status: 'denied',
      severity: 'danger',
      port: params.port,
      exposure: params.exposure,
      matchedRule: `deny:${denyMatch}`,
      reason: `Port ${String(params.port)} is denied by .cody-web-ui.yml ports.policy.deny.`,
    }
  }

  const allowMatch = params.config.allow.find((rule) => portRuleMatches(rule, params.port))
  if (params.config.allow.length > 0 && !allowMatch) {
    return {
      status: 'denied',
      severity: 'warning',
      port: params.port,
      exposure: params.exposure,
      matchedRule: 'allowlist',
      reason: `Port ${String(params.port)} is not listed in .cody-web-ui.yml ports.policy.allow.`,
    }
  }

  if (params.exposure === 'wildcard' && !params.config.allowWildcard) {
    return {
      status: 'denied',
      severity: 'danger',
      port: params.port,
      exposure: params.exposure,
      matchedRule: 'allowWildcard=false',
      reason: `Port ${String(params.port)} listens on all interfaces, but wildcard exposure is disabled.`,
    }
  }

  if (params.exposure === 'external' && !params.config.allowExternal) {
    return {
      status: 'denied',
      severity: 'danger',
      port: params.port,
      exposure: params.exposure,
      matchedRule: 'allowExternal=false',
      reason: `Port ${String(params.port)} listens on a non-loopback address, but external exposure is disabled.`,
    }
  }

  if (allowMatch || params.config.deny.length > 0 || params.config.allowExternal || params.config.allowWildcard) {
    return {
      status: 'allowed',
      severity: 'success',
      port: params.port,
      exposure: params.exposure,
      matchedRule: allowMatch ? `allow:${allowMatch}` : 'default',
      reason: allowMatch
        ? `Port ${String(params.port)} is allowed by .cody-web-ui.yml ports.policy.allow.`
        : `Port ${String(params.port)} is allowed by the workspace port exposure policy.`,
    }
  }

  return defaultPortPolicyEvaluation(params.port, params.exposure)
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true
  if (normalized.startsWith('127.')) return true
  return isIP(normalized) === 6 && normalized === '::1'
}

function normalizePreviewProbeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('url is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https preview URLs can be probed')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('Preview probes are limited to localhost and loopback URLs')
  }
  url.hash = ''
  return url.toString()
}

function extractHtmlTitle(value: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(value)
  return match?.[1]
    ?.replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160) ?? ''
}

function previewText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 600)
}

function normalizePreviewScreenshotDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const normalized = Math.round(value ?? fallback)
  return Math.max(320, Math.min(normalized, 2400))
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next known browser path.
    }
  }

  const fromPath = await runCommandOptional('which', ['google-chrome'], getProcessCwd())
    || await runCommandOptional('which', ['chromium'], getProcessCwd())
    || await runCommandOptional('which', ['chromium-browser'], getProcessCwd())
  return fromPath.trim()
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function wrapSvgText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > maxChars) {
      if (line) lines.push(line)
      line = word
    } else {
      line = next
    }
    if (lines.length >= maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

function previewEvidenceSvg(params: {
  url: string
  title: string
  bodyPreview: string
  width: number
  height: number
  capturedAtIso: string
  warning: string
}): Buffer {
  const title = params.title || 'Preview evidence'
  const bodyLines = wrapSvgText(params.bodyPreview || 'No preview body text captured.', 96, 8)
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(params.width)}" height="${String(params.height)}" viewBox="0 0 ${String(params.width)} ${String(params.height)}">`,
    '<rect width="100%" height="100%" fill="#f8fafc"/>',
    '<rect x="24" y="24" width="calc(100% - 48px)" height="calc(100% - 48px)" rx="12" fill="#ffffff" stroke="#cbd5e1"/>',
    `<text x="48" y="64" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="700" fill="#0f172a">${escapeSvgText(title)}</text>`,
    `<text x="48" y="94" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#475569">${escapeSvgText(params.url)}</text>`,
    `<text x="48" y="124" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" fill="#b45309">${escapeSvgText(params.warning)}</text>`,
    `<text x="48" y="154" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" fill="#64748b">Captured ${escapeSvgText(params.capturedAtIso)}</text>`,
    ...bodyLines.map((line, index) =>
      `<text x="48" y="${String(198 + index * 24)}" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="15" fill="#334155">${escapeSvgText(line)}</text>`
    ),
    '</svg>',
  ].join('')
  return Buffer.from(svg, 'utf8')
}

export function parseLsofListeningPorts(raw: string): ToolingListeningPort[] {
  const ports = new Map<string, ToolingListeningPort>()
  let currentPid = 0
  let currentProcessName = ''
  let currentProtocol = ''

  for (const line of raw.split('\n')) {
    if (line.length < 2) continue
    const field = line.slice(0, 1)
    const value = line.slice(1)

    if (field === 'p') {
      currentPid = Number(value)
      currentProcessName = ''
      currentProtocol = ''
      continue
    }
    if (field === 'c') {
      currentProcessName = value
      continue
    }
    if (field === 'P') {
      currentProtocol = value.toLowerCase()
      continue
    }
    if (field !== 'n' || currentProtocol !== 'tcp' || !Number.isInteger(currentPid)) {
      continue
    }

    const address = parseLsofAddress(value)
    if (!address) continue

    const exposure = portExposure(address.host)
    const key = `${String(currentPid)}:${address.host}:${String(address.port)}`
    ports.set(key, {
      protocol: 'tcp',
      host: address.host,
      port: address.port,
      address: value,
      processName: currentProcessName || 'unknown',
      pid: currentPid,
      url: previewUrlForPort(address.host, address.port),
      exposure,
      policy: defaultPortPolicyEvaluation(address.port, exposure),
    })
  }

  return Array.from(ports.values())
    .sort((first, second) => first.port - second.port || first.processName.localeCompare(second.processName))
    .slice(0, MAX_LISTENING_PORTS)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readPackageScripts(repoRoot: string): Promise<{
  packageManager: string
  scripts: Array<{ name: string; command: string }>
}> {
  const packageJsonPath = join(repoRoot, 'package.json')
  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const row = asRecord(parsed)
    const scripts = asRecord(row?.scripts)
    const packageManager = typeof row?.packageManager === 'string'
      ? row.packageManager
      : await inferPackageManager(repoRoot)

    return {
      packageManager,
      scripts: Object.entries(scripts ?? {})
        .filter(([, command]) => typeof command === 'string')
        .map(([name, command]) => ({ name, command: String(command) }))
        .sort((first, second) => first.name.localeCompare(second.name)),
    }
  } catch {
    return {
      packageManager: await inferPackageManager(repoRoot),
      scripts: [],
    }
  }
}

async function inferPackageManager(repoRoot: string): Promise<string> {
  if (await pathExists(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await pathExists(join(repoRoot, 'yarn.lock'))) return 'yarn'
  if (await pathExists(join(repoRoot, 'bun.lockb')) || await pathExists(join(repoRoot, 'bun.lock'))) return 'bun'
  if (await pathExists(join(repoRoot, 'package-lock.json'))) return 'npm'
  return ''
}

function packageManagerCommand(packageManager: string, scriptName: string): {
  packageManager: string
  executable: string
  args: string[]
  displayCommand: string
} {
  const normalized = packageManager.split('@')[0]?.trim() || 'npm'
  if (normalized === 'pnpm') {
    return {
      packageManager: normalized,
      executable: 'pnpm',
      args: ['run', scriptName],
      displayCommand: `pnpm run ${scriptName}`,
    }
  }
  if (normalized === 'yarn') {
    return {
      packageManager: normalized,
      executable: 'yarn',
      args: ['run', scriptName],
      displayCommand: `yarn run ${scriptName}`,
    }
  }
  if (normalized === 'bun') {
    return {
      packageManager: normalized,
      executable: 'bun',
      args: ['run', scriptName],
      displayCommand: `bun run ${scriptName}`,
    }
  }

  return {
    packageManager: normalized,
    executable: 'npm',
    args: ['run', scriptName],
    displayCommand: `npm run ${scriptName}`,
  }
}

function isWorkspaceValidationScriptName(scriptName: string): boolean {
  return /(^|[:_-])(test|spec|lint|typecheck|type-check|build)($|[:_-])/iu.test(scriptName)
}

function isWorkspaceLongRunningScriptName(scriptName: string): boolean {
  return /(^|[:_-])(dev|preview|serve|start)($|[:_-])/iu.test(scriptName)
}

function validationKindFromCommand(name: string, command: string): ToolingValidationPlanKind {
  const value = `${name} ${command}`.toLowerCase()
  if (/\b(lint|eslint|stylelint|biome\s+(?:check|lint)|ruff|flake8|clippy)\b/u.test(value)) return 'lint'
  if (/\b(typecheck|type-check|vue-tsc|tsc|mypy|pyright|sorbet)\b/u.test(value)) return 'typecheck'
  if (/\b(build|compile|vite\s+build|next\s+build|tsup|go\s+build|cargo\s+build)\b/u.test(value)) return 'build'
  if (/\b(test|spec|vitest|jest|mocha|playwright|pytest|go\s+test|cargo\s+test|rspec|phpunit)\b/u.test(value)) return 'test'
  return 'manual'
}

function validationPlanTitle(kind: ToolingValidationPlanKind): string {
  if (kind === 'test') return 'Run tests'
  if (kind === 'lint') return 'Run lint'
  if (kind === 'typecheck') return 'Run typecheck'
  if (kind === 'build') return 'Run build'
  if (kind === 'preview') return 'Preview service'
  if (kind === 'browser_smoke') return 'Browser smoke'
  if (kind === 'screenshot') return 'Capture screenshot'
  return 'Manual verification'
}

function normalizeValidationCommand(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^npm run ([\w:@./-]+)$/iu, 'npm $1')
    .toLowerCase()
}

function validationEvidenceForItem(params: {
  itemCommand: string
  scriptName: string | null
  runs: ToolingWorkspaceScriptRun[]
}): ToolingValidationPlanItem['evidence'] {
  const normalizedCommand = normalizeValidationCommand(params.itemCommand)
  const run = params.runs.find((candidate) => {
    if (params.scriptName && candidate.scriptName === params.scriptName) return true
    return normalizeValidationCommand(candidate.command) === normalizedCommand
  })

  if (!run) {
    return {
      status: params.itemCommand ? 'missing' : 'not_applicable',
      runAtIso: null,
      durationMs: null,
      exitCode: null,
      problemCount: 0,
      testSummary: null,
      coverageSummary: null,
    }
  }

  return {
    status: run.status,
    runAtIso: run.endedAtIso,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    problemCount: run.problems.length,
    testSummary: run.testSummary,
    coverageSummary: run.coverageSummary,
  }
}

function validationStatusFromEvidence(
  evidence: ToolingValidationPlanItem['evidence'],
  fallback: ToolingValidationPlanItem['status'],
): ToolingValidationPlanItem['status'] {
  if (evidence.status === 'passed') return 'covered'
  if (evidence.status === 'failed' || evidence.status === 'timed_out') return 'failed'
  if (evidence.status === 'manual') return 'manual'
  return fallback
}

function validationPlanItemId(parts: string[]): string {
  const raw = parts.filter(Boolean).join('-') || 'item'
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'item'
}

function addValidationPlanItem(
  items: ToolingValidationPlanItem[],
  seen: Set<string>,
  item: Omit<ToolingValidationPlanItem, 'id'>,
): void {
  const key = [
    item.kind,
    item.scriptName ?? '',
    normalizeValidationCommand(item.command),
    item.targetUrl ?? '',
  ].join('|')
  if (seen.has(key)) return
  seen.add(key)
  const baseId = validationPlanItemId([item.kind, item.scriptName ?? '', item.command, item.targetUrl ?? '', item.source])
  let id = baseId
  let suffix = 2
  while (items.some((candidate) => candidate.id === id)) {
    id = `${baseId}-${String(suffix)}`
    suffix += 1
  }
  items.push({ id, ...item })
}

function buildWorkspaceValidationPlan(params: {
  packageManager: string
  scripts: Array<{ name: string; command: string }>
  config: ToolingWorkspaceConfig
  runs: ToolingWorkspaceScriptRun[]
}): ToolingWorkspaceValidationPlan {
  const items: ToolingValidationPlanItem[] = []
  const seen = new Set<string>()

  for (const command of params.config.validationCommands) {
    const kind = validationKindFromCommand(command.name, command.command)
    const evidence = validationEvidenceForItem({
      itemCommand: command.command,
      scriptName: command.name,
      runs: params.runs,
    })
    addValidationPlanItem(items, seen, {
      kind,
      title: validationPlanTitle(kind),
      priority: 'required',
      source: 'workspace_config',
      status: validationStatusFromEvidence(evidence, 'ready'),
      command: command.command,
      scriptName: command.name,
      targetUrl: null,
      reason: 'Configured in .cody-web-ui.yml validation.commands.',
      evidence,
    })
  }

  for (const script of params.scripts.filter((candidate) => isWorkspaceValidationScriptName(candidate.name) && !isWorkspaceLongRunningScriptName(candidate.name))) {
    const displayCommand = packageManagerCommand(params.packageManager, script.name).displayCommand
    const kind = validationKindFromCommand(script.name, script.command)
    const evidence = validationEvidenceForItem({
      itemCommand: displayCommand,
      scriptName: script.name,
      runs: params.runs,
    })
    addValidationPlanItem(items, seen, {
      kind,
      title: validationPlanTitle(kind),
      priority: commandPriorityForValidationKind(kind),
      source: 'package_script',
      status: validationStatusFromEvidence(evidence, 'ready'),
      command: displayCommand,
      scriptName: script.name,
      targetUrl: null,
      reason: `Detected package script: ${script.command}`,
      evidence,
    })
  }

  for (const port of params.config.knownPorts) {
    const targetUrl = port.url ?? `http://127.0.0.1:${String(port.port)}/`
    addValidationPlanItem(items, seen, {
      kind: 'preview',
      title: `Preview ${port.name}`,
      priority: port.required ? 'required' : 'recommended',
      source: 'workspace_port',
      status: 'manual',
      command: '',
      scriptName: null,
      targetUrl,
      reason: port.required
        ? 'Required workspace preview port from .cody-web-ui.yml.'
        : 'Known workspace preview port from .cody-web-ui.yml.',
      evidence: {
        status: 'manual',
        runAtIso: null,
        durationMs: null,
        exitCode: null,
        problemCount: 0,
        testSummary: null,
        coverageSummary: null,
      },
    })
  }

  const kinds = new Set(items.map((item) => item.kind))
  for (const kind of ['test', 'lint', 'typecheck', 'build'] as const) {
    if (kinds.has(kind)) continue
    addValidationPlanItem(items, seen, {
      kind,
      title: validationPlanTitle(kind),
      priority: kind === 'test' || kind === 'build' ? 'recommended' : 'optional',
      source: 'inferred',
      status: 'blocked',
      command: '',
      scriptName: null,
      targetUrl: null,
      reason: `No ${kind} validation command was found in .cody-web-ui.yml or package scripts.`,
      evidence: {
        status: 'missing',
        runAtIso: null,
        durationMs: null,
        exitCode: null,
        problemCount: 0,
        testSummary: null,
        coverageSummary: null,
      },
    })
  }

  if (params.config.knownPorts.length > 0) {
    const targetUrl = params.config.knownPorts[0]?.url ?? `http://127.0.0.1:${String(params.config.knownPorts[0]?.port ?? 0)}/`
    addValidationPlanItem(items, seen, {
      kind: 'browser_smoke',
      title: 'Browser smoke',
      priority: 'recommended',
      source: 'inferred',
      status: 'manual',
      command: '',
      scriptName: null,
      targetUrl,
      reason: 'Known preview ports exist; verify the primary user flow in a browser.',
      evidence: {
        status: 'manual',
        runAtIso: null,
        durationMs: null,
        exitCode: null,
        problemCount: 0,
        testSummary: null,
        coverageSummary: null,
      },
    })
    addValidationPlanItem(items, seen, {
      kind: 'screenshot',
      title: 'Capture preview screenshot',
      priority: 'optional',
      source: 'inferred',
      status: 'manual',
      command: '',
      scriptName: null,
      targetUrl,
      reason: 'Attach visual evidence when UI behavior or layout changed.',
      evidence: {
        status: 'manual',
        runAtIso: null,
        durationMs: null,
        exitCode: null,
        problemCount: 0,
        testSummary: null,
        coverageSummary: null,
      },
    })
  }

  addValidationPlanItem(items, seen, {
    kind: 'manual',
    title: 'Manual risk review',
    priority: 'recommended',
    source: 'inferred',
    status: 'manual',
    command: '',
    scriptName: null,
    targetUrl: null,
    reason: 'Confirm remaining risk, unverified areas, and user-facing behavior before delivery.',
    evidence: {
      status: 'manual',
      runAtIso: null,
      durationMs: null,
      exitCode: null,
      problemCount: 0,
      testSummary: null,
      coverageSummary: null,
    },
  })

  return summarizeValidationPlan(items)
}

function commandPriorityForValidationKind(kind: ToolingValidationPlanKind): ToolingValidationPlanItem['priority'] {
  if (kind === 'test' || kind === 'build') return 'recommended'
  if (kind === 'lint' || kind === 'typecheck') return 'recommended'
  return 'optional'
}

function summarizeValidationPlan(items: ToolingValidationPlanItem[]): ToolingWorkspaceValidationPlan {
  return {
    generatedAtIso: new Date().toISOString(),
    items,
    requiredCount: items.filter((item) => item.priority === 'required').length,
    recommendedCount: items.filter((item) => item.priority === 'recommended').length,
    optionalCount: items.filter((item) => item.priority === 'optional').length,
    coveredCount: items.filter((item) => item.status === 'covered').length,
    failedCount: items.filter((item) => item.status === 'failed').length,
    missingEvidenceCount: items.filter((item) => item.evidence.status === 'missing').length,
  }
}

function truncateScriptText(value: string): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= MAX_WORKSPACE_SCRIPT_OUTPUT_BYTES) {
    return { value, truncated: false }
  }

  const buffer = Buffer.from(value, 'utf8').subarray(0, MAX_WORKSPACE_SCRIPT_OUTPUT_BYTES)
  return {
    value: `${buffer.toString('utf8')}\n\n[output truncated]`,
    truncated: true,
  }
}

function normalizeProblemSeverity(value: string): ToolingWorkspaceProblem['severity'] {
  const normalized = value.trim().toLowerCase()
  if (normalized.includes('warn')) return 'warning'
  if (normalized.includes('info') || normalized.includes('note')) return 'info'
  return 'error'
}

function normalizeProblemFilePath(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/gu, '')
    .replace(/\\/gu, '/')
}

function problemId(problem: Omit<ToolingWorkspaceProblem, 'id'>): string {
  return [
    problem.command,
    problem.filePath,
    String(problem.line ?? ''),
    String(problem.column ?? ''),
    problem.severity,
    problem.message,
  ].join('|')
}

function createWorkspaceProblem(problem: Omit<ToolingWorkspaceProblem, 'id'>): ToolingWorkspaceProblem {
  return {
    ...problem,
    id: problemId(problem),
  }
}

function parseWorkspaceProblemLine(
  line: string,
  command: string,
  currentFilePath: string,
): ToolingWorkspaceProblem | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const parenMatch = /^(?<file>[^()\s][^(]*?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|warn|info|note)\s*(?<source>[A-Z]+[A-Z0-9-]*\d*)?\s*:?\s*(?<message>.+)$/iu.exec(trimmed)
  if (parenMatch?.groups) {
    return createWorkspaceProblem({
      severity: normalizeProblemSeverity(parenMatch.groups.severity ?? ''),
      source: (parenMatch.groups.source ?? 'diagnostic').trim() || 'diagnostic',
      message: (parenMatch.groups.message ?? trimmed).trim(),
      filePath: normalizeProblemFilePath(parenMatch.groups.file ?? ''),
      line: Number(parenMatch.groups.line),
      column: Number(parenMatch.groups.column),
      command,
      rawLine: line,
    })
  }

  const eslintMatch = /^\s*(?<line>\d+):(?<column>\d+)\s+(?<severity>error|warning|warn)\s+(?<message>.+?)(?:\s{2,}(?<source>[\w@/-]+))?\s*$/iu.exec(line)
  if (eslintMatch?.groups && currentFilePath) {
    return createWorkspaceProblem({
      severity: normalizeProblemSeverity(eslintMatch.groups.severity ?? ''),
      source: (eslintMatch.groups.source ?? 'eslint').trim() || 'eslint',
      message: (eslintMatch.groups.message ?? trimmed).trim(),
      filePath: currentFilePath,
      line: Number(eslintMatch.groups.line),
      column: Number(eslintMatch.groups.column),
      command,
      rawLine: line,
    })
  }

  const colonMatch = /^(?<file>[^:\s][^:]*?):(?<line>\d+)(?::(?<column>\d+))?\s*(?:[-:]\s*)?(?<severity>error|warning|warn|info|note)?\s*(?<source>[A-Z]+[A-Z0-9-]*\d*)?\s*:?\s*(?<message>.+)$/iu.exec(trimmed)
  if (colonMatch?.groups && /\b(error|warning|warn|failed|failure|exception|panic|not found|TS\d+)\b/iu.test(trimmed)) {
    return createWorkspaceProblem({
      severity: normalizeProblemSeverity(colonMatch.groups.severity ?? colonMatch.groups.message ?? ''),
      source: (colonMatch.groups.source ?? 'diagnostic').trim() || 'diagnostic',
      message: (colonMatch.groups.message ?? trimmed).trim(),
      filePath: normalizeProblemFilePath(colonMatch.groups.file ?? ''),
      line: Number(colonMatch.groups.line),
      column: colonMatch.groups.column ? Number(colonMatch.groups.column) : null,
      command,
      rawLine: line,
    })
  }

  if (!trimmed.startsWith('>') && /\b(error|failed|failure|panic|exception|traceback|not ok|✗|×)\b/iu.test(trimmed)) {
    return createWorkspaceProblem({
      severity: 'error',
      source: 'command',
      message: trimmed,
      filePath: '',
      line: null,
      column: null,
      command,
      rawLine: line,
    })
  }

  return null
}

export function parseWorkspaceProblems(output: string, command: string): ToolingWorkspaceProblem[] {
  const problems: ToolingWorkspaceProblem[] = []
  const seen = new Set<string>()
  let currentFilePath = ''

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (/^(?:\.\/)?[\w./@-]+\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|json|ya?ml|py|go|rs|java|kt|swift|rb|php)$/u.test(trimmed)) {
      currentFilePath = normalizeProblemFilePath(trimmed)
      continue
    }

    const problem = parseWorkspaceProblemLine(line, command, currentFilePath)
    if (!problem || seen.has(problem.id)) continue
    seen.add(problem.id)
    problems.push(problem)
  }

  return problems.slice(0, 50)
}

function securityFindingId(parts: Array<string | number | null>): string {
  return parts.map((part) => String(part ?? '')).join('|')
}

function redactSecretEvidence(value: string): string {
  return value
    .replace(/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/gu, 'AKIA...[redacted]')
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}\b/gu, 'gh_...[redacted]')
    .replace(/\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{12,}\b/gu, 'xox...[redacted]')
    .replace(
      /(\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?)([^"'\s]{4,})/giu,
      '$1[redacted]',
    )
    .slice(0, 240)
}

function scanSecurityText(params: {
  path: string
  line: string
  lineNumber: number | null
  source: ToolingWorkspaceSecurityFinding['source']
}): ToolingWorkspaceSecurityFinding[] {
  const findings: ToolingWorkspaceSecurityFinding[] = []
  for (const pattern of SECURITY_SECRET_PATTERNS) {
    if (!pattern.expression.test(params.line)) continue
    findings.push({
      id: securityFindingId(['secret', pattern.id, params.source, params.path, params.lineNumber]),
      severity: 'danger',
      category: 'secret',
      title: `Possible ${pattern.title}`,
      summary: `${params.path}${params.lineNumber === null ? '' : `:${String(params.lineNumber)}`} includes a value matching ${pattern.title}.`,
      path: params.path,
      lineNumber: params.lineNumber,
      source: params.source,
      evidence: redactSecretEvidence(params.line.trim()),
    })
  }
  return findings
}

function parseUnifiedDiffAddedLines(diff: string, source: 'unstaged_diff' | 'staged_diff'): ToolingWorkspaceSecurityFinding[] {
  const findings: ToolingWorkspaceSecurityFinding[] = []
  let currentPath = ''
  let newLineNumber = 0
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u.exec(line)
    if (hunk?.groups?.start) {
      newLineNumber = Number(hunk.groups.start)
      continue
    }
    if (!currentPath || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      findings.push(...scanSecurityText({
        path: currentPath,
        line: line.slice(1),
        lineNumber: newLineNumber,
        source,
      }))
      newLineNumber += 1
      continue
    }
    if (!line.startsWith('-')) {
      newLineNumber += 1
    }
  }
  return findings
}

function isHighRiskSecurityPath(path: string): boolean {
  return SECURITY_HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

function buildPathSecurityFindings(params: {
  paths: string[]
  config: ToolingWorkspaceConfig
}): ToolingWorkspaceSecurityFinding[] {
  const findings: ToolingWorkspaceSecurityFinding[] = []
  const sensitivePatterns = [...DEFAULT_SENSITIVE_PATH_PATTERNS, ...params.config.sensitivePaths]
  for (const path of params.paths) {
    const values = [path, basename(path)]
    if (sensitivePatterns.some((pattern) => patternMatches(pattern, values))) {
      findings.push({
        id: securityFindingId(['sensitive-path', path]),
        severity: 'danger',
        category: 'sensitive_path',
        title: 'Sensitive path changed',
        summary: `${path} matches workspace sensitive path policy.`,
        path,
        lineNumber: null,
        source: 'workspace_policy',
        evidence: path,
      })
    }
    if (isHighRiskSecurityPath(path)) {
      findings.push({
        id: securityFindingId(['high-risk-path', path]),
        severity: 'warning',
        category: 'high_risk_file',
        title: 'High-risk file changed',
        summary: `${path} affects authentication, payment, permissions, or dependency lock state.`,
        path,
        lineNumber: null,
        source: 'workspace_policy',
        evidence: path,
      })
    }
  }
  return findings
}

async function scanUntrackedSecurityFiles(workspace: GitWorkspace, files: ToolingWorkspaceStatusFile[]): Promise<ToolingWorkspaceSecurityFinding[]> {
  const findings: ToolingWorkspaceSecurityFinding[] = []
  for (const file of files.filter((candidate) => candidate.status === '??').slice(0, 40)) {
    const absolutePath = resolve(workspace.repoRoot, file.path)
    if (!isInside(workspace.repoRoot, absolutePath)) continue
    try {
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile() || fileStat.size > 128 * 1024) continue
      const content = await readFile(absolutePath, 'utf8')
      if (content.includes('\0')) continue
      content.split(/\r?\n/u).slice(0, 400).forEach((line, index) => {
        findings.push(...scanSecurityText({
          path: file.path,
          line,
          lineNumber: index + 1,
          source: 'untracked_file',
        }))
      })
    } catch {
      // Ignore unreadable or binary untracked files.
    }
  }
  return findings
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 100)
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readPolicyMode(value: unknown): ToolingWorkspaceConfig['sandboxMode'] {
  const mode = readOptionalString(value)
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger') return mode
  return 'unknown'
}

function readTrustState(value: unknown): ToolingWorkspaceConfig['trust'] {
  const trust = readOptionalString(value)
  if (trust === 'trusted' || trust === 'untrusted') return trust
  return 'unknown'
}

function readValidationCommands(value: unknown): ToolingWorkspaceValidationCommand[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const row = asRecord(item)
      const name = readOptionalString(row?.name)
      const command = readOptionalString(row?.command)
      return name && command ? { name, command } : null
    })
    .filter((item): item is ToolingWorkspaceValidationCommand => Boolean(item))
    .slice(0, 24)
}

function readKnownPorts(value: unknown): ToolingWorkspaceKnownPort[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const row = asRecord(item)
      const port = Number(row?.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
      const name = readOptionalString(row?.name) || `:${String(port)}`
      const url = readOptionalString(row?.url)
      return {
        name,
        port,
        url: url || null,
        required: row?.required === true,
      }
    })
    .filter((item): item is ToolingWorkspaceKnownPort => Boolean(item))
    .slice(0, 40)
}

function readPortPolicyRules(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' || typeof value === 'number' ? [value] : []
  const rules: string[] = []
  const seen = new Set<string>()

  for (const item of rawValues) {
    const rule = typeof item === 'number' ? String(item) : readOptionalString(item)
    if (!rule || seen.has(rule)) continue
    seen.add(rule)
    rules.push(rule)
  }

  return rules.slice(0, 80)
}

function readPortPolicyConfig(value: unknown): ToolingPortPolicyConfig {
  const policy = asRecord(value) ?? {}
  return {
    allow: readPortPolicyRules(policy.allow ?? policy.allowlist),
    deny: readPortPolicyRules(policy.deny ?? policy.denylist),
    allowExternal: policy.allowExternal === true,
    allowWildcard: policy.allowWildcard === true,
  }
}

const NOTIFICATION_EVENTS: ToolingWorkspaceNotificationEvent[] = [
  'task_started',
  'approval_required',
  'user_input_required',
  'command_failed',
  'test_failed',
  'task_failed',
  'task_completed',
  'ready_for_review',
  'security_risk',
  'rate_limit',
  'token_budget',
]

function readNotificationEvent(value: unknown): ToolingWorkspaceNotificationEvent | null {
  const event = readOptionalString(value)
  return NOTIFICATION_EVENTS.includes(event as ToolingWorkspaceNotificationEvent)
    ? (event as ToolingWorkspaceNotificationEvent)
    : null
}

function readNotificationEvents(value: unknown): ToolingWorkspaceNotificationEvent[] {
  if (!Array.isArray(value)) return []
  const events: ToolingWorkspaceNotificationEvent[] = []
  const seen = new Set<string>()

  for (const item of value) {
    const event = readNotificationEvent(item)
    if (!event || seen.has(event)) continue
    seen.add(event)
    events.push(event)
  }

  return events
}

function readNotificationChannelType(value: unknown): ToolingWorkspaceNotificationChannelType | null {
  const type = readOptionalString(value)
  if (type === 'webhook' || type === 'slack' || type === 'lark') return type
  return null
}

function redactNotificationUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname ? '/...' : ''}`
  } catch {
    return value ? '<configured>' : ''
  }
}

function readNotificationChannels(value: unknown): ToolingWorkspaceNotificationChannel[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => {
      const row = asRecord(item)
      const type = readNotificationChannelType(row?.type)
      if (!row || !type) return null

      const name = readOptionalString(row.name) || `${type}-${String(index + 1)}`
      const url = readOptionalString(row.url)
      const urlEnv = readOptionalString(row.urlEnv ?? row.env)
      const target = urlEnv ? `$${urlEnv}` : redactNotificationUrl(url)
      return {
        name,
        type,
        enabled: row.enabled !== false,
        events: readNotificationEvents(row.events),
        target,
      }
    })
    .filter((item): item is ToolingWorkspaceNotificationChannel => Boolean(item))
    .slice(0, 20)
}

function readNotificationDispatchChannels(value: unknown): ToolingWorkspaceNotificationDispatchChannel[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => {
      const row = asRecord(item)
      const type = readNotificationChannelType(row?.type)
      if (!row || !type) return null

      const urlEnv = readOptionalString(row.urlEnv ?? row.env)
      const url = urlEnv ? readOptionalString(process.env[urlEnv]) : readOptionalString(row.url)
      if (!url) return null

      const name = readOptionalString(row.name) || `${type}-${String(index + 1)}`
      return {
        name,
        type,
        enabled: row.enabled !== false,
        events: readNotificationEvents(row.events),
        target: urlEnv ? `$${urlEnv}` : redactNotificationUrl(url),
        url,
      }
    })
    .filter((item): item is ToolingWorkspaceNotificationDispatchChannel => Boolean(item))
    .slice(0, 20)
}

function readNotificationConfig(value: unknown): ToolingWorkspaceNotificationConfig {
  const notifications = asRecord(value) ?? {}
  return {
    enabled: notifications.enabled === true,
    events: readNotificationEvents(notifications.events),
    channels: readNotificationChannels(notifications.channels),
  }
}

function readThemeDensity(value: unknown): ToolingWorkspaceConfig['theme']['density'] {
  const density = readOptionalString(value)
  if (density === 'compact' || density === 'comfortable' || density === 'spacious') return density
  return ''
}

function readThemeLayoutPreset(value: unknown): ToolingWorkspaceConfig['theme']['layoutPresetId'] {
  const preset = readOptionalString(value)
  if (
    preset === 'chat-focus' ||
    preset === 'review-focus' ||
    preset === 'ops-dashboard' ||
    preset === 'ide-mode' ||
    preset === 'mobile-review'
  ) {
    return preset
  }
  return ''
}

function readThemeAccentColor(value: unknown): string {
  const color = readOptionalString(value)
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.test(color) ? color : ''
}

function readThemeConfig(value: unknown): ToolingWorkspaceConfig['theme'] {
  const theme = asRecord(value) ?? {}
  return {
    skinId: readOptionalString(theme.skinId ?? theme.skin),
    accentColor: readThemeAccentColor(theme.accentColor ?? theme.accent),
    density: readThemeDensity(theme.density),
    layoutPresetId: readThemeLayoutPreset(theme.layoutPresetId ?? theme.layout),
    followSystem: typeof theme.followSystem === 'boolean' ? theme.followSystem : null,
  }
}

function emptyWorkspaceConfig(path: string | null = null): ToolingWorkspaceConfig {
  return {
    path,
    loaded: false,
    errors: [],
    trust: 'unknown',
    sandboxMode: 'unknown',
    approvalPolicy: '',
    defaultModel: '',
    reasoningEffort: '',
    collaborationMode: '',
    commandPolicy: {
      allow: [],
      deny: [],
    },
    validationCommands: [],
    knownPorts: [],
    portPolicy: {
      allow: [],
      deny: [],
      allowExternal: false,
      allowWildcard: false,
    },
    notifications: {
      enabled: false,
      events: [],
      channels: [],
    },
    theme: {
      skinId: '',
      accentColor: '',
      density: '',
      layoutPresetId: '',
      followSystem: null,
    },
    sensitivePaths: [],
    ignorePatterns: [],
  }
}

async function readWorkspaceConfig(repoRoot: string): Promise<ToolingWorkspaceConfig> {
  const configPath = join(repoRoot, '.cody-web-ui.yml')
  if (!(await pathExists(configPath))) return emptyWorkspaceConfig(null)

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = parseYaml(raw) as unknown
    const root = asRecord(parsed) ?? {}
    const workspace = asRecord(root.workspace) ?? root
    const commands = asRecord(root.commands) ?? {}
    const validation = asRecord(root.validation) ?? {}
    const ports = asRecord(root.ports) ?? {}
    const notifications = asRecord(root.notifications) ?? {}
    const security = asRecord(root.security) ?? {}
    const theme = asRecord(root.theme) ?? asRecord(workspace.theme) ?? {}

    return {
      path: configPath,
      loaded: true,
      errors: [],
      trust: readTrustState(workspace.trust),
      sandboxMode: readPolicyMode(workspace.sandboxMode ?? workspace.sandbox),
      approvalPolicy: readOptionalString(workspace.approvalPolicy ?? workspace.approvals),
      defaultModel: readOptionalString(workspace.defaultModel ?? workspace.model),
      reasoningEffort: readOptionalString(workspace.reasoningEffort ?? workspace.reasoning),
      collaborationMode: readOptionalString(workspace.collaborationMode ?? workspace.collaboration),
      commandPolicy: {
        allow: readStringArray(commands.allow ?? commands.allowlist),
        deny: readStringArray(commands.deny ?? commands.denylist),
      },
      validationCommands: readValidationCommands(validation.commands),
      knownPorts: readKnownPorts(ports.known ?? root.ports),
      portPolicy: readPortPolicyConfig(ports.policy ?? ports),
      notifications: readNotificationConfig(notifications),
      theme: readThemeConfig(theme),
      sensitivePaths: readStringArray(security.sensitivePaths ?? security.sensitive),
      ignorePatterns: readStringArray(security.ignorePatterns ?? security.ignore),
    }
  } catch (error) {
    const config = emptyWorkspaceConfig(configPath)
    config.errors = [error instanceof Error ? error.message : 'Failed to parse .cody-web-ui.yml']
    return config
  }
}

export async function getWorkspaceNotificationDispatchConfig(
  cwd: string,
): Promise<ToolingWorkspaceNotificationDispatchConfig> {
  const workspace = await getWorkspaceRoot(cwd)
  const configPath = join(workspace.root, '.cody-web-ui.yml')
  if (!(await pathExists(configPath))) {
    return {
      enabled: false,
      events: [],
      channels: [],
      warnings: ['No .cody-web-ui.yml notification policy found.'],
    }
  }

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = parseYaml(raw) as unknown
    const root = asRecord(parsed) ?? {}
    const notifications = asRecord(root.notifications) ?? {}
    const channels = readNotificationDispatchChannels(notifications.channels)
    return {
      enabled: notifications.enabled === true,
      events: readNotificationEvents(notifications.events),
      channels,
      warnings: notifications.enabled === true && channels.length === 0
        ? ['Notifications are enabled but no channel has a usable URL or urlEnv.']
        : [],
    }
  } catch (error) {
    return {
      enabled: false,
      events: [],
      channels: [],
      warnings: [error instanceof Error ? error.message : 'Failed to parse notification policy.'],
    }
  }
}

function wildcardPatternToRegExp(pattern: string): RegExp | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null
  const escaped = trimmed.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${escaped}$`, 'iu')
}

function patternMatches(pattern: string, values: string[]): boolean {
  const expression = wildcardPatternToRegExp(pattern)
  if (!expression) return false
  return values.some((value) => expression.test(value))
}

function commandPolicyValues(params: {
  scriptName?: string
  scriptCommand?: string
  displayCommand?: string
  command?: string
}): string[] {
  const values = [
    params.scriptName ?? '',
    params.scriptCommand ?? '',
    params.displayCommand ?? '',
    params.command ?? '',
  ].map((value) => value.trim()).filter(Boolean)
  const command = (params.command ?? params.displayCommand ?? '').trim()

  const npmScript = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?<script>[A-Za-z0-9:_-]+)\b/iu.exec(command)?.groups?.script
  if (npmScript) values.push(npmScript)

  const firstToken = command.split(/\s+/u)[0] ?? ''
  if (firstToken) values.push(firstToken)

  return Array.from(new Set(values))
}

function evaluateCommandPolicyFromConfig(params: {
  config: ToolingWorkspaceConfig
  cwd: string
  repoRoot: string
  command: string
  values: string[]
}): ToolingCommandPolicyEvaluation {
  const allowPatterns = params.config.commandPolicy.allow
  const denyPatterns = params.config.commandPolicy.deny
  const denyMatch = denyPatterns.find((pattern) => patternMatches(pattern, params.values))
  if (denyMatch) {
    return {
      status: 'denied',
      cwd: params.cwd,
      repoRoot: params.repoRoot,
      command: params.command,
      checkedValues: params.values,
      allowPatterns,
      denyPatterns,
      matchedPattern: denyMatch,
      reason: `Command is denied by .cody-web-ui.yml policy: ${denyMatch}`,
    }
  }

  if (allowPatterns.length === 0) {
    return {
      status: denyPatterns.length === 0 ? 'not_configured' : 'allowed',
      cwd: params.cwd,
      repoRoot: params.repoRoot,
      command: params.command,
      checkedValues: params.values,
      allowPatterns,
      denyPatterns,
      matchedPattern: '',
      reason: denyPatterns.length === 0
        ? 'No workspace command allowlist or denylist is configured.'
        : 'Command did not match any deny policy.',
    }
  }

  const allowMatch = allowPatterns.find((pattern) => patternMatches(pattern, params.values))
  if (!allowMatch) {
    return {
      status: 'denied',
      cwd: params.cwd,
      repoRoot: params.repoRoot,
      command: params.command,
      checkedValues: params.values,
      allowPatterns,
      denyPatterns,
      matchedPattern: '',
      reason: 'Command is not allowed by .cody-web-ui.yml policy',
    }
  }

  return {
    status: 'allowed',
    cwd: params.cwd,
    repoRoot: params.repoRoot,
    command: params.command,
    checkedValues: params.values,
    allowPatterns,
    denyPatterns,
    matchedPattern: allowMatch,
    reason: `Command matched .cody-web-ui.yml allow policy: ${allowMatch}`,
  }
}

function assertWorkspaceCommandPolicy(params: {
  config: ToolingWorkspaceConfig
  scriptName: string
  scriptCommand: string
  displayCommand: string
}): void {
  const evaluation = evaluateCommandPolicyFromConfig({
    config: params.config,
    cwd: '',
    repoRoot: '',
    command: params.displayCommand,
    values: commandPolicyValues(params),
  })
  if (evaluation.status === 'denied') throw new Error(evaluation.reason)
}

export async function evaluateWorkspaceCommandPolicy(params: {
  cwd: string
  command: string
}): Promise<ToolingCommandPolicyEvaluation> {
  const command = params.command.trim()
  if (!command) {
    return {
      status: 'denied',
      cwd: params.cwd,
      repoRoot: '',
      command,
      checkedValues: [],
      allowPatterns: [],
      denyPatterns: [],
      matchedPattern: '',
      reason: 'Command text is missing.',
    }
  }

  try {
    const workspace = await getGitWorkspace(params.cwd)
    const config = await readWorkspaceConfig(workspace.repoRoot)
    return evaluateCommandPolicyFromConfig({
      config,
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      command,
      values: commandPolicyValues({ command }),
    })
  } catch {
    return {
      status: 'not_git_workspace',
      cwd: params.cwd,
      repoRoot: '',
      command,
      checkedValues: commandPolicyValues({ command }),
      allowPatterns: [],
      denyPatterns: [],
      matchedPattern: '',
      reason: 'No git workspace command policy could be loaded for this request.',
    }
  }
}

export async function recordCommandPolicyDecisionAuditEvent(input: {
  cwd: string
  requestId: number
  method: string
  threadId: string
  turnId: string
  itemId: string
  evaluation: ToolingCommandPolicyEvaluation
  action: 'pending' | 'auto_rejected'
}): Promise<void> {
  try {
    const workspace = await getGitWorkspace(input.cwd)
    await appendWorkspaceAuditEvent(workspace, {
      actor: 'system',
      kind: input.action === 'auto_rejected'
        ? 'command_policy.rejected'
        : 'command_policy.checked',
      severity: input.evaluation.status === 'denied' ? 'danger' : 'info',
      title: input.evaluation.status === 'denied' ? 'Command policy rejected approval' : 'Command policy checked approval',
      summary: input.evaluation.reason,
      metadata: {
        requestId: input.requestId,
        method: input.method,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        command: input.evaluation.command,
        status: input.evaluation.status,
        matchedPattern: input.evaluation.matchedPattern,
        allowPatterns: input.evaluation.allowPatterns,
        denyPatterns: input.evaluation.denyPatterns,
        checkedValues: input.evaluation.checkedValues,
      },
    })
  } catch {
    // Policy audit should not block the app-server bridge.
  }
}

export async function evaluateWorkspaceFileChangePolicy(params: {
  cwd: string
  grantRoot: string
}): Promise<ToolingFileChangePolicyEvaluation> {
  const rawGrantRoot = params.grantRoot.trim()
  if (!rawGrantRoot) {
    return {
      status: 'denied',
      cwd: params.cwd,
      repoRoot: '',
      grantRoot: '',
      relativePath: '',
      sandboxMode: 'unknown',
      category: 'missing_grant_root',
      matchedPattern: '',
      reason: 'File change approval did not include a write root.',
    }
  }

  let workspace: GitWorkspace
  try {
    workspace = await getGitWorkspace(params.cwd)
  } catch {
    return {
      status: 'not_git_workspace',
      cwd: params.cwd,
      repoRoot: '',
      grantRoot: rawGrantRoot,
      relativePath: '',
      sandboxMode: 'unknown',
      category: 'not_git_workspace',
      matchedPattern: '',
      reason: 'No git workspace could be loaded for this file change approval.',
    }
  }

  const config = await readWorkspaceConfig(workspace.repoRoot)
  let absoluteGrantRoot = isAbsolute(rawGrantRoot)
    ? resolve(rawGrantRoot)
    : resolve(workspace.repoRoot, rawGrantRoot)

  if (!isInside(workspace.repoRoot, absoluteGrantRoot) && isAbsolute(rawGrantRoot)) {
    const requestedCwd = resolve(params.cwd)
    if (rawGrantRoot === requestedCwd || rawGrantRoot.startsWith(`${requestedCwd}${sep}`)) {
      absoluteGrantRoot = resolve(workspace.cwd, relative(requestedCwd, rawGrantRoot))
    }
  }

  if (config.sandboxMode === 'read-only') {
    return {
      status: 'denied',
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      grantRoot: absoluteGrantRoot,
      relativePath: '',
      sandboxMode: config.sandboxMode,
      category: 'read_only',
      matchedPattern: 'workspace.sandboxMode=read-only',
      reason: 'Workspace is configured read-only in .cody-web-ui.yml.',
    }
  }

  if (!isInside(workspace.repoRoot, absoluteGrantRoot)) {
    return {
      status: 'denied',
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      grantRoot: absoluteGrantRoot,
      relativePath: '',
      sandboxMode: config.sandboxMode,
      category: 'outside_workspace',
      matchedPattern: '',
      reason: 'Requested write root is outside the git workspace root.',
    }
  }

  const relativePath = relative(workspace.repoRoot, absoluteGrantRoot).split(sep).join('/')
  if (relativePath) {
    const protection = checkWorkspacePathProtection(await readWorkspacePathProtectionPolicy(workspace.repoRoot), relativePath)
    if (protection) {
      return {
        status: 'denied',
        cwd: workspace.cwd,
        repoRoot: workspace.repoRoot,
        grantRoot: absoluteGrantRoot,
        relativePath,
        sandboxMode: config.sandboxMode,
        category: protection.category,
        matchedPattern: protection.pattern,
        reason: protection.reason,
      }
    }
  }

  return {
    status: 'allowed',
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    grantRoot: absoluteGrantRoot,
    relativePath,
    sandboxMode: config.sandboxMode,
    category: 'workspace',
    matchedPattern: '',
    reason: relativePath
      ? 'Requested write root is inside the workspace and does not match sensitive or ignored path policy.'
      : 'Requested write root is the workspace root; sensitive and ignored direct file operations remain protected by workspace tooling.',
  }
}

export async function recordFileChangePolicyDecisionAuditEvent(input: {
  cwd: string
  requestId: number
  method: string
  threadId: string
  turnId: string
  itemId: string
  evaluation: ToolingFileChangePolicyEvaluation
  action: 'pending' | 'auto_rejected'
}): Promise<void> {
  try {
    const workspace = await getGitWorkspace(input.cwd)
    await appendWorkspaceAuditEvent(workspace, {
      actor: 'system',
      kind: input.action === 'auto_rejected'
        ? 'file_policy.rejected'
        : 'file_policy.checked',
      severity: input.evaluation.status === 'allowed' ? 'info' : 'danger',
      title: input.evaluation.status === 'allowed' ? 'File change policy checked approval' : 'File change policy rejected approval',
      summary: input.evaluation.reason,
      metadata: {
        requestId: input.requestId,
        method: input.method,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        grantRoot: input.evaluation.grantRoot,
        relativePath: input.evaluation.relativePath,
        status: input.evaluation.status,
        category: input.evaluation.category,
        matchedPattern: input.evaluation.matchedPattern,
        sandboxMode: input.evaluation.sandboxMode,
      },
    })
  } catch {
    // Policy audit should not block the app-server bridge.
  }
}

function appendTerminalOutput(session: ToolingTerminalSession, chunk: string): void {
  const nextOutput = session.output + chunk
  const byteLength = Buffer.byteLength(nextOutput, 'utf8')
  if (byteLength <= MAX_TERMINAL_SESSION_OUTPUT_BYTES) {
    session.output = nextOutput
    return
  }

  const buffer = Buffer.from(nextOutput, 'utf8')
  session.output = `[output truncated]\n${buffer.subarray(buffer.length - MAX_TERMINAL_SESSION_OUTPUT_BYTES).toString('utf8')}`
  session.truncated = true
}

function publicTerminalSession(record: TerminalSessionRecord): ToolingTerminalSession {
  return { ...record.session }
}

function finishTerminalSession(
  record: TerminalSessionRecord,
  status: ToolingTerminalSession['status'],
  exitCode: number | null,
  signal: string | null,
): void {
  if (record.session.status !== 'running') {
    record.session.exitCode = exitCode
    record.session.signal = signal
    return
  }

  const endedAtMs = Date.now()
  const startedAtMs = new Date(record.session.startedAtIso).getTime()
  record.session.status = status
  record.session.endedAtIso = new Date(endedAtMs).toISOString()
  record.session.durationMs = Number.isNaN(startedAtMs) ? null : endedAtMs - startedAtMs
  record.session.exitCode = exitCode
  record.session.signal = signal
  record.process = null
}

function execWorkspaceScript(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return new Promise((resolveScriptRun) => {
    execFile(
      executable,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_WORKSPACE_SCRIPT_OUTPUT_BYTES,
        timeout: WORKSPACE_SCRIPT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (!error) {
          resolveScriptRun({
            exitCode: 0,
            signal: null,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            timedOut: false,
          })
          return
        }

        const errorWithOutput = error as ExecFileException & {
          stdout?: string | Buffer
          stderr?: string | Buffer
          killed?: boolean
        }
        const exitCode = typeof error.code === 'number' ? error.code : null
        const signal = typeof error.signal === 'string' ? error.signal : null
        const timedOut = Boolean(errorWithOutput.killed && signal === 'SIGTERM')

        resolveScriptRun({
          exitCode,
          signal,
          stdout: String(errorWithOutput.stdout ?? stdout ?? ''),
          stderr: String(errorWithOutput.stderr ?? stderr ?? error.message),
          timedOut,
        })
      },
    )
  })
}

async function readWorkspaceConfigFiles(repoRoot: string): Promise<ToolingWorkspaceSnapshot['configFiles']> {
  const agentsPaths = [
    join(repoRoot, 'AGENTS.md'),
    join(repoRoot, 'agents.md'),
  ]
  return {
    codyWebUi: await pathExists(join(repoRoot, '.cody-web-ui.yml')),
    agents: (await Promise.all(agentsPaths.map(pathExists))).some(Boolean),
    aiIgnore: await pathExists(join(repoRoot, '.aiignore')),
    gitIgnore: await pathExists(join(repoRoot, '.gitignore')),
  }
}

function contextSourceId(kind: ToolingWorkspaceContextKind, path: string): string {
  return validationPlanItemId([kind, path])
}

function redactContextText(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => {
      if (/(["']?\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\b["']?\s*[:=])/iu.test(line)) {
        return line.replace(
          /((?:"|')?\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\b(?:"|')?\s*[:=]\s*)["']?[^"',\s#]+["']?/iu,
          '$1<redacted>',
        )
      }
      return line
    })
    .join('\n')
}

function summarizeContextExcerpt(relativePath: string, excerpt: string, present: boolean): string {
  if (!present) return `${relativePath} not found.`
  const firstMeaningfulLine = excerpt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))
  return firstMeaningfulLine
    ? `${relativePath}: ${firstMeaningfulLine.slice(0, 160)}`
    : `${relativePath} is present.`
}

async function readWorkspaceContextSource(params: {
  repoRoot: string
  relativePath: string
  kind: ToolingWorkspaceContextKind
  title: string
  required?: boolean
}): Promise<ToolingWorkspaceContextSource | null> {
  const absolutePath = resolve(params.repoRoot, params.relativePath)
  if (!isInside(params.repoRoot, absolutePath)) return null

  if (!(await pathExists(absolutePath))) {
    if (params.required === false) return null
    return {
      id: contextSourceId(params.kind, params.relativePath),
      kind: params.kind,
      title: params.title,
      path: params.relativePath,
      present: false,
      bytes: 0,
      excerpt: '',
      truncated: false,
      summary: summarizeContextExcerpt(params.relativePath, '', false),
    }
  }

  try {
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) return null
    const raw = await readFile(absolutePath, 'utf8')
    const redacted = redactContextText(raw)
    const truncated = Buffer.byteLength(redacted, 'utf8') > MAX_PROJECT_CONTEXT_SOURCE_BYTES
    const excerpt = truncated
      ? `${Buffer.from(redacted, 'utf8').subarray(0, MAX_PROJECT_CONTEXT_SOURCE_BYTES).toString('utf8')}\n\n[context source truncated]`
      : redacted
    return {
      id: contextSourceId(params.kind, params.relativePath),
      kind: params.kind,
      title: params.title,
      path: params.relativePath,
      present: true,
      bytes: fileStat.size,
      excerpt,
      truncated,
      summary: summarizeContextExcerpt(params.relativePath, excerpt, true),
    }
  } catch (error) {
    return {
      id: contextSourceId(params.kind, params.relativePath),
      kind: params.kind,
      title: params.title,
      path: params.relativePath,
      present: false,
      bytes: 0,
      excerpt: '',
      truncated: false,
      summary: error instanceof Error ? `${params.relativePath} could not be read: ${error.message}` : `${params.relativePath} could not be read.`,
    }
  }
}

async function listWorkspaceSkillSources(repoRoot: string): Promise<ToolingWorkspaceContextSource[]> {
  const skillRoots = [
    '.codex/skills',
    '.cursor/skills',
  ]
  const sources: ToolingWorkspaceContextSource[] = []

  for (const skillRoot of skillRoots) {
    const absoluteSkillRoot = join(repoRoot, skillRoot)
    if (!(await pathExists(absoluteSkillRoot))) continue
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = await readdir(absoluteSkillRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const relativePath = `${skillRoot}/${entry.name}/SKILL.md`
      const source = await readWorkspaceContextSource({
        repoRoot,
        relativePath,
        kind: 'local_skill',
        title: `Local skill: ${entry.name}`,
        required: false,
      })
      if (source?.present) sources.push(source)
      if (sources.length >= 12) return sources
    }
  }

  return sources
}

async function buildWorkspaceProjectContext(repoRoot: string): Promise<ToolingWorkspaceProjectContext> {
  const fixedSources = await Promise.all([
    readWorkspaceContextSource({ repoRoot, relativePath: 'AGENTS.md', kind: 'agents', title: 'AGENTS.md' }),
    readWorkspaceContextSource({ repoRoot, relativePath: 'agents.md', kind: 'agents', title: 'agents.md', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.cody-web-ui.yml', kind: 'cody_web_ui', title: '.cody-web-ui.yml' }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.codex/config.toml', kind: 'codex_config', title: 'Codex config', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.codex/config.json', kind: 'codex_config', title: 'Codex config', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.mcp.json', kind: 'mcp_config', title: 'MCP config', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.cursor/mcp.json', kind: 'mcp_config', title: 'Cursor MCP config', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.aiignore', kind: 'ai_ignore', title: '.aiignore' }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.gitignore', kind: 'git_ignore', title: '.gitignore' }),
    readWorkspaceContextSource({ repoRoot, relativePath: 'CLAUDE.md', kind: 'custom_rules', title: 'CLAUDE.md', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: 'GEMINI.md', kind: 'custom_rules', title: 'GEMINI.md', required: false }),
    readWorkspaceContextSource({ repoRoot, relativePath: '.cursorrules', kind: 'custom_rules', title: '.cursorrules', required: false }),
  ])
  const skillSources = await listWorkspaceSkillSources(repoRoot)
  const sources = [...fixedSources.filter((source): source is ToolingWorkspaceContextSource => Boolean(source)), ...skillSources]
    .slice(0, MAX_PROJECT_CONTEXT_SOURCES)
  const warnings = [
    sources.some((source) => source.kind === 'agents' && source.present) ? '' : 'No AGENTS.md project instruction file found.',
    sources.some((source) => source.kind === 'codex_config' && source.present) ? '' : 'No workspace-local Codex config found.',
    sources.some((source) => source.kind === 'local_skill' && source.present) ? '' : 'No workspace-local skills found.',
    sources.some((source) => source.kind === 'mcp_config' && source.present) ? '' : 'No workspace MCP config file found.',
  ].filter(Boolean)

  return {
    generatedAtIso: new Date().toISOString(),
    sources,
    presentCount: sources.filter((source) => source.present).length,
    warnings,
  }
}

function buildWorkspaceWarnings(snapshot: Omit<ToolingWorkspaceSnapshot, 'warnings'>): string[] {
  const warnings: string[] = []
  if (!snapshot.isGitRepo) {
    warnings.push('This workspace is not a git repository, so rollback and branch context are limited.')
  }
  if (snapshot.gitStatus.conflictedFileCount > 0) {
    warnings.push(`${String(snapshot.gitStatus.conflictedFileCount)} conflicted file${snapshot.gitStatus.conflictedFileCount === 1 ? '' : 's'} need attention.`)
  }
  if (snapshot.gitStatus.dirtyFileCount > 20) {
    warnings.push(`${String(snapshot.gitStatus.dirtyFileCount)} dirty files detected. Review scope before starting autonomous work.`)
  }
  if (!snapshot.configFiles.codyWebUi) {
    warnings.push('No .cody-web-ui.yml found for workspace-specific policy and validation defaults.')
  }
  for (const error of snapshot.workspaceConfig.errors) {
    warnings.push(`.cody-web-ui.yml could not be parsed: ${error}`)
  }
  if (snapshot.workspaceConfig.loaded && snapshot.workspaceConfig.trust !== 'trusted') {
    warnings.push('Workspace trust is not marked trusted in .cody-web-ui.yml.')
  }
  if (snapshot.workspaceConfig.sandboxMode === 'danger') {
    warnings.push('Workspace config requests danger sandbox mode. Review approvals before running commands.')
  }
  if (
    snapshot.workspaceConfig.loaded &&
    snapshot.workspaceConfig.commandPolicy.allow.length === 0 &&
    snapshot.workspaceConfig.commandPolicy.deny.length === 0
  ) {
    warnings.push('.cody-web-ui.yml does not define command allowlist or denylist policy.')
  }
  if (!snapshot.configFiles.aiIgnore) {
    warnings.push('No .aiignore found; sensitive paths rely on default protections only.')
  }
  for (const warning of snapshot.projectContext.warnings) {
    warnings.push(warning)
  }
  return warnings
}

async function readStatusForPaths(workspace: GitWorkspace, paths: string[]): Promise<string> {
  return runGit(['status', '--porcelain=v1', '-z', '--', ...paths], workspace.repoRoot)
}

type CheckpointUntrackedPolicy = 'all' | 'files-only' | 'none'

export async function readToolingCheckpointFingerprint(cwd: string): Promise<{ repositoryKey: string; fingerprint: string; dirty: boolean }> {
  const workspace = await getGitWorkspace(cwd)
  const [status, unstaged, staged] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-z'], workspace.repoRoot),
    runGit(['diff', '--binary'], workspace.repoRoot),
    runGit(['diff', '--cached', '--binary'], workspace.repoRoot),
  ])
  const untrackedMetadata: string[] = []
  for (const entry of parsePorcelainZ(status).filter((row) => row.status === '??')) {
    const path = resolve(workspace.repoRoot, entry.path)
    if (!isInside(workspace.repoRoot, path)) continue
    const info = await lstat(path).catch(() => null)
    if (info?.isFile()) untrackedMetadata.push(`${entry.path}:${String(info.size)}:${String(info.mtimeMs)}`)
  }
  return {
    repositoryKey: workspace.gitCommonDir,
    fingerprint: createHash('sha256').update(status).update('\0').update(unstaged).update('\0').update(staged).update('\0').update(untrackedMetadata.join('\0')).digest('hex'),
    dirty: status.length > 0,
  }
}

type CheckpointBackupResult = {
  copiedBytes: number
  skippedPaths: string[]
}

async function pathSizeWithinLimit(path: string, limit: number, deadlineMs: number): Promise<number | null> {
  if (Date.now() > deadlineMs) return null
  const info = await lstat(path)
  if (info.isSymbolicLink()) return null
  if (info.isFile()) return info.size <= limit ? info.size : null
  if (!info.isDirectory()) return 0
  if (DEFAULT_CHECKPOINT_EXCLUDED_NAMES.has(basename(path))) return null
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (DEFAULT_CHECKPOINT_EXCLUDED_NAMES.has(entry.name)) return null
    const childSize = await pathSizeWithinLimit(join(path, entry.name), limit - total, deadlineMs)
    if (childSize === null) return null
    total += childSize
    if (total > limit) return null
  }
  return total
}

async function backupUntrackedPaths(
  workspace: GitWorkspace,
  paths: string[],
  checkpointDir: string,
  policy: CheckpointUntrackedPolicy,
): Promise<CheckpointBackupResult> {
  if (policy === 'none') return { copiedBytes: 0, skippedPaths: [] }
  const status = await readStatusForPaths(workspace, paths)
  const untrackedPaths = parsePorcelainZ(status)
    .filter((entry) => entry.status === '??')
    .map((entry) => entry.path)

  if (untrackedPaths.length === 0) return { copiedBytes: 0, skippedPaths: [] }

  const untrackedRoot = join(checkpointDir, 'untracked')
  let copiedBytes = 0
  const skippedPaths: string[] = []
  const deadlineMs = Date.now() + CHECKPOINT_SCAN_TIMEOUT_MS

  for (const untrackedPath of untrackedPaths) {
    const sourcePath = resolve(workspace.repoRoot, untrackedPath)
    if (!isInside(workspace.repoRoot, sourcePath)) continue
    const info = await lstat(sourcePath)
    if (info.isSymbolicLink() || (info.isDirectory() && policy === 'files-only')) {
      skippedPaths.push(untrackedPath)
      continue
    }
    const remainingBytes = MAX_CHECKPOINT_UNTRACKED_BYTES - copiedBytes
    const itemLimit = info.isFile()
      ? Math.min(MAX_CHECKPOINT_UNTRACKED_FILE_BYTES, remainingBytes)
      : remainingBytes
    const itemBytes = await pathSizeWithinLimit(sourcePath, itemLimit, deadlineMs)
    if (itemBytes === null || itemBytes > remainingBytes) {
      skippedPaths.push(untrackedPath)
      continue
    }

    const targetPath = resolve(untrackedRoot, untrackedPath)
    await mkdir(dirname(targetPath), { recursive: true })
    await cp(sourcePath, targetPath, { recursive: true, force: true, errorOnExist: false })
    copiedBytes += itemBytes
  }
  return { copiedBytes, skippedPaths }
}

async function directorySize(path: string, budget = { remaining: CHECKPOINT_PRUNE_SCAN_MAX_ENTRIES, deadlineMs: Date.now() + CHECKPOINT_SCAN_TIMEOUT_MS }): Promise<number | null> {
  try {
    if (Date.now() > budget.deadlineMs || budget.remaining-- <= 0) return null
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 0
    if (info.isFile()) return info.size
    if (!info.isDirectory()) return 0
    let total = 0
    for (const entry of await readdir(path)) {
      const childBytes = await directorySize(join(path, entry), budget)
      if (childBytes === null) return null
      total += childBytes
    }
    return total
  } catch {
    return null
  }
}

function checkpointErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

type CheckpointStorageEntry = {
  id: string
  path: string
  createdAtMs: number
  bytes: number | null
  reportedPruneFailures: string[]
}

async function readCheckpointStorageEntries(workspace: GitWorkspace): Promise<{
  entries: CheckpointStorageEntry[]
  scanError: string
}> {
  const root = checkpointRoot(workspace)
  let rows: string[]
  try {
    rows = await readdir(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { entries: [], scanError: code === 'ENOENT' ? '' : checkpointErrorMessage(error) }
  }

  const entries = await Promise.all(rows.map(async (id): Promise<CheckpointStorageEntry> => {
    const path = join(root, id)
    let createdAtMs = 0
    try { createdAtMs = (await stat(path)).mtimeMs } catch { /* Preserve the unreadable entry as unknown. */ }
    const metadata = await readFile(join(path, 'metadata.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as Partial<ToolingCheckpoint>)
      .catch(() => null)
    const patchBytes = Number(metadata?.patchBytes)
    const untrackedBytes = Number(metadata?.untrackedBytes ?? 0)
    const recordedBytes = metadata && Number.isFinite(patchBytes) && patchBytes >= 0 && Number.isFinite(untrackedBytes) && untrackedBytes >= 0
      ? patchBytes + untrackedBytes
      : null
    const reportedPruneFailures = Array.isArray(metadata?.pruneFailedCheckpointIds)
      ? metadata.pruneFailedCheckpointIds.filter((value): value is string => typeof value === 'string')
      : []
    return {
      id,
      path,
      createdAtMs,
      bytes: recordedBytes ?? await directorySize(path),
      reportedPruneFailures,
    }
  }))
  return { entries: entries.sort((a, b) => b.createdAtMs - a.createdAtMs), scanError: '' }
}

async function pruneToolingCheckpoints(workspace: GitWorkspace, preserveId: string): Promise<string[]> {
  const { entries: checkpoints } = await readCheckpointStorageEntries(workspace)
  let totalBytes = checkpoints.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  const now = Date.now()
  const failedCheckpointIds: string[] = []
  for (let index = 0; index < checkpoints.length; index += 1) {
    const entry = checkpoints[index]
    if (!entry || entry.id === preserveId) continue
    const expired = now - entry.createdAtMs > MAX_CHECKPOINT_AGE_MS
    const overCount = index >= MAX_RETAINED_CHECKPOINTS
    const overBytes = totalBytes > MAX_CHECKPOINT_REPOSITORY_BYTES
    const unknownSize = entry.bytes === null
    if (!expired && !overCount && !overBytes && !unknownSize) continue
    const backoff = checkpointPruneBackoffByPath.get(entry.path)
    if (backoff && backoff.retryAtMs > now) {
      failedCheckpointIds.push(entry.id)
      continue
    }
    try {
      await rm(entry.path, { recursive: true, force: true })
      checkpointPruneBackoffByPath.delete(entry.path)
      totalBytes -= entry.bytes ?? 0
    } catch (error) {
      failedCheckpointIds.push(entry.id)
      const failureCount = (backoff?.failureCount ?? 0) + 1
      const delayMs = Math.min(
        CHECKPOINT_PRUNE_BACKOFF_MAX_MS,
        CHECKPOINT_PRUNE_BACKOFF_BASE_MS * 2 ** Math.min(failureCount - 1, 10),
      )
      checkpointPruneBackoffByPath.delete(entry.path)
      checkpointPruneBackoffByPath.set(entry.path, { failureCount, retryAtMs: now + delayMs })
      while (checkpointPruneBackoffByPath.size > 1_000) {
        const oldestPath = checkpointPruneBackoffByPath.keys().next().value as string | undefined
        if (!oldestPath) break
        checkpointPruneBackoffByPath.delete(oldestPath)
      }
      console.warn(`Failed to prune tooling checkpoint ${entry.id}; retrying after ${String(delayMs)}ms: ${checkpointErrorMessage(error)}`)
    }
  }
  return failedCheckpointIds
}

export async function getToolingCheckpointHealth(cwd: string): Promise<ToolingCheckpointHealth> {
  const workspace = await getGitWorkspace(cwd)
  const root = checkpointRoot(workspace)
  const { entries, scanError } = await readCheckpointStorageEntries(workspace)
  let rootWritable = true
  try {
    await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await access(workspace.gitCommonDir, fsConstants.W_OK | fsConstants.X_OK)
      } catch {
        rootWritable = false
      }
    } else {
      rootWritable = false
    }
  }

  const currentIds = new Set(entries.map((entry) => entry.id))
  const blockedCheckpointIds = Array.from(new Set(entries.flatMap((entry) => [
    ...(checkpointPruneBackoffByPath.has(entry.path) ? [entry.id] : []),
    ...entry.reportedPruneFailures.filter((id) => currentIds.has(id)),
  ]))).sort()
  const unknownSizeCheckpointIds = entries.filter((entry) => entry.bytes === null).map((entry) => entry.id).sort()
  const status = !rootWritable || Boolean(scanError)
    ? 'unhealthy'
    : blockedCheckpointIds.length > 0 || unknownSizeCheckpointIds.length > 0
      ? 'degraded'
      : 'healthy'

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    checkpointRoot: root,
    generatedAtIso: new Date().toISOString(),
    status,
    rootWritable,
    checkpointCount: entries.length,
    knownBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    unknownSizeCheckpointIds,
    blockedCheckpointIds,
    scanError,
  }
}

async function createToolingCheckpointUnlocked(params: {
  cwd: string
  label?: string
  paths?: string[]
  untrackedPolicy?: CheckpointUntrackedPolicy
}): Promise<ToolingCheckpoint> {
  const workspace = await getGitWorkspace(params.cwd)
  const paths = (params.paths ?? [])
    .map((path) => normalizeWorkspacePath(workspace, path))
    .filter((path, index, all) => all.indexOf(path) === index)
  const pathArgs = paths.length > 0 ? ['--', ...paths] : []
  const createdAtIso = new Date().toISOString()
  const id = sanitizeCheckpointId(`${createdAtIso}-${randomUUID()}`)
  const label = params.label?.trim() || 'Checkpoint'
  const root = checkpointRoot(workspace)
  const checkpointDir = join(root, id)
  const patchPath = join(checkpointDir, 'workspace.patch')

  const filesystem = await statfs(root).catch(() => statfs(workspace.gitCommonDir))
  const freeBytes = filesystem.bavail * filesystem.bsize
  if (freeBytes < MIN_CHECKPOINT_FREE_BYTES) {
    throw new Error(`Checkpoint skipped: only ${String(freeBytes)} bytes are free`)
  }

  await mkdir(checkpointDir, { recursive: true })
  try {
    const unstagedPatch = await runGit(['diff', '--binary', ...pathArgs], workspace.repoRoot)
    const stagedPatch = await runGit(['diff', '--cached', '--binary', ...pathArgs], workspace.repoRoot)
    const patch = [
      unstagedPatch.trimEnd(),
      stagedPatch.trimEnd(),
    ].filter(Boolean).join('\n\n')

    await writeFile(patchPath, patch, 'utf8')
    const backup = await backupUntrackedPaths(workspace, paths, checkpointDir, params.untrackedPolicy ?? 'all')

    const checkpoint: ToolingCheckpoint = {
      id,
      label,
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      createdAtIso,
      paths,
      patchPath,
      patchBytes: Buffer.byteLength(patch),
      hasPatch: patch.trim().length > 0,
      untrackedBytes: backup.copiedBytes,
      skippedUntrackedPaths: backup.skippedPaths,
      partial: backup.skippedPaths.length > 0,
    }

    await writeFile(join(checkpointDir, 'metadata.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
    await appendWorkspaceAuditEvent(workspace, {
    kind: 'checkpoint.created',
    severity: checkpoint.hasPatch ? 'success' : 'info',
    title: 'Checkpoint created',
    summary: `${label} (${checkpoint.hasPatch ? `${String(checkpoint.patchBytes)} bytes` : 'empty patch'})`,
    metadata: {
      checkpointId: checkpoint.id,
      label,
      paths,
      patchBytes: checkpoint.patchBytes,
      hasPatch: checkpoint.hasPatch,
      untrackedBytes: checkpoint.untrackedBytes,
      skippedUntrackedPaths: checkpoint.skippedUntrackedPaths,
      partial: checkpoint.partial,
    },
  })
    const pruneFailedCheckpointIds = await pruneToolingCheckpoints(workspace, id)
    if (pruneFailedCheckpointIds.length > 0) {
      checkpoint.pruneFailedCheckpointIds = pruneFailedCheckpointIds
      await writeFile(join(checkpointDir, 'metadata.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
    }
    return checkpoint
  } catch (error) {
    try {
      await rm(checkpointDir, { recursive: true, force: true })
    } catch (cleanupError) {
      console.warn(`Failed to clean up incomplete tooling checkpoint ${id}: ${checkpointErrorMessage(cleanupError)}`)
    }
    throw error
  }
}

export async function createToolingCheckpoint(params: {
  cwd: string
  label?: string
  paths?: string[]
  untrackedPolicy?: CheckpointUntrackedPolicy
}): Promise<ToolingCheckpoint> {
  const workspace = await getGitWorkspace(params.cwd)
  const queueKey = workspace.gitCommonDir
  const previous = checkpointQueueByRepository.get(queueKey) ?? Promise.resolve()
  let releaseQueue: () => void = () => undefined
  const current = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue })
  const queueTail = previous.catch(() => undefined).then(() => current)
  checkpointQueueByRepository.set(queueKey, queueTail)
  await previous.catch(() => undefined)
  try {
    return await createToolingCheckpointUnlocked(params)
  } finally {
    releaseQueue()
    if (checkpointQueueByRepository.get(queueKey) === queueTail) checkpointQueueByRepository.delete(queueKey)
  }
}

function isToolingCheckpoint(value: unknown): value is ToolingCheckpoint {
  const row = asRecord(value)
  if (!row) return false
  return (
    typeof row.id === 'string' &&
    typeof row.label === 'string' &&
    typeof row.cwd === 'string' &&
    typeof row.repoRoot === 'string' &&
    typeof row.createdAtIso === 'string' &&
    Array.isArray(row.paths) &&
    row.paths.every((path) => typeof path === 'string') &&
    typeof row.patchPath === 'string' &&
    typeof row.patchBytes === 'number' &&
    typeof row.hasPatch === 'boolean' &&
    (row.untrackedBytes === undefined || typeof row.untrackedBytes === 'number') &&
    (row.skippedUntrackedPaths === undefined || (Array.isArray(row.skippedUntrackedPaths) && row.skippedUntrackedPaths.every((path) => typeof path === 'string'))) &&
    (row.partial === undefined || typeof row.partial === 'boolean') &&
    (row.pruneFailedCheckpointIds === undefined || (Array.isArray(row.pruneFailedCheckpointIds) && row.pruneFailedCheckpointIds.every((id) => typeof id === 'string')))
  )
}

export async function listToolingCheckpoints(params: {
  cwd: string
  limit?: number
}): Promise<ToolingCheckpoint[]> {
  const workspace = await getGitWorkspace(params.cwd)
  const root = checkpointRoot(workspace)
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100))

  let rows: string[]
  try {
    rows = await readdir(root)
  } catch {
    return []
  }

  const checkpoints: ToolingCheckpoint[] = []
  for (const row of rows) {
    const metadataPath = join(root, row, 'metadata.json')
    try {
      const raw = await readFile(metadataPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (isToolingCheckpoint(parsed) && parsed.repoRoot === workspace.repoRoot) {
        checkpoints.push(parsed)
      }
    } catch {
      // Ignore malformed or partially-written checkpoint directories.
    }
  }

  return checkpoints
    .sort((first, second) => second.createdAtIso.localeCompare(first.createdAtIso))
    .slice(0, limit)
}

export async function readToolingCheckpointPatch(params: {
  cwd: string
  checkpointId: string
}): Promise<ToolingCheckpointPatch> {
  const workspace = await getGitWorkspace(params.cwd)
  const checkpointId = assertCheckpointId(params.checkpointId)
  const checkpointDir = join(checkpointRoot(workspace), checkpointId)
  const metadataPath = join(checkpointDir, 'metadata.json')
  const patchPath = join(checkpointDir, 'workspace.patch')

  const rawMetadata = await readFile(metadataPath, 'utf8')
  const checkpoint = JSON.parse(rawMetadata) as unknown
  if (!isToolingCheckpoint(checkpoint) || checkpoint.id !== checkpointId || checkpoint.repoRoot !== workspace.repoRoot) {
    throw new Error('checkpoint metadata is invalid')
  }

  return {
    checkpoint,
    patch: await readFile(patchPath, 'utf8'),
  }
}

export async function listWorkspaceAuditEvents(params: {
  cwd: string
  limit?: number
}): Promise<ToolingAuditTrail> {
  const workspace = await getGitWorkspace(params.cwd)
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200))
  let raw = ''

  try {
    raw = await readFile(auditLogPath(workspace), 'utf8')
  } catch {
    return {
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      generatedAtIso: new Date().toISOString(),
      events: [],
      truncated: false,
    }
  }

  const rows = raw.split('\n').filter(Boolean)
  const events: ToolingAuditEvent[] = []
  for (let index = rows.length - 1; index >= 0 && events.length < limit; index -= 1) {
    try {
      const parsed = JSON.parse(rows[index] ?? '') as unknown
      if (isToolingAuditEvent(parsed) && parsed.repoRoot === workspace.repoRoot) {
        events.push(parsed)
      }
    } catch {
      // Ignore malformed audit rows; newer valid rows remain usable.
    }
  }

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    events,
    truncated: rows.length > events.length,
  }
}

export async function listWorkspaceReviewComments(cwd: string): Promise<ToolingReviewCommentList> {
  const workspace = await getGitWorkspace(cwd)
  const comments = await readWorkspaceReviewComments(workspace)
  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    comments: comments.sort((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso)),
  }
}

export async function createWorkspaceReviewComment(params: {
  cwd: string
  body: string
  anchor: ToolingReviewCommentAnchor
}): Promise<ToolingReviewComment> {
  const workspace = await getGitWorkspace(params.cwd)
  const now = new Date().toISOString()
  const comment: ToolingReviewComment = {
    id: randomUUID(),
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    createdAtIso: now,
    updatedAtIso: now,
    author: 'local-user',
    status: 'open',
    body: reviewCommentBody(params.body),
    anchor: params.anchor,
    followUpRunId: null,
  }
  const comments = await readWorkspaceReviewComments(workspace)
  await writeWorkspaceReviewComments(workspace, [comment, ...comments])
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'review.comment_created',
    severity: 'info',
    title: 'Review comment created',
    summary: `${comment.anchor.filePath}:${String(comment.anchor.newLineNumber ?? comment.anchor.oldLineNumber ?? 0)} ${comment.body.slice(0, 120)}`,
    metadata: {
      commentId: comment.id,
      filePath: comment.anchor.filePath,
      hunkHeader: comment.anchor.hunkHeader,
      oldLineNumber: comment.anchor.oldLineNumber,
      newLineNumber: comment.anchor.newLineNumber,
    },
  })
  return comment
}

export async function updateWorkspaceReviewCommentStatus(params: {
  cwd: string
  commentId: string
  status: ToolingReviewCommentStatus
}): Promise<ToolingReviewComment> {
  const workspace = await getGitWorkspace(params.cwd)
  const comments = await readWorkspaceReviewComments(workspace)
  const commentIndex = comments.findIndex((comment) => comment.id === params.commentId)
  if (commentIndex < 0) throw new Error('review comment not found')
  const existing = comments[commentIndex] as ToolingReviewComment
  const next: ToolingReviewComment = {
    ...existing,
    status: params.status,
    updatedAtIso: new Date().toISOString(),
  }
  comments[commentIndex] = next
  await writeWorkspaceReviewComments(workspace, comments)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'review.comment_status_updated',
    severity: params.status === 'resolved' ? 'success' : 'info',
    title: 'Review comment status updated',
    summary: `${next.anchor.filePath} -> ${params.status}`,
    metadata: {
      commentId: next.id,
      status: params.status,
      followUpRunId: next.followUpRunId,
    },
  })
  return next
}

export async function createWorkspaceReviewFollowUp(params: {
  cwd: string
  commentId: string
}): Promise<ToolingReviewFollowUpResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const comments = await readWorkspaceReviewComments(workspace)
  const commentIndex = comments.findIndex((comment) => comment.id === params.commentId)
  if (commentIndex < 0) throw new Error('review comment not found')
  const existing = comments[commentIndex] as ToolingReviewComment
  if (existing.followUpRunId) {
    const dashboard = await listWorkspaceWorkflows({ cwd: workspace.cwd, limit: 100 })
    const workflowRun = dashboard.runs.find((run) => run.id === existing.followUpRunId)
    if (workflowRun) return { comment: existing, workflowRun }
  }

  const lineNumber = existing.anchor.newLineNumber ?? existing.anchor.oldLineNumber
  const goal = [
    `Address review comment in ${existing.anchor.filePath}${lineNumber ? `:${String(lineNumber)}` : ''}.`,
    '',
    existing.body,
    '',
    `Diff anchor: ${existing.anchor.hunkHeader}`,
    existing.anchor.lineContent ? `Line: ${existing.anchor.lineContent}` : '',
  ].filter(Boolean).join('\n')
  const workflowRun = await createWorkspaceWorkflowRun({
    cwd: workspace.cwd,
    templateId: 'review-diff',
    goal,
  })
  const next: ToolingReviewComment = {
    ...existing,
    status: 'follow_up_created',
    followUpRunId: workflowRun.id,
    updatedAtIso: new Date().toISOString(),
  }
  comments[commentIndex] = next
  await writeWorkspaceReviewComments(workspace, comments)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'review.follow_up_created',
    severity: 'success',
    title: 'Review follow-up task created',
    summary: `${next.anchor.filePath} -> ${workflowRun.id}`,
    metadata: {
      commentId: next.id,
      workflowRunId: workflowRun.id,
      templateId: workflowRun.templateId,
    },
  })
  return { comment: next, workflowRun }
}

export async function listWorkspaceValidationRuns(params: {
  cwd: string
  limit?: number
}): Promise<ToolingWorkspaceValidationRunHistory> {
  const workspace = await getGitWorkspace(params.cwd)
  const limit = Math.max(1, Math.min(params.limit ?? 20, 50))
  let raw = ''

  try {
    raw = await readFile(validationRunsPath(workspace), 'utf8')
  } catch {
    return {
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      generatedAtIso: new Date().toISOString(),
      runs: [],
      truncated: false,
    }
  }

  const rows = raw.split('\n').filter(Boolean)
  const runs: ToolingWorkspaceScriptRun[] = []
  for (let index = rows.length - 1; index >= 0 && runs.length < limit; index -= 1) {
    try {
      const parsed = JSON.parse(rows[index] ?? '') as unknown
      if (isToolingWorkspaceScriptRun(parsed) && parsed.repoRoot === workspace.repoRoot) {
        runs.push(parsed)
      }
    } catch {
      // Ignore malformed rows; keep returning valid recent runs.
    }
  }

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    runs,
    truncated: rows.length > runs.length,
  }
}

function workflowTemplateById(templateId: string): ToolingWorkflowTemplate {
  const template = BUILT_IN_WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId.trim())
  if (!template) throw new Error('workflow template was not found')
  return template
}

function isToolingWorkflowRun(value: unknown): value is ToolingWorkflowRun {
  const row = asRecord(value)
  return Boolean(
    row &&
      typeof row.id === 'string' &&
      typeof row.cwd === 'string' &&
      typeof row.repoRoot === 'string' &&
      typeof row.templateId === 'string' &&
      typeof row.templateName === 'string' &&
      typeof row.goal === 'string' &&
      typeof row.status === 'string' &&
      typeof row.createdAtIso === 'string' &&
      typeof row.updatedAtIso === 'string' &&
      typeof row.branch === 'string' &&
      typeof row.dirtyFileCount === 'number' &&
      Array.isArray(row.agents) &&
      Array.isArray(row.validationPlan) &&
      Array.isArray(row.riskLabels) &&
      Array.isArray(row.warnings) &&
      typeof row.summary === 'string',
  )
}

function workflowRunPath(workspace: GitWorkspace, runId: string): string {
  return join(workflowRunsRoot(workspace), `${sanitizeCheckpointId(runId)}.json`)
}

function assertWorkflowRunId(value: string): string {
  const runId = value.trim()
  if (!runId) throw new Error('workflow run id is required')
  if (runId !== sanitizeCheckpointId(runId) || runId.includes('..')) {
    throw new Error('workflow run id is invalid')
  }
  return runId
}

function assertWorkflowAgentId(value: string): string {
  const agentId = value.trim()
  if (!agentId) throw new Error('workflow agent id is required')
  if (agentId !== sanitizeCheckpointId(agentId) || agentId.includes('..')) {
    throw new Error('workflow agent id is invalid')
  }
  return agentId
}

function assertWorkflowStepStatus(value: string): ToolingWorkflowStepStatus {
  const status = value.trim()
  if (
    status === 'queued' ||
    status === 'ready' ||
    status === 'running' ||
    status === 'blocked' ||
    status === 'completed' ||
    status === 'skipped'
  ) {
    return status
  }
  throw new Error('workflow agent status is invalid')
}

function workflowGoal(value: string): string {
  const goal = value.trim()
  if (!goal) throw new Error('workflow goal is required')
  if (goal.length > 4000) throw new Error('workflow goal is too long')
  return goal
}

function workflowRunId(templateId: string): string {
  return sanitizeCheckpointId(`${new Date().toISOString()}-${templateId}-${randomUUID()}`)
}

function workflowBranchSlug(goal: string): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
  return branchNameToDirectoryName(words || 'workflow')
}

function workflowStepBriefing(params: {
  runId: string
  template: ToolingWorkflowTemplate
  goal: string
  branch: string
  step: ToolingWorkflowTemplateStep
  validationPlan: string[]
  warnings: string[]
}): string {
  const lines = [
    `Workflow: ${params.template.name}`,
    `Run: ${params.runId}`,
    `Workspace branch: ${params.branch || 'detached/unknown'}`,
    `Agent: ${params.step.title}`,
    `Role: ${params.step.role}`,
    '',
    'Goal:',
    params.goal,
    '',
    'Objective:',
    params.step.objective,
    '',
    'Deliverables:',
    ...params.step.deliverables.map((item) => `- ${item}`),
    '',
    'Validation plan:',
    ...params.validationPlan.map((item) => `- ${item}`),
  ]

  if (params.step.dependsOn.length > 0) {
    lines.push('', 'Depends on:', ...params.step.dependsOn.map((item) => `- ${item}`))
  }
  if (params.warnings.length > 0) {
    lines.push('', 'Workspace warnings:', ...params.warnings.map((item) => `- ${item}`))
  }

  return lines.join('\n')
}

function mergeWorkflowValidationPlan(params: {
  template: ToolingWorkflowTemplate
  config: ToolingWorkspaceConfig
  scripts: Array<{ name: string; command: string }>
}): string[] {
  const plan = [...params.template.validationPlan]
  for (const command of params.config.validationCommands) {
    plan.push(`${command.name}: ${command.command}`)
  }
  for (const script of params.scripts.filter((script) => isWorkspaceValidationScriptName(script.name)).slice(0, 8)) {
    plan.push(`${script.name}: ${script.command}`)
  }
  return plan.filter((item, index, all) => item.trim() && all.indexOf(item) === index).slice(0, 20)
}

async function readWorkflowRun(workspace: GitWorkspace, runId: string): Promise<ToolingWorkflowRun> {
  const raw = await readFile(workflowRunPath(workspace, assertWorkflowRunId(runId)), 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isToolingWorkflowRun(parsed) || parsed.repoRoot !== workspace.repoRoot) {
    throw new Error('workflow run metadata is invalid')
  }
  return parsed
}

async function writeWorkflowRun(workspace: GitWorkspace, run: ToolingWorkflowRun): Promise<void> {
  await mkdir(workflowRunsRoot(workspace), { recursive: true })
  const {
    implementationOptions: _implementationOptions,
    acceptance: _acceptance,
    ...persistedRun
  } = run
  await writeFile(workflowRunPath(workspace, run.id), `${JSON.stringify(persistedRun, null, 2)}\n`, 'utf8')
}

function isWorkflowDependencySatisfied(status: ToolingWorkflowStepStatus): boolean {
  return status === 'completed' || status === 'skipped'
}

function unlockReadyWorkflowAgents(agents: ToolingWorkflowAgentStep[]): ToolingWorkflowAgentStep[] {
  const statusById = new Map(agents.map((agent) => [agent.id, agent.status]))
  return agents.map((agent) => {
    if (agent.status !== 'queued') return agent
    const dependenciesSatisfied = agent.dependsOn.every((dependencyId) =>
      isWorkflowDependencySatisfied(statusById.get(dependencyId) ?? 'queued')
    )
    return dependenciesSatisfied ? { ...agent, status: 'ready' } : agent
  })
}

function summarizeWorkflowRunStatus(run: ToolingWorkflowRun, agents: ToolingWorkflowAgentStep[]): {
  status: ToolingWorkflowRunStatus
  summary: string
} {
  const completedCount = agents.filter((agent) => agent.status === 'completed').length
  const skippedCount = agents.filter((agent) => agent.status === 'skipped').length
  const blockedCount = agents.filter((agent) => agent.status === 'blocked').length
  const runningCount = agents.filter((agent) => agent.status === 'running').length
  const readyCount = agents.filter((agent) => agent.status === 'ready').length
  const terminalCount = completedCount + skippedCount

  if (blockedCount > 0) {
    return {
      status: 'blocked',
      summary: `${run.templateName} is blocked on ${String(blockedCount)} agent step${blockedCount === 1 ? '' : 's'}.`,
    }
  }
  if (terminalCount === agents.length) {
    return {
      status: 'completed',
      summary: `${run.templateName} completed ${String(completedCount)} agent step${completedCount === 1 ? '' : 's'}${skippedCount > 0 ? ` and skipped ${String(skippedCount)}` : ''}.`,
    }
  }
  if (runningCount > 0) {
    return {
      status: 'running',
      summary: `${run.templateName} is running ${String(runningCount)} agent step${runningCount === 1 ? '' : 's'}; ${String(completedCount)} completed.`,
    }
  }
  if (agents.some((agent) => agent.status === 'ready' && (agent.role === 'review' || agent.role === 'docs'))) {
    return {
      status: 'ready_for_review',
      summary: `${run.templateName} has review or delivery agents ready.`,
    }
  }
  return {
    status: readyCount > 0 ? 'ready_for_execution' : 'queued',
    summary: `${run.templateName} has ${String(readyCount)} ready agent step${readyCount === 1 ? '' : 's'} and ${String(completedCount)} completed.`,
  }
}

function buildWorkflowWarnings(params: {
  snapshot: ToolingWorkspaceSnapshot
  template: ToolingWorkflowTemplate
}): string[] {
  const warnings = [...params.snapshot.warnings]
  if (params.template.steps.some((step) => step.requiresWorktree) && params.snapshot.gitStatus.dirtyFileCount > 0) {
    warnings.push('Template includes implementation work; create an isolated worktree before applying autonomous patches.')
  }
  if (params.snapshot.workspaceConfig.sandboxMode === 'danger') {
    warnings.push('Danger sandbox mode is configured; require explicit human approval for risky commands.')
  }
  return warnings.filter((item, index, all) => all.indexOf(item) === index).slice(0, 20)
}

function buildWorkflowAgents(params: {
  runId: string
  template: ToolingWorkflowTemplate
  goal: string
  branch: string
  config: ToolingWorkspaceConfig
  validationPlan: string[]
  warnings: string[]
}): ToolingWorkflowAgentStep[] {
  const model = params.config.defaultModel || 'workspace default'
  const reasoningEffort = params.config.reasoningEffort || 'workspace default'
  const worktreeStepCount = params.template.steps.filter((step) => step.requiresWorktree).length
  return params.template.steps.map((step, index) => {
    const worktreePolicy = step.requiresWorktree ? 'required' : step.role === 'implementation' ? 'recommended' : 'not-needed'
    const branchSuffix = worktreeStepCount > 1 ? `-${step.id}` : ''
    return {
      ...step,
      status: index === 0 ? 'ready' : 'queued',
      agentName: step.title,
      model,
      reasoningEffort,
      permissionProfile: params.config.sandboxMode,
      worktreePolicy,
      branchName: step.requiresWorktree
        ? `codex/${params.template.id}/${workflowBranchSlug(params.goal)}${branchSuffix}`
        : null,
      worktreeStatus: worktreePolicy === 'not-needed' ? 'not_required' : 'pending',
      worktreePath: null,
      worktreeReadyAtIso: null,
      briefing: workflowStepBriefing({
        runId: params.runId,
        template: params.template,
        goal: params.goal,
        branch: params.branch,
        step,
        validationPlan: params.validationPlan,
        warnings: params.warnings,
      }),
    }
  })
}

function workflowValidationScriptNames(run: ToolingWorkflowRun): Set<string> {
  const names = new Set<string>()
  for (const item of run.validationPlan) {
    const match = item.match(/^([A-Za-z0-9:_-]+):\s+(.+)$/u)
    const scriptName = match?.[1]?.trim() ?? ''
    if (scriptName && isWorkspaceValidationScriptName(scriptName) && !isWorkspaceLongRunningScriptName(scriptName)) {
      names.add(scriptName)
    }
  }
  return names
}

function parseDiffShortStat(value: string): { files: number; insertions: number; deletions: number } {
  const text = value.trim()
  const files = Number(text.match(/(\d+)\s+files?\s+changed/u)?.[1] ?? 0)
  const insertions = Number(text.match(/(\d+)\s+insertions?\(\+\)/u)?.[1] ?? 0)
  const deletions = Number(text.match(/(\d+)\s+deletions?\(-\)/u)?.[1] ?? 0)
  return {
    files: Number.isFinite(files) ? files : 0,
    insertions: Number.isFinite(insertions) ? insertions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
  }
}

function uniqueDiffPaths(nameStatus: string, statusFiles: ToolingWorkspaceStatusFile[]): Set<string> {
  const paths = new Set<string>()
  for (const item of parseNameStatus(nameStatus)) {
    paths.add(item.path)
  }
  for (const file of statusFiles) {
    paths.add(file.path)
  }
  return paths
}

function latestWorkflowValidationEvent(events: ToolingAuditEvent[]): {
  status: ToolingWorkflowImplementationOption['validationStatus']
  command: string | null
} {
  const event = [...events]
    .filter((candidate) => candidate.kind === 'workflow.validation_ran')
    .sort((first, second) => second.createdAtIso.localeCompare(first.createdAtIso))[0]
  if (!event) return { status: 'missing', command: null }
  const status = typeof event.metadata.status === 'string' ? event.metadata.status : ''
  return {
    status: status === 'passed' ? 'passed' : status === 'failed' || status === 'timed_out' ? 'failed' : 'unknown',
    command: typeof event.metadata.command === 'string' ? event.metadata.command : null,
  }
}

function implementationComparisonStatus(params: {
  agent: ToolingWorkflowAgentStep
  changedFileCount: number
  validationStatus: ToolingWorkflowImplementationOption['validationStatus']
}): ToolingWorkflowImplementationOption['comparisonStatus'] {
  if (params.agent.worktreeStatus === 'discarded') return 'discarded'
  if (params.agent.worktreeStatus !== 'ready' || !params.agent.worktreePath) return 'pending_worktree'
  if (params.changedFileCount === 0) return 'no_changes'
  if (params.validationStatus === 'failed') return 'validation_failed'
  if (params.validationStatus === 'missing' || params.validationStatus === 'unknown') return 'validation_missing'
  if (params.agent.status === 'completed' && params.validationStatus === 'passed') return 'ready_to_merge'
  return 'changes_available'
}

function implementationOptionRisks(params: {
  agent: ToolingWorkflowAgentStep
  statusFiles: ToolingWorkspaceStatusFile[]
  comparisonStatus: ToolingWorkflowImplementationOption['comparisonStatus']
  validationStatus: ToolingWorkflowImplementationOption['validationStatus']
  changedFileCount: number
}): string[] {
  const risks: string[] = []
  if (params.agent.worktreeStatus === 'discarded') risks.push('This implementation option was discarded.')
  if (params.agent.worktreeStatus !== 'ready') risks.push('Isolated worktree is not ready yet.')
  if (params.agent.status !== 'completed') risks.push('Implementation agent has not marked this option complete.')
  if (params.changedFileCount === 0 && params.agent.worktreeStatus === 'ready') risks.push('No code changes detected in this option.')
  if (params.validationStatus === 'missing') risks.push('No workflow validation evidence is linked yet.')
  if (params.validationStatus === 'failed') risks.push('Latest linked workflow validation failed.')
  if (params.statusFiles.length > 0) risks.push(`${String(params.statusFiles.length)} uncommitted worktree file${params.statusFiles.length === 1 ? '' : 's'} need review.`)
  if (params.comparisonStatus === 'ready_to_merge') risks.push('Ready to merge only after human diff review.')
  return risks.slice(0, 8)
}

function buildWorkflowAcceptanceGate(params: {
  run: ToolingWorkflowRun
  implementationOptions: ToolingWorkflowImplementationOption[]
  validation: { status: ToolingWorkflowImplementationOption['validationStatus']; command: string | null }
}): ToolingWorkflowAcceptanceGate {
  const terminalStatuses = new Set<ToolingWorkflowStepStatus>(['completed', 'skipped'])
  const completedAgentCount = params.run.agents.filter((agent) => terminalStatuses.has(agent.status)).length
  const blockedAgentCount = params.run.agents.filter((agent) => agent.status === 'blocked').length
  const activeAgentCount = params.run.agents.filter((agent) => !terminalStatuses.has(agent.status) && agent.status !== 'blocked').length
  const implementationAgents = params.run.agents.filter((agent) => agent.role === 'implementation')
  const pendingWorktreeCount = implementationAgents.filter((agent) =>
    agent.worktreePolicy !== 'not-needed' && agent.worktreeStatus !== 'ready' && agent.worktreeStatus !== 'discarded' && agent.status !== 'skipped'
  ).length
  const readyImplementationOptionCount = params.implementationOptions.filter((option) =>
    option.comparisonStatus === 'ready_to_merge'
  ).length
  const runnableValidationCount = workflowValidationScriptNames(params.run).size
  const risks: string[] = []

  if (blockedAgentCount > 0) {
    risks.push(`${String(blockedAgentCount)} agent step${blockedAgentCount === 1 ? '' : 's'} blocked.`)
  }
  if (pendingWorktreeCount > 0) {
    risks.push(`${String(pendingWorktreeCount)} implementation worktree${pendingWorktreeCount === 1 ? '' : 's'} still pending.`)
  }
  if (activeAgentCount > 0) {
    risks.push(`${String(activeAgentCount)} agent step${activeAgentCount === 1 ? '' : 's'} still need to finish.`)
  }
  if (runnableValidationCount === 0) {
    risks.push('No runnable automated validation check is configured for this workflow.')
  }
  if (params.validation.status === 'missing') {
    risks.push('No workflow validation evidence is linked yet.')
  }
  if (params.validation.status === 'failed') {
    risks.push('Latest linked workflow validation failed.')
  }
  if (params.validation.status === 'unknown') {
    risks.push('Latest linked workflow validation ended in an unknown state.')
  }
  if (params.implementationOptions.length > 0 && readyImplementationOptionCount === 0 && params.validation.status === 'passed') {
    risks.push('Validation passed, but no implementation option is merge-ready yet.')
  }

  const base = {
    validationStatus: params.validation.status,
    validationCommand: params.validation.command,
    requiredValidationCount: runnableValidationCount,
    completedAgentCount,
    totalAgentCount: params.run.agents.length,
    readyImplementationOptionCount,
    totalImplementationOptionCount: params.implementationOptions.length,
    risks: risks.filter((item, index, all) => all.indexOf(item) === index).slice(0, 8),
  }

  if (blockedAgentCount > 0 || (params.run.status === 'failed' && params.validation.status !== 'failed')) {
    return {
      ...base,
      status: 'blocked',
      label: 'Blocked',
      summary: 'The workflow cannot be accepted until blocked or failed steps are resolved.',
    }
  }
  if (params.validation.status === 'failed') {
    return {
      ...base,
      status: 'validation_failed',
      label: 'Validation failed',
      summary: 'The latest linked validation run failed, so the workflow is not ready.',
    }
  }
  if (pendingWorktreeCount > 0) {
    return {
      ...base,
      status: 'pending_worktree',
      label: 'Waiting for worktree',
      summary: 'Implementation work must run in an isolated worktree before acceptance can continue.',
    }
  }
  if (activeAgentCount > 0) {
    return {
      ...base,
      status: 'waiting_for_agents',
      label: 'Waiting for agents',
      summary: 'Agent steps are still in progress or queued; acceptance has not started.',
    }
  }
  if (runnableValidationCount === 0 || params.validation.status !== 'passed') {
    return {
      ...base,
      status: 'waiting_for_validation',
      label: 'Waiting for validation',
      summary: 'All agent steps may be done, but automated validation evidence is still missing.',
    }
  }
  if (params.run.status === 'ready_for_review') {
    return {
      ...base,
      status: 'ready_for_review',
      label: 'Ready for review',
      summary: 'Automated validation passed and review or delivery steps are ready.',
    }
  }
  return {
    ...base,
    status: 'accepted',
    label: 'Accepted',
    summary: 'All agent steps are terminal and the latest linked automated validation passed.',
  }
}

async function buildWorkflowImplementationOption(params: {
  run: ToolingWorkflowRun
  agent: ToolingWorkflowAgentStep
  validation: { status: ToolingWorkflowImplementationOption['validationStatus']; command: string | null }
}): Promise<ToolingWorkflowImplementationOption> {
  if (params.agent.worktreeStatus !== 'ready' || !params.agent.worktreePath) {
    const discarded = params.agent.worktreeStatus === 'discarded'
    return {
      agentId: params.agent.id,
      agentName: params.agent.agentName,
      agentStatus: params.agent.status,
      worktreeStatus: params.agent.worktreeStatus,
      branchName: params.agent.branchName,
      worktreePath: params.agent.worktreePath,
      comparisonStatus: discarded ? 'discarded' : 'pending_worktree',
      changedFileCount: 0,
      committedFileCount: 0,
      uncommittedFileCount: 0,
      insertions: 0,
      deletions: 0,
      validationStatus: params.validation.status,
      validationCommand: params.validation.command,
      risks: discarded
        ? ['This implementation option was discarded and its worktree output is no longer available.']
        : ['Provision an isolated worktree before this implementation can be compared.'],
      summary: discarded
        ? `${params.agent.agentName} was discarded.`
        : `${params.agent.agentName} is waiting for an isolated worktree.`,
    }
  }

  const baseRef = params.run.branch || 'HEAD'
  const [statusRaw, committedNameStatus, committedShortStat, uncommittedNameStatus, uncommittedShortStat] = await Promise.all([
    runGitOptional(['status', '--porcelain=v1', '-z', '--untracked-files=all'], params.agent.worktreePath),
    runGitOptional(['diff', '--name-status', `${baseRef}...HEAD`], params.agent.worktreePath),
    runGitOptional(['diff', '--shortstat', `${baseRef}...HEAD`], params.agent.worktreePath),
    runGitOptional(['diff', '--name-status', 'HEAD'], params.agent.worktreePath),
    runGitOptional(['diff', '--shortstat', 'HEAD'], params.agent.worktreePath),
  ])
  const statusFiles = parsePorcelainZ(statusRaw).map(statusFileFromPorcelainEntry)
  const committedPaths = uniqueDiffPaths(committedNameStatus, [])
  const uncommittedPaths = uniqueDiffPaths(uncommittedNameStatus, statusFiles)
  const allPaths = new Set([...committedPaths, ...uncommittedPaths])
  const committedStat = parseDiffShortStat(committedShortStat)
  const uncommittedStat = parseDiffShortStat(uncommittedShortStat)
  const comparisonStatus = implementationComparisonStatus({
    agent: params.agent,
    changedFileCount: allPaths.size,
    validationStatus: params.validation.status,
  })
  const risks = implementationOptionRisks({
    agent: params.agent,
    statusFiles,
    comparisonStatus,
    validationStatus: params.validation.status,
    changedFileCount: allPaths.size,
  })

  return {
    agentId: params.agent.id,
    agentName: params.agent.agentName,
    agentStatus: params.agent.status,
    worktreeStatus: params.agent.worktreeStatus,
    branchName: params.agent.branchName,
    worktreePath: params.agent.worktreePath,
    comparisonStatus,
    changedFileCount: allPaths.size,
    committedFileCount: committedPaths.size || committedStat.files,
    uncommittedFileCount: uncommittedPaths.size || uncommittedStat.files,
    insertions: committedStat.insertions + uncommittedStat.insertions,
    deletions: committedStat.deletions + uncommittedStat.deletions,
    validationStatus: params.validation.status,
    validationCommand: params.validation.command,
    risks,
    summary: `${params.agent.agentName}: ${String(allPaths.size)} changed file${allPaths.size === 1 ? '' : 's'}, +${String(committedStat.insertions + uncommittedStat.insertions)} / -${String(committedStat.deletions + uncommittedStat.deletions)}.`,
  }
}

async function hydrateWorkflowRun(workspace: GitWorkspace, run: ToolingWorkflowRun): Promise<ToolingWorkflowRun> {
  const implementationAgents = run.agents.filter((agent) => agent.role === 'implementation')
  const auditTrail = await listWorkspaceAuditEvents({ cwd: workspace.cwd, limit: 200 })
  const validation = latestWorkflowValidationEvent(auditTrail.events.filter((event) => event.metadata.workflowRunId === run.id))
  const implementationOptions = await Promise.all(implementationAgents.map((agent) =>
    buildWorkflowImplementationOption({ run, agent, validation })
  ))
  const acceptance = buildWorkflowAcceptanceGate({ run, implementationOptions, validation })
  return {
    ...run,
    implementationOptions,
    acceptance,
  }
}

export async function listWorkspaceWorkflows(params: {
  cwd: string
  limit?: number
}): Promise<ToolingWorkflowDashboard> {
  const workspace = await getGitWorkspace(params.cwd)
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100))
  let rows: string[]

  try {
    rows = await readdir(workflowRunsRoot(workspace))
  } catch {
    return {
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      generatedAtIso: new Date().toISOString(),
      templates: BUILT_IN_WORKFLOW_TEMPLATES,
      runs: [],
      truncated: false,
    }
  }

  const runs: ToolingWorkflowRun[] = []
  for (const row of rows) {
    if (!row.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(workflowRunsRoot(workspace), row), 'utf8')) as unknown
      if (isToolingWorkflowRun(parsed) && parsed.repoRoot === workspace.repoRoot) {
        runs.push(parsed)
      }
    } catch {
      // Ignore malformed workflow files; valid runs remain visible.
    }
  }

  const hydratedRuns = await Promise.all(runs
    .sort((first, second) => second.updatedAtIso.localeCompare(first.updatedAtIso))
    .slice(0, limit)
    .map((run) => hydrateWorkflowRun(workspace, run)))

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    templates: BUILT_IN_WORKFLOW_TEMPLATES,
    runs: hydratedRuns,
    truncated: rows.length > limit,
  }
}

export async function createWorkspaceWorkflowRun(params: {
  cwd: string
  templateId: string
  goal: string
}): Promise<ToolingWorkflowRun> {
  const workspace = await getGitWorkspace(params.cwd)
  const template = workflowTemplateById(params.templateId)
  const goal = workflowGoal(params.goal)
  const [snapshot, packageInfo] = await Promise.all([
    getWorkspaceSnapshot(workspace.cwd),
    readPackageScripts(workspace.repoRoot),
  ])
  const createdAtIso = new Date().toISOString()
  const id = workflowRunId(template.id)
  const validationPlan = mergeWorkflowValidationPlan({
    template,
    config: snapshot.workspaceConfig,
    scripts: packageInfo.scripts,
  })
  const warnings = buildWorkflowWarnings({ snapshot, template })
  const agents = buildWorkflowAgents({
    runId: id,
    template,
    goal,
    branch: snapshot.branch,
    config: snapshot.workspaceConfig,
    validationPlan,
    warnings,
  })
  const riskLabels = [
    ...template.riskLabels,
    ...(snapshot.gitStatus.dirtyFileCount > 0 ? ['dirty-worktree'] : []),
    ...(snapshot.workspaceConfig.sandboxMode === 'danger' ? ['danger-sandbox'] : []),
  ].filter((item, index, all) => all.indexOf(item) === index)

  const run: ToolingWorkflowRun = {
    id,
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    templateId: template.id,
    templateName: template.name,
    goal,
    status: template.defaultStatus,
    createdAtIso,
    updatedAtIso: createdAtIso,
    branch: snapshot.branch,
    dirtyFileCount: snapshot.gitStatus.dirtyFileCount,
    agents,
    validationPlan,
    riskLabels,
    warnings,
    summary: `${template.name} prepared ${String(agents.length)} agent step${agents.length === 1 ? '' : 's'} for supervised execution.`,
  }

  await writeWorkflowRun(workspace, run)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.created',
    severity: warnings.length > 0 ? 'warning' : 'success',
    title: 'Workflow run created',
    summary: `${template.name}: ${goal.slice(0, 120)}`,
    metadata: {
      workflowRunId: run.id,
      templateId: template.id,
      agentCount: agents.length,
      validationPlanCount: validationPlan.length,
      riskLabels,
      warnings,
    },
  })

  return hydrateWorkflowRun(workspace, run)
}

export async function updateWorkspaceWorkflowAgentStatus(params: {
  cwd: string
  runId: string
  agentId: string
  status: ToolingWorkflowStepStatus | string
  note?: string
}): Promise<ToolingWorkflowRun> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const agentId = assertWorkflowAgentId(params.agentId)
  const nextStatus = assertWorkflowStepStatus(String(params.status))
  const note = params.note?.trim().slice(0, 500) ?? ''
  const run = await readWorkflowRun(workspace, runId)
  const target = run.agents.find((agent) => agent.id === agentId)
  if (!target) throw new Error('workflow agent step was not found')

  if (target.status === nextStatus) return run

  const statusById = new Map(run.agents.map((agent) => [agent.id, agent.status]))
  if (
    (nextStatus === 'ready' || nextStatus === 'running') &&
    !target.dependsOn.every((dependencyId) => isWorkflowDependencySatisfied(statusById.get(dependencyId) ?? 'queued'))
  ) {
    throw new Error('workflow agent dependencies are not complete')
  }

  const changedAgents = run.agents.map((agent) =>
    agent.id === agentId ? { ...agent, status: nextStatus } : agent
  )
  const agents = unlockReadyWorkflowAgents(changedAgents)
  const statusSummary = summarizeWorkflowRunStatus(run, agents)
  const updatedAtIso = new Date().toISOString()
  const nextRun: ToolingWorkflowRun = {
    ...run,
    agents,
    status: statusSummary.status,
    summary: statusSummary.summary,
    updatedAtIso,
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.agent_status_changed',
    severity: nextStatus === 'blocked' ? 'warning' : nextStatus === 'completed' ? 'success' : 'info',
    title: 'Workflow agent status changed',
    summary: `${target.agentName} ${target.status} -> ${nextStatus}`,
    metadata: {
      workflowRunId: run.id,
      templateId: run.templateId,
      agentId,
      agentName: target.agentName,
      previousStatus: target.status,
      nextStatus,
      runStatus: nextRun.status,
      note,
    },
  })

  return hydrateWorkflowRun(workspace, nextRun)
}

export async function provisionWorkspaceWorkflowAgentWorktree(params: {
  cwd: string
  runId: string
  agentId: string
  baseRef?: string
}): Promise<ToolingWorkflowRun> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const agentId = assertWorkflowAgentId(params.agentId)
  const run = await readWorkflowRun(workspace, runId)
  const target = run.agents.find((agent) => agent.id === agentId)
  if (!target) throw new Error('workflow agent step was not found')
  if (target.worktreePolicy === 'not-needed' || !target.branchName) {
    throw new Error('workflow agent does not require an isolated worktree')
  }

  const branchName = assertWorktreeBranchName(target.branchName)
  const existingSnapshot = await listWorkspaceWorktrees(workspace.cwd)
  let worktree = existingSnapshot.worktrees.find((candidate) => candidate.branch === branchName && candidate.isManaged)

  if (!worktree) {
    const created = await createWorkspaceWorktree({
      cwd: workspace.cwd,
      branchName,
      baseRef: params.baseRef?.trim() || run.branch || 'HEAD',
    })
    worktree = created.worktree
  }

  const updatedAtIso = new Date().toISOString()
  const agents = run.agents.map((agent) =>
    agent.id === agentId
      ? {
          ...agent,
          worktreeStatus: 'ready' as const,
          worktreePath: worktree.path,
          worktreeReadyAtIso: updatedAtIso,
        }
      : agent
  )
  const statusSummary = summarizeWorkflowRunStatus(run, agents)
  const nextRun: ToolingWorkflowRun = {
    ...run,
    agents,
    status: statusSummary.status,
    summary: `${statusSummary.summary} ${target.agentName} has an isolated worktree ready.`,
    updatedAtIso,
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.agent_worktree_provisioned',
    severity: 'success',
    title: 'Workflow agent worktree provisioned',
    summary: `${target.agentName}: ${branchName} at ${worktree.path}`,
    metadata: {
      workflowRunId: run.id,
      templateId: run.templateId,
      agentId,
      agentName: target.agentName,
      branchName,
      worktreePath: worktree.path,
      reusedExistingWorktree: existingSnapshot.worktrees.some((candidate) => candidate.path === worktree.path),
    },
  })

  return hydrateWorkflowRun(workspace, nextRun)
}

function workflowReplayEventFromAudit(event: ToolingAuditEvent): ToolingWorkflowReplayEvent {
  const agentId = typeof event.metadata.agentId === 'string' ? event.metadata.agentId : null
  const agentName = typeof event.metadata.agentName === 'string' ? event.metadata.agentName : null
  return {
    id: event.id,
    createdAtIso: event.createdAtIso,
    kind: event.kind,
    severity: event.severity,
    title: event.title,
    summary: event.summary,
    agentId,
    agentName,
    metadata: event.metadata,
  }
}

function summarizeWorkflowReplayEvidence(params: {
  run: ToolingWorkflowRun
  events: ToolingWorkflowReplayEvent[]
  validationEvidence: ToolingWorkflowReplay['validationEvidence']
}): string[] {
  const lines: string[] = [
    `${params.events.length} audited workflow event${params.events.length === 1 ? '' : 's'} captured for this run.`,
    `${String(params.run.agents.filter((agent) => agent.status === 'completed').length)} of ${String(params.run.agents.length)} agents completed.`,
  ]
  const readyWorktreeCount = params.run.agents.filter((agent) => agent.worktreeStatus === 'ready').length
  if (readyWorktreeCount > 0) {
    lines.push(`${String(readyWorktreeCount)} isolated worktree${readyWorktreeCount === 1 ? '' : 's'} ready.`)
  }
  if (params.validationEvidence.latestCommand) {
    lines.push(`Latest validation: ${params.validationEvidence.latestCommand} -> ${params.validationEvidence.latestStatus ?? 'unknown'}.`)
  } else {
    lines.push('No validation command has been linked to this workflow yet.')
  }
  if (params.run.warnings.length > 0) {
    lines.push(`${String(params.run.warnings.length)} workspace warning${params.run.warnings.length === 1 ? '' : 's'} were present when the run was created.`)
  }
  return lines
}

export async function getWorkspaceWorkflowReplay(params: {
  cwd: string
  runId: string
}): Promise<ToolingWorkflowReplay> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const rawRun = await readWorkflowRun(workspace, runId)
  const run = await hydrateWorkflowRun(workspace, rawRun)
  const [auditTrail, validationHistory] = await Promise.all([
    listWorkspaceAuditEvents({ cwd: workspace.cwd, limit: 200 }),
    listWorkspaceValidationRuns({ cwd: workspace.cwd, limit: 50 }),
  ])
  const events = auditTrail.events
    .filter((event) => event.metadata.workflowRunId === run.id)
    .map(workflowReplayEventFromAudit)
    .sort((first, second) => first.createdAtIso.localeCompare(second.createdAtIso))
  const validationMatches = validationHistory.runs.filter((validationRun) =>
    events.some((event) => event.metadata.command === validationRun.command || event.metadata.scriptName === validationRun.scriptName)
  )
  const latestValidation = validationMatches[0] ?? null
  const validationEvidence: ToolingWorkflowReplay['validationEvidence'] = {
    totalRuns: validationHistory.runs.length,
    matchedRuns: validationMatches.length,
    latestStatus: latestValidation?.status ?? null,
    latestCommand: latestValidation?.command ?? null,
    latestEndedAtIso: latestValidation?.endedAtIso ?? null,
  }

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    run,
    events,
    agentSnapshots: run.agents.map((agent) => ({
      id: agent.id,
      agentName: agent.agentName,
      role: agent.role,
      status: agent.status,
      worktreeStatus: agent.worktreeStatus,
      branchName: agent.branchName,
      worktreePath: agent.worktreePath,
    })),
    validationEvidence,
    evidenceSummary: summarizeWorkflowReplayEvidence({ run, events, validationEvidence }),
  }
}

export async function runWorkspaceWorkflowValidation(params: {
  cwd: string
  runId: string
  scriptName: string
}): Promise<ToolingWorkflowValidationResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const scriptName = assertPackageScriptName(params.scriptName)
  const run = await readWorkflowRun(workspace, runId)
  const allowedScriptNames = workflowValidationScriptNames(run)
  if (!allowedScriptNames.has(scriptName)) {
    throw new Error('scriptName is not part of this workflow validation plan')
  }

  const validationRun = await runWorkspaceScript({ cwd: workspace.cwd, scriptName })
  const updatedAtIso = new Date().toISOString()
  const nextRun: ToolingWorkflowRun = {
    ...run,
    status: validationRun.status === 'passed' ? run.status : 'failed',
    summary: `${run.templateName} validation ${scriptName} ${validationRun.status}.`,
    updatedAtIso,
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.validation_ran',
    severity: validationRun.status === 'passed' ? 'success' : 'danger',
    title: 'Workflow validation ran',
    summary: `${validationRun.command} -> ${validationRun.status}`,
    metadata: {
      workflowRunId: run.id,
      templateId: run.templateId,
      scriptName,
      command: validationRun.command,
      status: validationRun.status,
      exitCode: validationRun.exitCode,
      durationMs: validationRun.durationMs,
      truncated: validationRun.truncated,
      problemCount: validationRun.problems.length,
    },
  })

  const hydratedRun = await hydrateWorkflowRun(workspace, nextRun)

  return {
    run: hydratedRun,
    validationRun,
    replay: await getWorkspaceWorkflowReplay({ cwd: workspace.cwd, runId: run.id }),
  }
}

function buildWorkflowDeliveryBody(params: {
  run: ToolingWorkflowRun
  reviewDraft: ToolingWorkspaceReviewDraft
  replay: ToolingWorkflowReplay
  riskSummary: string[]
  warnings: string[]
}): string {
  const applied = params.run.appliedImplementation
  const discarded = params.run.discardedImplementations ?? []
  const acceptance = params.run.acceptance
  const validation = params.replay.validationEvidence
  const optionRows = (params.run.implementationOptions ?? []).slice(0, 6).map((option) =>
    `- ${option.agentName}: ${option.comparisonStatus}, ${String(option.changedFileCount)} file(s), validation ${option.validationStatus}`
  )

  return [
    '## Summary',
    `- Workflow: ${params.run.templateName}`,
    `- Goal: ${params.run.goal}`,
    `- Status: ${params.run.status}`,
    applied
      ? `- Applied implementation: ${applied.agentName} (${String(applied.changedFileCount)} file(s), checkpoint ${applied.checkpointId})`
      : '- Applied implementation: none recorded',
    '',
    '## Acceptance',
    acceptance
      ? `- ${acceptance.label}: ${acceptance.summary}`
      : '- No acceptance gate was available for this workflow.',
    acceptance?.validationCommand
      ? `- Latest validation command: ${acceptance.validationCommand} (${acceptance.validationStatus})`
      : `- Latest validation status: ${acceptance?.validationStatus ?? 'missing'}`,
    `- Agents complete: ${String(acceptance?.completedAgentCount ?? 0)} / ${String(acceptance?.totalAgentCount ?? params.run.agents.length)}`,
    '',
    '## Implementation Options',
    ...optionRows.length > 0 ? optionRows : ['- No implementation options were recorded.'],
    ...discarded.length > 0
      ? [
          '',
          '## Discarded Options',
          ...discarded.map((item) => `- ${item.agentName}: ${item.reason}`),
        ]
      : [],
    '',
    '## Validation Evidence',
    `- Matched workflow validation runs: ${String(validation.matchedRuns)} / ${String(validation.totalRuns)}.`,
    validation.latestCommand
      ? `- Latest: ${validation.latestCommand} -> ${validation.latestStatus ?? 'unknown'}.`
      : '- No linked validation command was found.',
    '',
    '## Workspace Diff',
    params.reviewDraft.prBody,
    '',
    '## Risk',
    ...params.riskSummary.map((item) => `- ${item}`),
    ...params.warnings.length > 0
      ? [
          '',
          '## Warnings',
          ...params.warnings.map((item) => `- ${item}`),
        ]
      : [],
  ].join('\n')
}

export async function getWorkspaceWorkflowDeliveryDraft(params: {
  cwd: string
  runId: string
}): Promise<ToolingWorkflowDeliveryDraft> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const [replay, reviewDraft] = await Promise.all([
    getWorkspaceWorkflowReplay({ cwd: workspace.cwd, runId }),
    getWorkspaceReviewDraft(workspace.cwd),
  ])
  const run = replay.run
  const acceptanceRisks = run.acceptance?.risks ?? []
  const riskSummary = Array.from(new Set([
    ...reviewDraft.riskSummary,
    ...acceptanceRisks,
    ...run.riskLabels.map((label) => `Workflow risk: ${label}.`),
  ])).slice(0, 16)
  const warnings = Array.from(new Set([
    ...reviewDraft.warnings,
    ...run.warnings,
    ...run.acceptance?.status === 'accepted' || run.acceptance?.status === 'ready_for_review'
      ? []
      : ['Workflow acceptance is not green yet.'],
    ...reviewDraft.hasReviewChanges ? [] : ['No workspace diff is currently available for PR generation.'],
  ])).slice(0, 16)
  const title = normalizePullRequestTitle(`${run.templateName}: ${run.goal}`)
  const body = buildWorkflowDeliveryBody({ run, reviewDraft, replay, riskSummary, warnings })
  const commitMessage = [
    title,
    '',
    `Workflow: ${run.id}`,
    `Acceptance: ${run.acceptance?.status ?? 'unknown'}`,
    ...reviewDraft.files.slice(0, 8).map((file) => `- ${file.status} ${file.path}`),
  ].join('\n')

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    runId: run.id,
    templateName: run.templateName,
    goal: run.goal,
    status: run.status,
    title,
    body,
    commitMessage,
    reviewDraft,
    acceptance: run.acceptance ?? null,
    appliedImplementation: run.appliedImplementation ?? null,
    discardedImplementations: run.discardedImplementations ?? [],
    validationEvidence: replay.validationEvidence,
    riskSummary,
    warnings,
  }
}

function workflowAcceptanceIsGreen(run: ToolingWorkflowRun): boolean {
  return run.acceptance?.status === 'accepted' || run.acceptance?.status === 'ready_for_review'
}

export async function markWorkspaceWorkflowReadyToMerge(params: {
  cwd: string
  runId: string
  note?: string
}): Promise<ToolingWorkflowDeliveryStatusResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const rawRun = await readWorkflowRun(workspace, runId)
  const hydratedRun = await hydrateWorkflowRun(workspace, rawRun)
  if (!workflowAcceptanceIsGreen(hydratedRun)) {
    throw new Error('Workflow acceptance must be green before marking ready to merge')
  }

  const readyToMergeAtIso = new Date().toISOString()
  const deliveryState: ToolingWorkflowDeliveryState = {
    readyToMergeAtIso: rawRun.deliveryState?.readyToMergeAtIso ?? readyToMergeAtIso,
    mergedAtIso: rawRun.deliveryState?.mergedAtIso ?? null,
    commitHash: rawRun.deliveryState?.commitHash ?? null,
    pullRequestUrl: rawRun.deliveryState?.pullRequestUrl ?? null,
    note: (params.note ?? '').trim() || rawRun.deliveryState?.note || '',
  }
  const nextRun: ToolingWorkflowRun = {
    ...rawRun,
    status: rawRun.status === 'merged' ? 'merged' : 'ready_to_merge',
    summary: `${rawRun.templateName} is ready to merge with green workflow acceptance.`,
    updatedAtIso: readyToMergeAtIso,
    deliveryState,
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.ready_to_merge',
    severity: 'success',
    title: 'Workflow ready to merge',
    summary: `${rawRun.templateName}: ${rawRun.goal}`,
    metadata: {
      workflowRunId: rawRun.id,
      templateId: rawRun.templateId,
      acceptanceStatus: hydratedRun.acceptance?.status ?? 'unknown',
      note: deliveryState.note,
    },
  })

  return {
    run: await hydrateWorkflowRun(workspace, nextRun),
    deliveryState,
  }
}

export async function markWorkspaceWorkflowMerged(params: {
  cwd: string
  runId: string
  commitHash?: string
  pullRequestUrl?: string
  note?: string
}): Promise<ToolingWorkflowDeliveryStatusResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const rawRun = await readWorkflowRun(workspace, runId)
  const hydratedRun = await hydrateWorkflowRun(workspace, rawRun)
  if (!workflowAcceptanceIsGreen(hydratedRun) && rawRun.status !== 'ready_to_merge') {
    throw new Error('Workflow must be accepted or ready to merge before marking merged')
  }

  const mergedAtIso = new Date().toISOString()
  const commitHash = normalizeOptionalCommitHash(params.commitHash)
    ?? rawRun.deliveryState?.commitHash
    ?? (await runGit(['rev-parse', 'HEAD'], workspace.repoRoot)).trim()
  const pullRequestUrl = normalizeOptionalPullRequestUrl(params.pullRequestUrl)
    ?? rawRun.deliveryState?.pullRequestUrl
    ?? null
  const deliveryState: ToolingWorkflowDeliveryState = {
    readyToMergeAtIso: rawRun.deliveryState?.readyToMergeAtIso ?? mergedAtIso,
    mergedAtIso,
    commitHash,
    pullRequestUrl,
    note: (params.note ?? '').trim() || rawRun.deliveryState?.note || '',
  }
  const nextRun: ToolingWorkflowRun = {
    ...rawRun,
    status: 'merged',
    summary: `${rawRun.templateName} was marked merged at ${commitHash.slice(0, 12)}.`,
    updatedAtIso: mergedAtIso,
    deliveryState,
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.merged',
    severity: 'success',
    title: 'Workflow marked merged',
    summary: `${rawRun.templateName}: ${commitHash.slice(0, 12)}`,
    metadata: {
      workflowRunId: rawRun.id,
      templateId: rawRun.templateId,
      commitHash,
      pullRequestUrl,
      note: deliveryState.note,
    },
  })

  return {
    run: await hydrateWorkflowRun(workspace, nextRun),
    deliveryState,
  }
}

export async function applyWorkspaceWorkflowImplementation(params: {
  cwd: string
  runId: string
  agentId: string
}): Promise<ToolingWorkflowImplementationApplyResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const agentId = assertWorkflowAgentId(params.agentId)
  const rawRun = await readWorkflowRun(workspace, runId)
  const hydratedRun = await hydrateWorkflowRun(workspace, rawRun)
  const agent = hydratedRun.agents.find((candidate) => candidate.id === agentId)
  if (!agent || agent.role !== 'implementation') throw new Error('workflow implementation agent was not found')
  if (agent.worktreeStatus !== 'ready' || !agent.worktreePath) {
    throw new Error('implementation agent worktree is not ready')
  }

  const option = hydratedRun.implementationOptions?.find((candidate) => candidate.agentId === agentId)
  if (!option || option.comparisonStatus !== 'ready_to_merge') {
    throw new Error('implementation option must be completed and validated before it can be applied')
  }

  const workspaceStatusRaw = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], workspace.repoRoot)
  if (workspaceStatusRaw.trim()) {
    throw new Error('Workspace must be clean before applying an implementation option')
  }

  const worktreeStatusRaw = await runGitOptional(['status', '--porcelain=v1', '-z', '--untracked-files=all'], agent.worktreePath)
  const worktreeStatusFiles = parsePorcelainZ(worktreeStatusRaw).map(statusFileFromPorcelainEntry)
  const untrackedFiles = worktreeStatusFiles.filter((file) => file.status === '??')
  if (untrackedFiles.length > 0) {
    throw new Error('Implementation worktree has untracked files; commit or remove them before applying this option')
  }

  const baseRef = hydratedRun.branch || 'HEAD'
  const [committedPatch, uncommittedPatch, committedNameStatus, uncommittedNameStatus] = await Promise.all([
    runGitOptional(['diff', '--binary', `${baseRef}...HEAD`], agent.worktreePath),
    runGitOptional(['diff', '--binary', 'HEAD'], agent.worktreePath),
    runGitOptional(['diff', '--name-status', `${baseRef}...HEAD`], agent.worktreePath),
    runGitOptional(['diff', '--name-status', 'HEAD'], agent.worktreePath),
  ])
  const patch = [committedPatch, uncommittedPatch]
    .filter((item) => item.trim())
    .join('\n')
  if (!patch.trim()) throw new Error('No tracked implementation diff is available to apply')

  const changedPaths = uniqueDiffPaths(committedNameStatus, worktreeStatusFiles)
  for (const path of uniqueDiffPaths(uncommittedNameStatus, worktreeStatusFiles)) {
    changedPaths.add(path)
  }

  await runCommandWithInput('git', ['apply', '--check', '-'], workspace.repoRoot, patch)
  const checkpoint = await createToolingCheckpoint({
    cwd: workspace.cwd,
    label: `Before applying ${agent.agentName}`,
  })
  await runCommandWithInput('git', ['apply', '-'], workspace.repoRoot, patch)

  const appliedAtIso = new Date().toISOString()
  const appliedImplementation: ToolingWorkflowAppliedImplementation = {
    agentId: agent.id,
    agentName: agent.agentName,
    branchName: agent.branchName,
    worktreePath: agent.worktreePath,
    appliedAtIso,
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    changedFileCount: changedPaths.size,
    checkpointId: checkpoint.id,
  }
  const nextRun: ToolingWorkflowRun = {
    ...rawRun,
    status: 'ready_for_review',
    summary: `${rawRun.templateName} applied ${agent.agentName}; review the workspace diff before delivery.`,
    updatedAtIso: appliedAtIso,
    appliedImplementation,
  }
  await writeWorkflowRun(workspace, nextRun)
  const targetStatus = await getWorkspaceGitStatus(workspace.cwd)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.implementation_applied',
    severity: 'success',
    title: 'Workflow implementation applied',
    summary: `${agent.agentName}: ${String(changedPaths.size)} changed file${changedPaths.size === 1 ? '' : 's'} applied to workspace`,
    metadata: {
      workflowRunId: rawRun.id,
      templateId: rawRun.templateId,
      agentId: agent.id,
      agentName: agent.agentName,
      branchName: agent.branchName,
      worktreePath: agent.worktreePath,
      patchBytes: appliedImplementation.patchBytes,
      changedFileCount: changedPaths.size,
      checkpointId: checkpoint.id,
    },
  })

  return {
    run: await hydrateWorkflowRun(workspace, nextRun),
    appliedImplementation,
    checkpoint,
    targetStatus,
  }
}

export async function discardWorkspaceWorkflowImplementation(params: {
  cwd: string
  runId: string
  agentId: string
  reason?: string
}): Promise<ToolingWorkflowImplementationDiscardResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const runId = assertWorkflowRunId(params.runId)
  const agentId = assertWorkflowAgentId(params.agentId)
  const rawRun = await readWorkflowRun(workspace, runId)
  const agent = rawRun.agents.find((candidate) => candidate.id === agentId)
  if (!agent || agent.role !== 'implementation') throw new Error('workflow implementation agent was not found')
  if (rawRun.appliedImplementation?.agentId === agentId) {
    throw new Error('Applied implementation options cannot be discarded from the workflow panel')
  }

  const discardedAtIso = new Date().toISOString()
  const reason = (params.reason ?? '').trim() || 'Discarded by user.'
  let removedWorktreePath: string | null = null
  if (agent.worktreePath) {
    const managedRoot = managedWorktreeRoot(workspace.repoRoot)
    const targetPath = resolve(agent.worktreePath)
    if (!isInside(managedRoot, targetPath)) {
      throw new Error('Only managed workflow worktrees can be discarded from this panel')
    }
    const snapshot = await listWorkspaceWorktrees(workspace.cwd)
    const target = snapshot.worktrees.find((worktree) => worktree.path === targetPath)
    if (target && !target.isCurrent) {
      await runGit(['worktree', 'remove', '--force', targetPath], workspace.repoRoot)
      removedWorktreePath = targetPath
    }
  }

  const nextAgents = unlockReadyWorkflowAgents(rawRun.agents.map((candidate) =>
    candidate.id === agentId
      ? {
          ...candidate,
          status: 'skipped' as const,
          worktreeStatus: 'discarded' as const,
          worktreePath: null,
          worktreeReadyAtIso: null,
        }
      : candidate
  ))
  const statusSummary = summarizeWorkflowRunStatus(rawRun, nextAgents)
  const discardedImplementation: ToolingWorkflowDiscardedImplementation = {
    agentId: agent.id,
    agentName: agent.agentName,
    branchName: agent.branchName,
    worktreePath: agent.worktreePath,
    discardedAtIso,
    reason,
  }
  const previousDiscarded = rawRun.discardedImplementations ?? []
  const nextRun: ToolingWorkflowRun = {
    ...rawRun,
    agents: nextAgents,
    status: statusSummary.status,
    summary: `${statusSummary.summary} ${agent.agentName} was discarded.`,
    updatedAtIso: discardedAtIso,
    discardedImplementations: [
      ...previousDiscarded.filter((item) => item.agentId !== agent.id),
      discardedImplementation,
    ],
  }

  await writeWorkflowRun(workspace, nextRun)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'workflow.implementation_discarded',
    severity: 'warning',
    title: 'Workflow implementation discarded',
    summary: `${agent.agentName} discarded${removedWorktreePath ? ` and removed ${removedWorktreePath}` : ''}`,
    metadata: {
      workflowRunId: rawRun.id,
      templateId: rawRun.templateId,
      agentId: agent.id,
      agentName: agent.agentName,
      branchName: agent.branchName,
      worktreePath: agent.worktreePath,
      removedWorktreePath,
      reason,
    },
  })

  return {
    run: await hydrateWorkflowRun(workspace, nextRun),
    discardedImplementation,
    removedWorktreePath,
  }
}

export async function getWorkspaceDiffSnapshot(cwd: string): Promise<ToolingDiffSnapshot> {
  const workspace = await getGitWorkspace(cwd)
  const [status, patch] = await Promise.all([
    runGit(['status', '--porcelain=v1'], workspace.repoRoot),
    runGit(['diff', '--binary'], workspace.repoRoot),
  ])

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    status,
    patch,
  }
}

export async function getWorkspaceGitStatus(cwd: string): Promise<ToolingGitStatusSnapshot> {
  const workspace = await getGitWorkspace(cwd)
  const [statusRaw, branch, upstream] = await Promise.all([
    runGitOptional(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace.repoRoot),
    runGitOptional(['branch', '--show-current'], workspace.repoRoot),
    runGitOptional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], workspace.repoRoot),
  ])
  const files = parsePorcelainZ(statusRaw).map(statusFileFromPorcelainEntry)

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch: branch.trim(),
    upstream: upstream.trim(),
    generatedAtIso: new Date().toISOString(),
    ...gitStatusCounts(files),
    files: files.slice(0, 100),
  }
}

export async function getWorkspaceGitDeliveryDraft(cwd: string): Promise<ToolingGitDeliveryDraft> {
  const workspace = await getGitWorkspace(cwd)
  const [status, nameStatusRaw, numStatRaw, statRaw] = await Promise.all([
    getWorkspaceGitStatus(workspace.cwd),
    runGitOptional(['diff', '--cached', '--name-status'], workspace.repoRoot),
    runGitOptional(['diff', '--cached', '--numstat'], workspace.repoRoot),
    runGitOptional(['diff', '--cached', '--stat'], workspace.repoRoot),
  ])
  const numStats = parseNumStat(numStatRaw)
  const files: ToolingGitDeliveryFile[] = parseNameStatus(nameStatusRaw).map((file) => {
    const stats = numStats.get(file.path)
    return {
      path: file.path,
      status: file.status,
      insertions: stats?.insertions ?? null,
      deletions: stats?.deletions ?? null,
    }
  })
  const insertions = files.reduce((total, file) => total + (file.insertions ?? 0), 0)
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  const hasStagedChanges = files.length > 0
  const riskSummary = hasStagedChanges ? buildRiskSummary(files) : ['No staged changes to review.']
  const validationPlan = hasStagedChanges ? buildValidationPlan(files) : []
  const subject = hasStagedChanges ? buildCommitSubject(files) : 'No staged changes'
  const commitMessage = hasStagedChanges
    ? [
        subject,
        '',
        ...files.slice(0, 8).map((file) => `- ${file.status} ${file.path}`),
      ].join('\n')
    : subject

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch: status.branch,
    upstream: status.upstream,
    generatedAtIso: new Date().toISOString(),
    hasStagedChanges,
    files,
    fileCount: files.length,
    insertions,
    deletions,
    stat: statRaw,
    commitMessage,
    prBody: hasStagedChanges
      ? buildPrBody({
          files,
          insertions,
          deletions,
          stat: statRaw,
          riskSummary,
          validationPlan,
        })
      : 'Stage files to generate a PR body draft.',
    riskSummary,
    validationPlan,
  }
}

export async function getWorkspaceReviewDraft(cwd: string): Promise<ToolingWorkspaceReviewDraft> {
  const workspace = await getGitWorkspace(cwd)
  const [status, nameStatusRaw, numStatRaw, statRaw] = await Promise.all([
    getWorkspaceGitStatus(workspace.cwd),
    runGitOptional(['diff', '--name-status', 'HEAD'], workspace.repoRoot),
    runGitOptional(['diff', '--numstat', 'HEAD'], workspace.repoRoot),
    runGitOptional(['diff', '--stat', 'HEAD'], workspace.repoRoot),
  ])
  const files = deliveryFilesFromDiff(nameStatusRaw, numStatRaw)
  const untrackedFiles = status.files
    .filter((file) => file.status === '??')
    .map((file) => file.path)
    .sort((first, second) => first.localeCompare(second))
  const insertions = sumDeliveryInsertions(files)
  const deletions = sumDeliveryDeletions(files)
  const hasReviewChanges = files.length > 0 || untrackedFiles.length > 0
  const riskSummary = files.length > 0
    ? buildRiskSummary(files)
    : ['No tracked diff is available to assess path-level risk.']
  const validationPlan = files.length > 0 ? buildValidationPlan(files) : []
  const warnings = [
    ...untrackedFiles.length > 0
      ? [`${String(untrackedFiles.length)} untracked file(s) are not included in the generated patch until staged.`]
      : [],
    ...files.length === 0 && untrackedFiles.length > 0
      ? ['Only untracked files were found; review file contents before generating a final patch or PR body.']
      : [],
  ]
  const subject = files.length > 0 ? buildCommitSubject(files) : (untrackedFiles.length > 0 ? 'Add untracked workspace files' : 'No workspace changes')
  const commitMessage = files.length > 0
    ? [
        subject,
        '',
        ...files.slice(0, 8).map((file) => `- ${file.status} ${file.path}`),
        ...untrackedFiles.slice(0, 4).map((path) => `- ?? ${path}`),
      ].join('\n')
    : subject

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch: status.branch,
    upstream: status.upstream,
    generatedAtIso: new Date().toISOString(),
    source: 'workspace_diff',
    hasStagedChanges: status.stagedFileCount > 0,
    hasReviewChanges,
    files,
    fileCount: files.length,
    insertions,
    deletions,
    stat: statRaw,
    commitMessage,
    prBody: files.length > 0
      ? buildPrBody({
          files,
          insertions,
          deletions,
          stat: statRaw,
          riskSummary,
          validationPlan,
          changeLabel: 'reviewed',
        })
      : (untrackedFiles.length > 0
          ? 'Stage or track files to generate a patch-backed PR body draft.'
          : 'No workspace changes to generate a review draft.'),
    riskSummary,
    validationPlan,
    untrackedFiles,
    warnings,
  }
}

async function gitRefExists(workspace: GitWorkspace, ref: string): Promise<boolean> {
  return (await runGitOptional(['rev-parse', '--verify', `${ref}^{commit}`], workspace.repoRoot)).trim().length > 0
}

async function detectDefaultPullRequestBaseBranch(workspace: GitWorkspace, currentBranch: string): Promise<string> {
  const remoteHead = (await runGitOptional(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], workspace.repoRoot)).trim()
  const remoteHeadBranch = assertPullRequestBaseBranch(remoteHead)
  if (remoteHeadBranch) return remoteHeadBranch

  if (await gitRefExists(workspace, 'main')) return 'main'
  if (await gitRefExists(workspace, 'master')) return 'master'
  return currentBranch || 'main'
}

async function resolvePullRequestBaseRef(workspace: GitWorkspace, baseBranch: string): Promise<string> {
  const remoteRef = `origin/${baseBranch}`
  if (await gitRefExists(workspace, remoteRef)) return remoteRef
  if (await gitRefExists(workspace, baseBranch)) return baseBranch
  return baseBranch
}

function deliveryFilesFromDiff(nameStatusRaw: string, numStatRaw: string): ToolingGitDeliveryFile[] {
  const numStats = parseNumStat(numStatRaw)
  return parseNameStatus(nameStatusRaw).map((file) => {
    const stats = numStats.get(file.path)
    return {
      path: file.path,
      status: file.status,
      insertions: stats?.insertions ?? null,
      deletions: stats?.deletions ?? null,
    }
  })
}

function sumDeliveryInsertions(files: ToolingGitDeliveryFile[]): number {
  return files.reduce((total, file) => total + (file.insertions ?? 0), 0)
}

function sumDeliveryDeletions(files: ToolingGitDeliveryFile[]): number {
  return files.reduce((total, file) => total + (file.deletions ?? 0), 0)
}

export async function getWorkspacePullRequestDraft(params: {
  cwd: string
  baseBranch?: string
}): Promise<ToolingPullRequestDraft> {
  const workspace = await getGitWorkspace(params.cwd)
  const status = await getWorkspaceGitStatus(workspace.cwd)
  const branch = status.branch
  const baseBranch = assertPullRequestBaseBranch(params.baseBranch)
    ?? await detectDefaultPullRequestBaseBranch(workspace, branch)
  const baseRef = await resolvePullRequestBaseRef(workspace, baseBranch)
  const remote = (await runGitOptional(['remote', 'get-url', 'origin'], workspace.repoRoot)).trim()
  const warnings: string[] = []

  if (!branch) warnings.push('Current HEAD is detached; gh may require an explicit head branch.')
  if (branch && branch === baseBranch) warnings.push('Current branch matches the selected base branch.')
  if (!remote) warnings.push('No origin remote is configured for this repository.')
  if (status.stagedFileCount + status.unstagedFileCount + status.untrackedFileCount + status.conflictedFileCount > 0) {
    warnings.push('Workspace has uncommitted changes that will not be included in this PR.')
  }
  if (!(await gitRefExists(workspace, baseRef))) {
    warnings.push(`Base ref ${baseRef} could not be verified locally.`)
  }

  const mergeBase = (await runGitOptional(['merge-base', 'HEAD', baseRef], workspace.repoRoot)).trim()
  const comparisonBase = mergeBase || baseRef
  const commitRange = `${comparisonBase}..HEAD`
  const diffRange = `${comparisonBase}...HEAD`
  const [commitsRaw, nameStatusRaw, numStatRaw] = await Promise.all([
    runGitOptional(['log', '--format=%s', commitRange], workspace.repoRoot),
    runGitOptional(['diff', '--name-status', diffRange], workspace.repoRoot),
    runGitOptional(['diff', '--numstat', diffRange], workspace.repoRoot),
  ])
  const commits = commitsRaw.split('\n').map((line) => line.trim()).filter(Boolean)
  const files = deliveryFilesFromDiff(nameStatusRaw, numStatRaw)
  const insertions = sumDeliveryInsertions(files)
  const deletions = sumDeliveryDeletions(files)
  if (commits.length === 0) warnings.push('No commits were found against the selected base branch.')
  if (files.length === 0) warnings.push('No file changes were found against the selected base branch.')

  const title = normalizePullRequestTitle(commits[0] || (files.length > 0 ? buildCommitSubject(files) : `Update ${branch || 'workspace'}`))
  const generatedWarnings = Array.from(new Set(warnings))
  const body = buildPullRequestBody({
    branch,
    baseBranch,
    files,
    insertions,
    deletions,
    commits,
    warnings: generatedWarnings,
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch,
    baseBranch,
    remote,
    generatedAtIso: new Date().toISOString(),
    commitCount: commits.length,
    commits,
    files,
    fileCount: files.length,
    insertions,
    deletions,
    title,
    body,
    warnings: generatedWarnings,
  }
}

export async function commitStagedWorkspaceChanges(params: {
  cwd: string
  commitMessage?: string
}): Promise<ToolingGitCommitResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const draft = await getWorkspaceGitDeliveryDraft(workspace.cwd)
  if (!draft.hasStagedChanges) throw new Error('No staged changes to commit')

  const commitMessage = normalizeCommitMessage(params.commitMessage?.trim() || draft.commitMessage)
  const messagePath = join(workspace.gitCommonDir, 'cody-web-ui-audit', `commit-message-${randomUUID()}.txt`)
  await mkdir(dirname(messagePath), { recursive: true })
  try {
    await writeFile(messagePath, `${commitMessage}\n`, 'utf8')
    await runGit(['commit', '-F', messagePath], workspace.repoRoot)
  } finally {
    await rm(messagePath, { force: true })
  }

  const commitHash = (await runGit(['rev-parse', 'HEAD'], workspace.repoRoot)).trim()
  const status = await getWorkspaceGitStatus(workspace.cwd)
  const committedAtIso = new Date().toISOString()

  await appendWorkspaceAuditEvent(workspace, {
    kind: 'git.commit_created',
    severity: 'success',
    title: 'Git commit created',
    summary: `Created commit ${commitHash.slice(0, 12)} from ${String(draft.fileCount)} staged file${draft.fileCount === 1 ? '' : 's'}`,
    metadata: {
      commitHash,
      branch: status.branch,
      fileCount: draft.fileCount,
      insertions: draft.insertions,
      deletions: draft.deletions,
      files: draft.files.map((file) => file.path).slice(0, 30),
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch: status.branch,
    commitHash,
    commitMessage,
    committedAtIso,
    draft,
    status,
  }
}

export async function createWorkspacePullRequest(params: {
  cwd: string
  title?: string
  body?: string
  baseBranch?: string
  draft?: boolean
  dryRun?: boolean
}): Promise<ToolingPullRequestCreateResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const draft = await getWorkspacePullRequestDraft({
    cwd: workspace.cwd,
    baseBranch: params.baseBranch,
  })
  if (!draft.branch) throw new Error('Cannot create a PR from a detached HEAD')
  if (draft.branch === draft.baseBranch) throw new Error('Cannot create a PR when branch matches baseBranch')
  if (draft.commitCount === 0) throw new Error('Cannot create a PR without commits ahead of the base branch')

  const title = normalizePullRequestTitle(params.title || draft.title)
  const body = normalizePullRequestBody(params.body || draft.body)
  const isDraft = params.draft ?? true
  const dryRun = params.dryRun ?? false
  const createdAtIso = new Date().toISOString()
  const bodyPath = join(workspace.gitCommonDir, 'cody-web-ui-audit', `pr-body-${randomUUID()}.md`)
  await mkdir(dirname(bodyPath), { recursive: true })
  await writeFile(bodyPath, `${body}\n`, 'utf8')

  const args = [
    'pr',
    'create',
    '--base',
    draft.baseBranch,
    '--head',
    draft.branch,
    '--title',
    title,
    '--body-file',
    bodyPath,
  ]
  if (isDraft) args.push('--draft')

  let stdout = ''
  let stderr = ''
  let url = ''
  try {
    if (!dryRun) {
      const result = await execFileAsync('gh', args, {
        cwd: workspace.repoRoot,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      }) as { stdout: string; stderr: string }
      stdout = result.stdout
      stderr = result.stderr
      url = stdout.match(/https?:\/\/\S+/u)?.[0] ?? ''
      if (!url) {
        throw new Error('gh pr create did not return a pull request URL')
      }
    }
  } finally {
    if (!dryRun) {
      await rm(bodyPath, { force: true })
    }
  }

  await appendWorkspaceAuditEvent(workspace, {
    kind: dryRun ? 'git.pr_create_dry_run' : 'git.pr_created',
    severity: dryRun ? 'info' : 'success',
    title: dryRun ? 'Pull request create dry-run' : 'Pull request created',
    summary: dryRun
      ? `Prepared gh pr create for ${draft.branch} -> ${draft.baseBranch}`
      : `Created PR for ${draft.branch} -> ${draft.baseBranch}`,
    metadata: {
      branch: draft.branch,
      baseBranch: draft.baseBranch,
      title,
      draft: isDraft,
      dryRun,
      command: ['gh', ...args],
      url,
      commitCount: draft.commitCount,
      fileCount: draft.fileCount,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    branch: draft.branch,
    baseBranch: draft.baseBranch,
    title,
    body,
    draft: isDraft,
    dryRun,
    command: ['gh', ...args],
    url,
    stdout,
    stderr,
    createdAtIso,
  }
}

export async function listWorkspaceWorktrees(cwd: string): Promise<ToolingWorktreeSnapshot> {
  const workspace = await getGitWorkspace(cwd)
  const managedRoot = managedWorktreeRoot(workspace.repoRoot)
  const raw = await runGit(['worktree', 'list', '--porcelain'], workspace.repoRoot)
  const worktrees = parseGitWorktreePorcelain(raw, workspace.cwd, managedRoot)
  const warnings: string[] = []
  if (worktrees.some((worktree) => worktree.prunable)) {
    warnings.push('One or more worktrees are prunable. Review or remove stale isolated workspaces.')
  }

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    managedRoot,
    generatedAtIso: new Date().toISOString(),
    worktrees,
    warnings,
  }
}

export async function createWorkspaceWorktree(params: {
  cwd: string
  branchName: string
  baseRef?: string
}): Promise<ToolingWorktreeCreateResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const branchName = assertWorktreeBranchName(params.branchName)
  const baseRef = assertWorktreeBaseRef(params.baseRef)
  const managedRoot = managedWorktreeRoot(workspace.repoRoot)
  const worktreePath = resolve(managedRoot, branchNameToDirectoryName(branchName))
  if (!isInside(managedRoot, worktreePath)) {
    throw new Error('worktree path must stay inside the managed worktree root')
  }

  await mkdir(managedRoot, { recursive: true })
  await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseRef], workspace.repoRoot)
  const snapshot = await listWorkspaceWorktrees(workspace.cwd)
  const worktree = snapshot.worktrees.find((candidate) => candidate.path === worktreePath)
  if (!worktree) throw new Error('Created worktree was not found')
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'worktree.created',
    severity: 'success',
    title: 'Worktree created',
    summary: `${branchName} at ${worktreePath}`,
    metadata: {
      branchName,
      baseRef,
      path: worktreePath,
    },
  })

  return {
    worktree,
    snapshot,
  }
}

export async function removeWorkspaceWorktree(params: {
  cwd: string
  path: string
}): Promise<ToolingWorktreeRemoveResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const managedRoot = managedWorktreeRoot(workspace.repoRoot)
  const targetPath = resolve(params.path.trim())
  if (!params.path.trim()) throw new Error('path is required')
  if (!isInside(managedRoot, targetPath)) {
    throw new Error('Only managed worktrees can be removed from this panel')
  }

  const snapshot = await listWorkspaceWorktrees(workspace.cwd)
  const target = snapshot.worktrees.find((worktree) => worktree.path === targetPath)
  if (!target) throw new Error('worktree was not found')
  if (target.isCurrent) throw new Error('Cannot remove the current workspace worktree')

  await runGit(['worktree', 'remove', '--force', targetPath], workspace.repoRoot)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'worktree.removed',
    severity: 'warning',
    title: 'Worktree removed',
    summary: targetPath,
    metadata: {
      path: targetPath,
      branch: target.branch,
    },
  })

  return {
    removedPath: targetPath,
    snapshot: await listWorkspaceWorktrees(workspace.cwd),
  }
}

export async function applyWorkspacePatchToWorktree(params: {
  cwd: string
  path: string
}): Promise<ToolingWorktreeApplyPatchResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const managedRoot = managedWorktreeRoot(workspace.repoRoot)
  const targetPath = resolve(params.path.trim())
  if (!params.path.trim()) throw new Error('path is required')
  if (!isInside(managedRoot, targetPath)) {
    throw new Error('Only managed worktrees can receive patches from this panel')
  }

  const beforeSnapshot = await listWorkspaceWorktrees(workspace.cwd)
  const target = beforeSnapshot.worktrees.find((worktree) => worktree.path === targetPath)
  if (!target) throw new Error('worktree was not found')
  if (target.isCurrent) throw new Error('Cannot apply a patch to the current workspace worktree')

  const targetStatusRaw = await runGitOptional(['status', '--porcelain=v1'], targetPath)
  if (targetStatusRaw.trim()) {
    throw new Error('Target worktree must be clean before applying a patch')
  }

  const patch = await runGit(['diff', '--binary', 'HEAD'], workspace.repoRoot)
  if (!patch.trim()) {
    throw new Error('No tracked workspace diff is available to apply')
  }

  await runCommandWithInput('git', ['apply', '--check', '-'], targetPath, patch)
  await runCommandWithInput('git', ['apply', '-'], targetPath, patch)

  const snapshot = await listWorkspaceWorktrees(workspace.cwd)
  const worktree = snapshot.worktrees.find((candidate) => candidate.path === targetPath)
  if (!worktree) throw new Error('Patched worktree was not found')
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'worktree.patch_applied',
    severity: 'success',
    title: 'Patch applied to worktree',
    summary: `${String(Buffer.byteLength(patch, 'utf8'))} bytes applied to ${targetPath}`,
    metadata: {
      path: targetPath,
      branch: target.branch,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
    },
  })

  return {
    worktree,
    snapshot,
    targetStatus: await getWorkspaceGitStatus(targetPath),
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    appliedAtIso: new Date().toISOString(),
  }
}

export async function getWorkspacePorts(cwd: string): Promise<ToolingPortsSnapshot> {
  const workspace = await getWorkspaceRoot(cwd)
  const config = await readWorkspaceConfig(workspace.root)
  const raw = await runCommandOptional('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcPn'], workspace.root)
  const ports = raw ? parseLsofListeningPorts(raw) : []
  const policyPorts = ports.map((port) => ({
    ...port,
    policy: evaluatePortPolicy({
      config: config.portPolicy,
      port: port.port,
      exposure: port.exposure,
    }),
  }))
  const warnings: string[] = []
  if (!raw) {
    warnings.push('Listening ports could not be inspected. Install lsof or check local permissions.')
  }
  if (policyPorts.some((port) => port.exposure === 'wildcard')) {
    warnings.push('Wildcard listeners are reachable beyond localhost unless firewalled.')
  }
  if (policyPorts.some((port) => port.exposure === 'external')) {
    warnings.push('External interface listeners may expose local services to the network.')
  }
  for (const port of policyPorts.filter((candidate) => candidate.policy.status === 'denied').slice(0, 8)) {
    warnings.push(`Port policy denied ${String(port.port)} (${port.exposure}): ${port.policy.reason}`)
  }
  for (const knownPort of config.knownPorts.filter((port) => port.required)) {
    if (!policyPorts.some((port) => port.port === knownPort.port)) {
      warnings.push(`Required configured port ${knownPort.name} (:${String(knownPort.port)}) is not listening.`)
    }
  }

  return {
    cwd: workspace.cwd,
    root: workspace.root,
    generatedAtIso: new Date().toISOString(),
    ports: policyPorts,
    knownPorts: config.knownPorts,
    policy: config.portPolicy,
    warnings,
  }
}

export async function probeWorkspacePreview(params: {
  cwd: string
  url: string
}): Promise<ToolingPreviewProbe> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const url = normalizePreviewProbeUrl(params.url)
  const startedAt = Date.now()
  const requestedAtIso = new Date(startedAt).toISOString()
  const warnings: string[] = []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PREVIEW_PROBE_TIMEOUT_MS)

  let status: ToolingPreviewProbe['status'] = 'failed'
  let statusCode: number | null = null
  let statusText = ''
  let contentType = ''
  let title = ''
  let bodyPreview = ''
  let bytesRead = 0
  let truncated = false
  let errorMessage = ''

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'user-agent': 'cody-web-ui-preview-probe',
      },
    })
    statusCode = response.status
    statusText = response.statusText
    contentType = response.headers.get('content-type') ?? ''

    const chunks: Uint8Array[] = []
    const reader = response.body?.getReader()
    if (reader) {
      while (bytesRead < MAX_PREVIEW_PROBE_BYTES) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
        bytesRead += next.value.byteLength
        if (bytesRead >= MAX_PREVIEW_PROBE_BYTES) {
          truncated = true
          break
        }
      }
      if (truncated) {
        await reader.cancel()
      }
    }

    const raw = Buffer.concat(chunks, Math.min(bytesRead, MAX_PREVIEW_PROBE_BYTES)).toString('utf8')
    title = extractHtmlTitle(raw)
    bodyPreview = previewText(raw)
    status = response.ok ? 'passed' : 'failed'
    if (!response.ok) {
      errorMessage = `Preview returned HTTP ${String(response.status)}`
    }
  } catch (error) {
    errorMessage = error instanceof Error && error.name === 'AbortError'
      ? `Preview probe timed out after ${String(PREVIEW_PROBE_TIMEOUT_MS)}ms`
      : error instanceof Error && error.message
        ? error.message
        : 'Preview probe failed'
  } finally {
    clearTimeout(timeout)
  }

  if (!title && bodyPreview) {
    warnings.push('No HTML title was found in the preview response.')
  }
  if (truncated) {
    warnings.push('Preview response was truncated before summarization.')
  }

  const result: ToolingPreviewProbe = {
    cwd: workspace.cwd,
    root: workspace.root,
    url,
    requestedAtIso,
    durationMs: Date.now() - startedAt,
    status,
    statusCode,
    statusText,
    contentType,
    title,
    bodyPreview,
    bytesRead,
    truncated,
    errorMessage,
    warnings,
  }

  try {
    const auditWorkspace = await getGitWorkspace(workspace.cwd)
    await appendWorkspaceAuditEvent(auditWorkspace, {
      kind: 'preview.probed',
      severity: status === 'passed' ? 'success' : 'warning',
      title: status === 'passed' ? 'Preview probe passed' : 'Preview probe failed',
      summary: `${url} -> ${statusCode === null ? 'network error' : `HTTP ${String(statusCode)}`}`,
      metadata: {
        url,
        status,
        statusCode,
        durationMs: result.durationMs,
        title,
        contentType,
        truncated,
      },
    })
  } catch {
    // Non-git workspaces can still use preview probes; they just do not have a git-backed audit trail.
  }

  return result
}

export async function captureWorkspacePreviewScreenshot(params: {
  cwd: string
  url: string
  width?: number
  height?: number
}): Promise<ToolingPreviewScreenshot> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const url = normalizePreviewProbeUrl(params.url)
  const width = normalizePreviewScreenshotDimension(params.width, 1280)
  const height = normalizePreviewScreenshotDimension(params.height, 800)
  const startedAt = Date.now()
  const capturedAtIso = new Date(startedAt).toISOString()
  const warnings: string[] = []
  const probe = await probeWorkspacePreview({ cwd: workspace.cwd, url })
  let source: ToolingPreviewScreenshot['source'] = 'browser'
  let mimeType: ToolingPreviewScreenshot['mimeType'] = 'image/png'
  let data: Buffer | null = null
  let errorMessage = ''

  const tempRoot = await mkdtemp(join(tmpdir(), 'cody-web-ui-preview-shot-'))
  try {
    const chromePath = await findChromeExecutable()
    if (!chromePath) {
      throw new Error('Chrome or Chromium was not found; generated a preview evidence card instead.')
    }

    const userDataDir = join(tempRoot, 'chrome-profile')
    const screenshotPath = join(tempRoot, 'preview.png')
    await mkdir(userDataDir, { recursive: true })
    await execFileAsync(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${String(width)},${String(height)}`,
      `--screenshot=${screenshotPath}`,
      url,
    ], {
      cwd: workspace.root,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: PREVIEW_SCREENSHOT_TIMEOUT_MS,
      windowsHide: true,
    })
    data = await readFile(screenshotPath)
    if (data.byteLength > MAX_PREVIEW_SCREENSHOT_BYTES) {
      warnings.push('Screenshot was larger than the preferred preview evidence size.')
    }
  } catch (error) {
    source = 'evidence-card'
    mimeType = 'image/svg+xml'
    errorMessage = error instanceof Error && error.message
      ? error.message
      : 'Preview screenshot capture failed; generated evidence card instead.'
    warnings.push(errorMessage)
    data = previewEvidenceSvg({
      url,
      title: probe.title,
      bodyPreview: probe.bodyPreview || probe.errorMessage,
      width,
      height,
      capturedAtIso,
      warning: errorMessage,
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }

  const screenshotData = data ?? Buffer.alloc(0)
  const result: ToolingPreviewScreenshot = {
    cwd: workspace.cwd,
    root: workspace.root,
    url,
    capturedAtIso,
    durationMs: Date.now() - startedAt,
    status: screenshotData.byteLength > 0 ? 'captured' : 'failed',
    source,
    mimeType,
    dataUrl: `data:${mimeType};base64,${screenshotData.toString('base64')}`,
    width,
    height,
    title: probe.title,
    bodyPreview: probe.bodyPreview,
    bytes: screenshotData.byteLength,
    errorMessage: source === 'browser' ? '' : errorMessage,
    warnings,
  }

  try {
    const auditWorkspace = await getGitWorkspace(workspace.cwd)
    await appendWorkspaceAuditEvent(auditWorkspace, {
      kind: 'preview.screenshot_captured',
      severity: result.status === 'captured' ? 'success' : 'warning',
      title: result.source === 'browser' ? 'Preview screenshot captured' : 'Preview evidence card captured',
      summary: `${url} -> ${result.source} ${String(width)}x${String(height)}`,
      metadata: {
        url,
        source: result.source,
        mimeType: result.mimeType,
        width,
        height,
        bytes: result.bytes,
        durationMs: result.durationMs,
        title: result.title,
      },
    })
  } catch {
    // Non-git workspaces can still capture preview evidence without audit persistence.
  }

  return result
}

export async function getWorkspaceSnapshot(cwd: string): Promise<ToolingWorkspaceSnapshot> {
  const requestedCwd = cwd.trim()
  if (!requestedCwd) throw new Error('cwd is required')

  const resolvedCwd = await realpath(resolve(requestedCwd))
  const cwdStat = await stat(resolvedCwd)
  if (!cwdStat.isDirectory()) throw new Error('cwd must be a directory')

  let workspace: GitWorkspace | null = null
  try {
    workspace = await getGitWorkspace(resolvedCwd)
  } catch {
    workspace = null
  }

  const repoRoot = workspace?.repoRoot ?? resolvedCwd
  const statusRaw = workspace
    ? await runGitOptional(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot)
    : ''
  const statusFiles = parsePorcelainZ(statusRaw).map(statusFileFromPorcelainEntry)
  const statusCounts = gitStatusCounts(statusFiles)
  const branch = workspace ? (await runGitOptional(['branch', '--show-current'], repoRoot)).trim() : ''
  const upstream = workspace ? (await runGitOptional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot)).trim() : ''
  const packageData = await readPackageScripts(repoRoot)
  const configFiles = await readWorkspaceConfigFiles(repoRoot)
  const workspaceConfig = await readWorkspaceConfig(repoRoot)
  const projectContext = await buildWorkspaceProjectContext(repoRoot)
  let recentValidationRuns: ToolingWorkspaceScriptRun[] = []
  if (workspace) {
    try {
      recentValidationRuns = (await listWorkspaceValidationRuns({ cwd: resolvedCwd, limit: 20 })).runs
    } catch {
      recentValidationRuns = []
    }
  }
  const validationPlan = buildWorkspaceValidationPlan({
    packageManager: packageData.packageManager,
    scripts: packageData.scripts,
    config: workspaceConfig,
    runs: recentValidationRuns,
  })

  const snapshotWithoutWarnings: Omit<ToolingWorkspaceSnapshot, 'warnings'> = {
    cwd: resolvedCwd,
    repoRoot,
    isGitRepo: Boolean(workspace),
    branch,
    upstream,
    generatedAtIso: new Date().toISOString(),
    gitStatus: {
      dirtyFileCount: statusFiles.length,
      ...statusCounts,
      files: statusFiles.slice(0, 50),
    },
    packageManager: packageData.packageManager,
    scripts: packageData.scripts.slice(0, 24),
    validationPlan,
    projectContext,
    workspaceConfig,
    configFiles,
  }

  return {
    ...snapshotWithoutWarnings,
    warnings: buildWorkspaceWarnings(snapshotWithoutWarnings),
  }
}

export async function getWorkspaceSecuritySnapshot(cwd: string): Promise<ToolingWorkspaceSecuritySnapshot> {
  const workspace = await getGitWorkspace(cwd)
  const [status, config, unstagedDiff, stagedDiff] = await Promise.all([
    getWorkspaceGitStatus(workspace.cwd),
    readWorkspaceConfig(workspace.repoRoot),
    runGitOptional(['diff', '--unified=0', '--no-ext-diff'], workspace.repoRoot),
    runGitOptional(['diff', '--cached', '--unified=0', '--no-ext-diff'], workspace.repoRoot),
  ])

  const findings = [
    ...parseUnifiedDiffAddedLines(unstagedDiff, 'unstaged_diff'),
    ...parseUnifiedDiffAddedLines(stagedDiff, 'staged_diff'),
    ...buildPathSecurityFindings({
      paths: status.files.map((file) => file.path),
      config,
    }),
    ...await scanUntrackedSecurityFiles(workspace, status.files),
  ]
  const deduped = new Map<string, ToolingWorkspaceSecurityFinding>()
  for (const finding of findings) {
    deduped.set(finding.id, finding)
  }
  const sortedFindings = Array.from(deduped.values())
    .sort((first, second) => {
      const severityOrder = { danger: 0, warning: 1, info: 2 }
      const severityDelta = severityOrder[first.severity] - severityOrder[second.severity]
      if (severityDelta !== 0) return severityDelta
      return `${first.path}:${String(first.lineNumber ?? 0)}`.localeCompare(`${second.path}:${String(second.lineNumber ?? 0)}`)
    })
    .slice(0, 100)
  const secretFindingCount = sortedFindings.filter((finding) => finding.category === 'secret').length
  const sensitivePathFindingCount = sortedFindings.filter((finding) => finding.category === 'sensitive_path').length
  const highRiskFileCount = sortedFindings.filter((finding) => finding.category === 'high_risk_file').length
  const warnings: string[] = []
  if (secretFindingCount > 0) {
    warnings.push(`${String(secretFindingCount)} possible secret${secretFindingCount === 1 ? '' : 's'} detected in current workspace changes.`)
  }
  if (sensitivePathFindingCount > 0) {
    warnings.push(`${String(sensitivePathFindingCount)} sensitive path change${sensitivePathFindingCount === 1 ? '' : 's'} detected.`)
  }
  if (highRiskFileCount > 0) {
    warnings.push(`${String(highRiskFileCount)} high-risk file change${highRiskFileCount === 1 ? '' : 's'} should receive focused review.`)
  }

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    generatedAtIso: new Date().toISOString(),
    findings: sortedFindings,
    secretFindingCount,
    sensitivePathFindingCount,
    highRiskFileCount,
    warnings,
  }
}

export async function listWorkspaceFiles(params: {
  cwd: string
  path?: string
}): Promise<ToolingWorkspaceFileList> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const target = normalizeWorkspaceTarget(workspace.root, params.path)
  const targetStat = await stat(target.absolutePath)
  if (!targetStat.isDirectory()) throw new Error('path must point to a directory')
  if (target.relativePath) {
    await assertWorkspaceTargetAllowed(workspace.root, target.relativePath)
  }
  const protectionPolicy = await readWorkspacePathProtectionPolicy(workspace.root)

  const rows = await readdir(target.absolutePath, { withFileTypes: true })
  const visibleRows = rows
    .filter((entry) => !entry.name.startsWith('.DS_Store'))
    .filter((entry) => !(entry.isDirectory() && HIDDEN_WORKSPACE_DIRS.has(entry.name)))
    .filter((entry) => {
      const relativeEntryPath = relative(workspace.root, join(target.absolutePath, entry.name)).split(sep).join('/')
      return !checkWorkspacePathProtection(protectionPolicy, relativeEntryPath)
    })
    .slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES)

  const entries: ToolingWorkspaceFileEntry[] = []
  for (const entry of visibleRows) {
    if (!entry.isDirectory() && !entry.isFile()) continue
    const absoluteEntryPath = join(target.absolutePath, entry.name)
    const entryStat = await stat(absoluteEntryPath)
    entries.push({
      name: entry.name,
      path: relative(workspace.root, absoluteEntryPath).split(sep).join('/'),
      kind: entry.isDirectory() ? 'directory' : 'file',
      sizeBytes: entryStat.size,
      modifiedAtIso: entryStat.mtime.toISOString(),
    })
  }

  entries.sort((first, second) => {
    if (first.kind !== second.kind) return first.kind === 'directory' ? -1 : 1
    return first.name.localeCompare(second.name)
  })

  const parentPath = target.relativePath
    ? relative(workspace.root, dirname(target.absolutePath)).split(sep).join('/')
    : ''

  return {
    cwd: workspace.cwd,
    root: workspace.root,
    path: target.relativePath,
    parentPath,
    entries,
    truncated: rows.length > visibleRows.length,
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.includes(0)
}

export async function readWorkspaceFile(params: {
  cwd: string
  path: string
}): Promise<ToolingWorkspaceFileContent> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const target = normalizeWorkspaceTarget(workspace.root, params.path)
  if (!target.relativePath) throw new Error('path must point to a file')
  await assertWorkspaceTargetAllowed(workspace.root, target.relativePath)

  const targetStat = await stat(target.absolutePath)
  if (!targetStat.isFile()) throw new Error('path must point to a file')

  const bytesToRead = Math.min(targetStat.size, MAX_WORKSPACE_FILE_BYTES)
  const file = await open(target.absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const result = await file.read(buffer, 0, bytesToRead, 0)
    const chunk = buffer.subarray(0, result.bytesRead)
    const isBinary = isLikelyBinary(chunk)

    return {
      cwd: workspace.cwd,
      root: workspace.root,
      path: target.relativePath,
      name: target.relativePath.split('/').at(-1) ?? target.relativePath,
      sizeBytes: targetStat.size,
      modifiedAtIso: targetStat.mtime.toISOString(),
      content: isBinary ? '' : chunk.toString('utf8'),
      truncated: targetStat.size > MAX_WORKSPACE_FILE_BYTES,
      isBinary,
    }
  } finally {
    await file.close()
  }
}

function workspaceSearchPreview(value: string): string {
  const normalized = value.replace(/\r?\n/gu, ' ').trim()
  if (normalized.length <= MAX_WORKSPACE_SEARCH_PREVIEW) return normalized
  return `${normalized.slice(0, MAX_WORKSPACE_SEARCH_PREVIEW - 1)}…`
}

function workspaceSearchPath(root: string, targetPath: string): string {
  return relative(root, isAbsolute(targetPath) ? targetPath : resolve(root, targetPath)).split(sep).join('/')
}

function parseRipgrepContentOutput(params: {
  output: string
  root: string
  policy: WorkspacePathProtectionPolicy
  limit: number
}): ToolingWorkspaceSearchItem[] {
  const items: ToolingWorkspaceSearchItem[] = []
  for (const row of params.output.split(/\r?\n/u)) {
    if (!row || items.length >= params.limit + 1) continue
    let payload: Record<string, unknown> | null = null
    try {
      payload = asRecord(JSON.parse(row) as unknown)
    } catch {
      continue
    }
    if (payload?.type !== 'match') continue
    const data = asRecord(payload.data)
    const pathData = asRecord(data?.path)
    const linesData = asRecord(data?.lines)
    const submatches = Array.isArray(data?.submatches) ? data.submatches : []
    const firstSubmatch = asRecord(submatches[0])
    const rawPath = typeof pathData?.text === 'string' ? pathData.text : ''
    const filePath = workspaceSearchPath(params.root, rawPath)
    if (!filePath || checkWorkspacePathProtection(params.policy, filePath)) continue
    items.push({
      path: filePath,
      line: typeof data?.line_number === 'number' ? data.line_number : null,
      column: typeof firstSubmatch?.start === 'number' ? firstSubmatch.start + 1 : null,
      preview: workspaceSearchPreview(typeof linesData?.text === 'string' ? linesData.text : ''),
    })
  }
  return items
}

async function runWorkspaceRipgrepSearch(params: {
  root: string
  target: WorkspaceTarget
  query: string
  scope: ToolingWorkspaceSearchScope
  policy: WorkspacePathProtectionPolicy
  limit: number
}): Promise<ToolingWorkspaceSearchItem[] | null> {
  const searchTarget = params.target.relativePath || '.'
  try {
    if (params.scope === 'files') {
      const result = await execFileAsync('rg', ['--files', '--', searchTarget], {
        cwd: params.root,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      })
      const normalizedQuery = params.query.toLocaleLowerCase()
      return result.stdout.split(/\r?\n/u)
        .map((path) => workspaceSearchPath(params.root, path))
        .filter((path) => path && !checkWorkspacePathProtection(params.policy, path))
        .filter((path) => path.toLocaleLowerCase().includes(normalizedQuery))
        .slice(0, params.limit + 1)
        .map((path) => ({ path, line: null, column: null, preview: path }))
    }
    const result = await execFileAsync('rg', [
      '--json', '--line-number', '--column', '--color', 'never', '--fixed-strings', '--smart-case',
      '--max-filesize', `${String(MAX_WORKSPACE_FILE_BYTES)}B`, '--', params.query, searchTarget,
    ], {
      cwd: params.root,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    })
    return parseRipgrepContentOutput({
      output: result.stdout,
      root: params.root,
      policy: params.policy,
      limit: params.limit,
    })
  } catch (error) {
    const processError = error as ExecFileException
    if (processError.code === 1) return []
    if (processError.code === 'ENOENT') return null
    return null
  }
}

async function fallbackWorkspaceSearch(params: {
  root: string
  target: WorkspaceTarget
  query: string
  scope: ToolingWorkspaceSearchScope
  policy: WorkspacePathProtectionPolicy
  limit: number
}): Promise<ToolingWorkspaceSearchItem[]> {
  const items: ToolingWorkspaceSearchItem[] = []
  const pending = [params.target.absolutePath]
  const normalizedQuery = params.query.toLocaleLowerCase()
  let visitedFiles = 0

  while (pending.length > 0 && items.length <= params.limit && visitedFiles < MAX_WORKSPACE_SEARCH_FILES) {
    const directory = pending.pop()
    if (!directory) break
    let rows: Dirent<string>[]
    try {
      rows = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const row of rows) {
      if (items.length > params.limit || visitedFiles >= MAX_WORKSPACE_SEARCH_FILES) break
      if (row.name === '.DS_Store' || (row.isDirectory() && HIDDEN_WORKSPACE_DIRS.has(row.name))) continue
      const absolutePath = join(directory, row.name)
      const filePath = relative(params.root, absolutePath).split(sep).join('/')
      if (!filePath || checkWorkspacePathProtection(params.policy, filePath)) continue
      if (row.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!row.isFile()) continue
      visitedFiles += 1
      if (params.scope === 'files') {
        if (filePath.toLocaleLowerCase().includes(normalizedQuery)) {
          items.push({ path: filePath, line: null, column: null, preview: filePath })
        }
        continue
      }
      let buffer: Buffer
      try {
        const fileStat = await stat(absolutePath)
        if (fileStat.size > MAX_WORKSPACE_FILE_BYTES) continue
        buffer = await readFile(absolutePath)
      } catch {
        continue
      }
      if (isLikelyBinary(buffer)) continue
      for (const [index, line] of buffer.toString('utf8').split(/\r?\n/u).entries()) {
        const column = line.toLocaleLowerCase().indexOf(normalizedQuery)
        if (column < 0) continue
        items.push({ path: filePath, line: index + 1, column: column + 1, preview: workspaceSearchPreview(line) })
        if (items.length > params.limit) break
      }
    }
  }
  return items
}

export async function searchWorkspace(params: {
  cwd: string
  query: string
  scope?: ToolingWorkspaceSearchScope
  path?: string
  limit?: number
}): Promise<ToolingWorkspaceSearchResult> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const query = params.query.trim()
  if (!query) throw new Error('q is required')
  if (query.length > 200 || /[\r\n\0]/u.test(query)) throw new Error('q is invalid')
  const scope: ToolingWorkspaceSearchScope = params.scope === 'files' ? 'files' : 'content'
  const limit = Math.max(1, Math.min(params.limit ?? 80, MAX_WORKSPACE_SEARCH_RESULTS))
  const target = normalizeWorkspaceTarget(workspace.root, params.path)
  const targetStat = await stat(target.absolutePath)
  if (!targetStat.isDirectory()) throw new Error('path must point to a directory')
  if (target.relativePath) await assertWorkspaceTargetAllowed(workspace.root, target.relativePath)
  const policy = await readWorkspacePathProtectionPolicy(workspace.root)
  const ripgrepItems = await runWorkspaceRipgrepSearch({ root: workspace.root, target, query, scope, policy, limit })
  const matches = ripgrepItems ?? await fallbackWorkspaceSearch({ root: workspace.root, target, query, scope, policy, limit })
  return {
    cwd: workspace.cwd,
    root: workspace.root,
    query,
    scope,
    path: target.relativePath,
    items: matches.slice(0, limit),
    truncated: matches.length > limit,
  }
}

export async function writeWorkspaceFile(params: {
  cwd: string
  path: string
  content: string
}): Promise<ToolingWorkspaceFileWriteResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const relativePath = normalizeWorkspacePath(workspace, params.path)
  await assertWorkspaceTargetAllowed(workspace.repoRoot, relativePath)
  const absolutePath = resolve(workspace.repoRoot, relativePath)
  const existingStat = await stat(absolutePath)
  if (!existingStat.isFile()) throw new Error('path must point to a file')
  if (existingStat.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error('file exceeds the editable size limit')
  }
  if (params.content.includes('\0')) throw new Error('file content must be text')
  if (Buffer.byteLength(params.content, 'utf8') > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error('file content exceeds the editable size limit')
  }
  const existingContent = await readFile(absolutePath, 'utf8')
  if (existingContent.includes('\0')) throw new Error('file content must be text')

  const checkpoint = await createToolingCheckpoint({
    cwd: workspace.cwd,
    label: `Before editing ${relativePath}`,
    paths: [relativePath],
  })

  if (existingContent !== params.content) {
    await writeFile(absolutePath, params.content, 'utf8')
  }
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'file.edited',
    severity: 'warning',
    title: 'Workspace file edited',
    summary: relativePath,
    metadata: {
      path: relativePath,
      checkpointId: checkpoint.id,
      beforeBytes: Buffer.byteLength(existingContent, 'utf8'),
      afterBytes: Buffer.byteLength(params.content, 'utf8'),
      changed: existingContent !== params.content,
    },
  })
  const file = await readWorkspaceFile({
    cwd: workspace.cwd,
    path: relativePath,
  })

  return {
    file,
    checkpoint,
  }
}

export async function runWorkspaceScript(params: {
  cwd: string
  scriptName: string
}): Promise<ToolingWorkspaceScriptRun> {
  const workspace = await getGitWorkspace(params.cwd)
  const scriptName = assertPackageScriptName(params.scriptName)
  if (!isWorkspaceValidationScriptName(scriptName) || isWorkspaceLongRunningScriptName(scriptName)) {
    throw new Error('Only one-shot validation scripts can be run from the dashboard')
  }

  const packageData = await readPackageScripts(workspace.repoRoot)
  const script = packageData.scripts.find((candidate) => candidate.name === scriptName)
  if (!script) throw new Error('scriptName was not found in package.json')

  const command = packageManagerCommand(packageData.packageManager, scriptName)
  const config = await readWorkspaceConfig(workspace.repoRoot)
  assertWorkspaceCommandPolicy({
    config,
    scriptName,
    scriptCommand: script.command,
    displayCommand: command.displayCommand,
  })
  const startedAtMs = Date.now()
  const startedAtIso = new Date(startedAtMs).toISOString()
  const result = await execWorkspaceScript(command.executable, command.args, workspace.repoRoot)
  const endedAtMs = Date.now()
  const endedAtIso = new Date(endedAtMs).toISOString()
  const stdout = truncateScriptText(result.stdout)
  const stderr = truncateScriptText(result.stderr)
  const combined = truncateScriptText([
    stdout.value.trimEnd(),
    stderr.value.trimEnd(),
  ].filter(Boolean).join('\n'))
  const displayCommand = command.displayCommand
  const problems = parseWorkspaceProblems(combined.value, displayCommand)
  const outputSummary = parseValidationOutputSummary(combined.value)
  const run: ToolingWorkspaceScriptRun = {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    packageManager: command.packageManager,
    scriptName,
    command: displayCommand,
    status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    signal: result.signal,
    startedAtIso,
    endedAtIso,
    durationMs: endedAtMs - startedAtMs,
    stdout: stdout.value,
    stderr: stderr.value,
    output: combined.value,
    truncated: stdout.truncated || stderr.truncated || combined.truncated,
    problems,
    testSummary: outputSummary.tests,
    coverageSummary: outputSummary.coverage,
  }

  await appendWorkspaceValidationRun(workspace, run)

  await appendWorkspaceAuditEvent(workspace, {
    kind: 'validation.command_ran',
    severity: run.status === 'passed' ? 'success' : 'danger',
    title: 'Validation command ran',
    summary: `${run.command} -> ${run.status}`,
    metadata: {
      scriptName,
      command: run.command,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      truncated: run.truncated,
      problemCount: run.problems.length,
      testTotal: run.testSummary?.total ?? null,
      testFailed: run.testSummary?.failed ?? null,
      coverageLines: run.coverageSummary?.lines ?? null,
    },
  })

  return run
}

export async function listWorkspaceTerminalSessions(cwd: string): Promise<ToolingTerminalSessionList> {
  const workspace = await getWorkspaceRoot(cwd)
  const sessions = Array.from(terminalSessionStore().values())
    .filter((record) => record.session.root === workspace.root)
    .map(publicTerminalSession)
    .sort((first, second) => second.startedAtIso.localeCompare(first.startedAtIso))

  return {
    cwd: workspace.cwd,
    root: workspace.root,
    generatedAtIso: new Date().toISOString(),
    sessions,
  }
}

export async function startWorkspaceTerminalSession(params: {
  cwd: string
  scriptName: string
}): Promise<ToolingTerminalSession> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const scriptName = assertPackageScriptName(params.scriptName)
  const packageData = await readPackageScripts(workspace.root)
  const script = packageData.scripts.find((candidate) => candidate.name === scriptName)
  if (!script) throw new Error('scriptName was not found in package.json')

  const command = packageManagerCommand(packageData.packageManager, scriptName)
  const config = await readWorkspaceConfig(workspace.root)
  assertWorkspaceCommandPolicy({
    config,
    scriptName,
    scriptCommand: script.command,
    displayCommand: command.displayCommand,
  })
  const id = randomUUID()
  const startedAtIso = new Date().toISOString()
  const session: ToolingTerminalSession = {
    id,
    cwd: workspace.cwd,
    root: workspace.root,
    packageManager: command.packageManager,
    scriptName,
    command: command.displayCommand,
    status: 'running',
    pid: null,
    startedAtIso,
    endedAtIso: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    output: `$ ${command.displayCommand}\n`,
    truncated: false,
  }

  const child = spawn(command.executable, command.args, {
    cwd: workspace.root,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    windowsHide: true,
  })
  session.pid = child.pid ?? null
  const record: TerminalSessionRecord = { session, process: child }
  terminalSessionStore().set(id, record)

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    appendTerminalOutput(session, chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    appendTerminalOutput(session, chunk)
  })
  child.on('error', (error) => {
    appendTerminalOutput(session, `\n[process error] ${error.message}\n`)
    finishTerminalSession(record, 'failed', null, null)
  })
  child.on('exit', (code, signal) => {
    if (session.status === 'stopped') {
      session.exitCode = code
      session.signal = signal
      return
    }
    finishTerminalSession(record, code === 0 ? 'exited' : 'failed', code, signal)
  })

  try {
    const auditWorkspace = await getGitWorkspace(workspace.cwd)
    await appendWorkspaceAuditEvent(auditWorkspace, {
      kind: 'terminal.started',
      severity: 'info',
      title: 'Terminal session started',
      summary: command.displayCommand,
      metadata: {
        sessionId: id,
        scriptName,
        command: command.displayCommand,
        pid: session.pid,
      },
    })
  } catch {
    // Terminal sessions can run outside git workspaces; audit is git-backed.
  }

  return publicTerminalSession(record)
}

export async function stopWorkspaceTerminalSession(params: {
  cwd: string
  sessionId: string
}): Promise<ToolingTerminalSession> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const sessionId = params.sessionId.trim()
  if (!sessionId) throw new Error('sessionId is required')

  const record = terminalSessionStore().get(sessionId)
  if (!record || record.session.root !== workspace.root) {
    throw new Error('terminal session was not found')
  }

  if (record.session.status === 'running') {
    appendTerminalOutput(record.session, '\n[stopped by user]\n')
    finishTerminalSession(record, 'stopped', null, 'SIGTERM')
    try {
      record.process?.kill('SIGTERM')
    } catch {
      // Ignore process kill races; the session state has already been recorded.
    }
  }

  try {
    const auditWorkspace = await getGitWorkspace(workspace.cwd)
    await appendWorkspaceAuditEvent(auditWorkspace, {
      kind: 'terminal.stopped',
      severity: 'warning',
      title: 'Terminal session stopped',
      summary: record.session.command,
      metadata: {
        sessionId,
        scriptName: record.session.scriptName,
        status: record.session.status,
        durationMs: record.session.durationMs,
      },
    })
  } catch {
    // Terminal sessions can run outside git workspaces; audit is git-backed.
  }

  return publicTerminalSession(record)
}

export async function runWorkspaceGitPathAction(params: {
  cwd: string
  action: 'stage' | 'unstage'
  paths: string[]
}): Promise<ToolingGitPathActionResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const paths = params.paths
    .map((path) => normalizeWorkspacePath(workspace, path))
    .filter((path, index, all) => all.indexOf(path) === index)
  if (paths.length === 0) throw new Error('paths are required')

  if (params.action === 'stage') {
    await runGit(['add', '--', ...paths], workspace.repoRoot)
  } else {
    await runGit(['reset', '-q', 'HEAD', '--', ...paths], workspace.repoRoot)
  }
  const status = await getWorkspaceGitStatus(workspace.cwd)
  await appendWorkspaceAuditEvent(workspace, {
    kind: params.action === 'stage' ? 'git.paths_staged' : 'git.paths_unstaged',
    severity: 'info',
    title: params.action === 'stage' ? 'Git paths staged' : 'Git paths unstaged',
    summary: `${params.action} ${String(paths.length)} path${paths.length === 1 ? '' : 's'}`,
    metadata: {
      action: params.action,
      paths,
      stagedFileCount: status.stagedFileCount,
      unstagedFileCount: status.unstagedFileCount,
      untrackedFileCount: status.untrackedFileCount,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    action: params.action,
    paths,
    status,
  }
}

export async function rollbackWorkspaceFile(params: {
  cwd: string
  filePath: string
  label?: string
}): Promise<ToolingRollbackFileResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const relativePath = normalizeWorkspacePath(workspace, params.filePath)
  const beforeStatus = await readStatusForPaths(workspace, [relativePath])
  const beforeEntries = parsePorcelainZ(beforeStatus)
  const checkpoint = await createToolingCheckpoint({
    cwd: workspace.cwd,
    label: params.label || `Before rolling back ${relativePath}`,
    paths: [relativePath],
  })

  if (beforeEntries.length === 0) {
    await appendWorkspaceAuditEvent(workspace, {
      kind: 'rollback.file',
      severity: 'info',
      title: 'File rollback skipped',
      summary: `${relativePath} had no changes`,
      metadata: {
        path: relativePath,
        checkpointId: checkpoint.id,
        rollbackApplied: false,
      },
    })
    return {
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      filePath: params.filePath,
      relativePath,
      checkpoint,
      rollbackApplied: false,
      remainingStatus: '',
    }
  }

  const isOnlyUntracked = beforeEntries.every((entry) => entry.status === '??')
  if (isOnlyUntracked) {
    await rm(resolve(workspace.repoRoot, relativePath), { recursive: true, force: true })
  } else {
    await runGit(['restore', '--staged', '--worktree', '--', relativePath], workspace.repoRoot)
  }

  const remainingStatus = await readStatusForPaths(workspace, [relativePath])
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'rollback.file',
    severity: 'warning',
    title: 'File rolled back',
    summary: relativePath,
    metadata: {
      path: relativePath,
      checkpointId: checkpoint.id,
      rollbackApplied: true,
      remainingStatus,
      wasOnlyUntracked: isOnlyUntracked,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    filePath: params.filePath,
    relativePath,
    checkpoint,
    rollbackApplied: true,
    remainingStatus,
  }
}

export async function rollbackWorkspaceChanges(params: {
  cwd: string
  label?: string
}): Promise<ToolingRollbackWorkspaceResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const beforeStatus = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace.repoRoot)
  const beforeEntries = parsePorcelainZ(beforeStatus)
  const checkpoint = await createToolingCheckpoint({
    cwd: workspace.cwd,
    label: params.label || 'Before rolling back workspace changes',
  })

  if (beforeEntries.length === 0) {
    await appendWorkspaceAuditEvent(workspace, {
      kind: 'rollback.workspace',
      severity: 'info',
      title: 'Workspace rollback skipped',
      summary: 'No workspace changes were present',
      metadata: {
        checkpointId: checkpoint.id,
        rollbackApplied: false,
      },
    })
    return {
      cwd: workspace.cwd,
      repoRoot: workspace.repoRoot,
      checkpoint,
      rollbackApplied: false,
      restoredFileCount: 0,
      removedUntrackedCount: 0,
      remainingStatus: await getWorkspaceGitStatus(workspace.cwd),
    }
  }

  const untrackedPaths = beforeEntries
    .filter((entry) => entry.status === '??')
    .map((entry) => entry.path)
    .filter((path, index, all) => all.indexOf(path) === index)
  const trackedChangeCount = beforeEntries.length - untrackedPaths.length

  if (trackedChangeCount > 0) {
    await runGit(['restore', '--staged', '--worktree', '.'], workspace.repoRoot)
  }

  let removedUntrackedCount = 0
  for (const untrackedPath of untrackedPaths) {
    const absolutePath = resolve(workspace.repoRoot, untrackedPath)
    if (!isInside(workspace.repoRoot, absolutePath)) continue
    await rm(absolutePath, { recursive: true, force: true })
    removedUntrackedCount += 1
  }
  const remainingStatus = await getWorkspaceGitStatus(workspace.cwd)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'rollback.workspace',
    severity: 'warning',
    title: 'Workspace changes rolled back',
    summary: `Restored ${String(trackedChangeCount)} tracked change${trackedChangeCount === 1 ? '' : 's'} and removed ${String(removedUntrackedCount)} untracked path${removedUntrackedCount === 1 ? '' : 's'}`,
    metadata: {
      checkpointId: checkpoint.id,
      rollbackApplied: true,
      restoredFileCount: trackedChangeCount,
      removedUntrackedCount,
      remainingDirtyFileCount: remainingStatus.files.length,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    checkpoint,
    rollbackApplied: true,
    restoredFileCount: trackedChangeCount,
    removedUntrackedCount,
    remainingStatus,
  }
}

export async function rollbackWorkspaceHunk(params: {
  cwd: string
  filePath: string
  hunkIndex: number
  label?: string
}): Promise<ToolingRollbackHunkResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const relativePath = normalizeWorkspacePath(workspace, params.filePath)
  const hunkIndex = Number(params.hunkIndex)
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) throw new Error('hunkIndex is invalid')

  const patch = await runGit(['diff', '--binary', '--', relativePath], workspace.repoRoot)
  if (!patch.trim()) {
    throw new Error('No unstaged diff is available for this file')
  }

  const singleHunk = buildSingleHunkPatch(parseSingleFilePatchForHunks(patch), hunkIndex)
  const checkpoint = await createToolingCheckpoint({
    cwd: workspace.cwd,
    label: params.label || `Before rolling back hunk ${String(hunkIndex + 1)} in ${relativePath}`,
    paths: [relativePath],
  })

  await runCommandWithInput('git', ['apply', '--reverse', '--check', '-'], workspace.repoRoot, singleHunk.patch)
  await runCommandWithInput('git', ['apply', '--reverse', '-'], workspace.repoRoot, singleHunk.patch)

  const remainingStatus = await readStatusForPaths(workspace, [relativePath])
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'rollback.hunk',
    severity: 'warning',
    title: 'Hunk rolled back',
    summary: `${relativePath} hunk ${String(hunkIndex + 1)}`,
    metadata: {
      path: relativePath,
      hunkIndex,
      hunkHeader: singleHunk.header,
      checkpointId: checkpoint.id,
      remainingStatus,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    filePath: params.filePath,
    relativePath,
    hunkIndex,
    hunkHeader: singleHunk.header,
    checkpoint,
    rollbackApplied: true,
    remainingStatus,
  }
}

export async function stageWorkspaceHunk(params: {
  cwd: string
  filePath: string
  hunkIndex: number
}): Promise<ToolingStageHunkResult> {
  const workspace = await getGitWorkspace(params.cwd)
  const relativePath = normalizeWorkspacePath(workspace, params.filePath)
  const hunkIndex = Number(params.hunkIndex)
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) throw new Error('hunkIndex is invalid')

  const patch = await runGit(['diff', '--binary', '--', relativePath], workspace.repoRoot)
  if (!patch.trim()) {
    throw new Error('No unstaged diff is available for this file')
  }

  const singleHunk = buildSingleHunkPatch(parseSingleFilePatchForHunks(patch), hunkIndex)
  await runCommandWithInput('git', ['apply', '--cached', '--check', '-'], workspace.repoRoot, singleHunk.patch)
  await runCommandWithInput('git', ['apply', '--cached', '-'], workspace.repoRoot, singleHunk.patch)
  const status = await getWorkspaceGitStatus(workspace.cwd)
  await appendWorkspaceAuditEvent(workspace, {
    kind: 'git.hunk_staged',
    severity: 'success',
    title: 'Hunk accepted into index',
    summary: `${relativePath} hunk ${String(hunkIndex + 1)}`,
    metadata: {
      path: relativePath,
      hunkIndex,
      hunkHeader: singleHunk.header,
      stagedFileCount: status.stagedFileCount,
      unstagedFileCount: status.unstagedFileCount,
    },
  })

  return {
    cwd: workspace.cwd,
    repoRoot: workspace.repoRoot,
    filePath: params.filePath,
    relativePath,
    hunkIndex,
    hunkHeader: singleHunk.header,
    status,
  }
}

export async function handleToolingDiff(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceDiffSnapshot(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workspace diff'
    setJson(res, 400, { error: message })
  }
}

export async function handleDefaultWorkspace(res: ServerResponse): Promise<void> {
  try {
    const result = await getDefaultWorkspace()
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read default workspace'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspaceSnapshot(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceSnapshot(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workspace snapshot'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspaceSecuritySnapshot(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceSecuritySnapshot(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to inspect workspace security'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspaceGitStatus(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceGitStatus(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workspace git status'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspaceGitDeliveryDraft(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceGitDeliveryDraft(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to build git delivery draft'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspaceReviewDraft(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspaceReviewDraft(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to build workspace review draft'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspacePullRequestDraft(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const baseBranch = url.searchParams.get('baseBranch')?.trim() || undefined
    const result = await getWorkspacePullRequestDraft({ cwd, baseBranch })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to build pull request draft'
    setJson(res, 400, { error: message })
  }
}

export async function handleCommitStagedWorkspaceChanges(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as GitCommitRequest | null
    const cwd = readString(body?.cwd)
    const commitMessage = readString(body?.commitMessage)
    const result = await commitStagedWorkspaceChanges({
      cwd,
      commitMessage: commitMessage || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to commit staged workspace changes'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateWorkspacePullRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as PullRequestCreateRequest | null
    const cwd = readString(body?.cwd)
    const title = readString(body?.title)
    const prBody = readString(body?.body)
    const baseBranch = readString(body?.baseBranch)
    const result = await createWorkspacePullRequest({
      cwd,
      title: title || undefined,
      body: prBody || undefined,
      baseBranch: baseBranch || undefined,
      draft: typeof body?.draft === 'boolean' ? body.draft : undefined,
      dryRun: typeof body?.dryRun === 'boolean' ? body.dryRun : undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create pull request'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceWorktrees(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await listWorkspaceWorktrees(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list workspace worktrees'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateWorkspaceWorktree(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorktreeCreateRequest | null
    const cwd = readString(body?.cwd)
    const branchName = readString(body?.branchName)
    const baseRef = readString(body?.baseRef)
    const result = await createWorkspaceWorktree({
      cwd,
      branchName,
      baseRef: baseRef || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create workspace worktree'
    setJson(res, 400, { error: message })
  }
}

export async function handleRemoveWorkspaceWorktree(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorktreeRemoveRequest | null
    const cwd = readString(body?.cwd)
    const path = readString(body?.path)
    const result = await removeWorkspaceWorktree({ cwd, path })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to remove workspace worktree'
    setJson(res, 400, { error: message })
  }
}

export async function handleApplyPatchToWorkspaceWorktree(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorktreeApplyPatchRequest | null
    const cwd = readString(body?.cwd)
    const path = readString(body?.path)
    const result = await applyWorkspacePatchToWorktree({ cwd, path })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to apply workspace patch to worktree'
    setJson(res, 400, { error: message })
  }
}

export async function handleWorkspacePorts(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await getWorkspacePorts(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to inspect workspace ports'
    setJson(res, 400, { error: message })
  }
}

export async function handleProbeWorkspacePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as PreviewProbeRequest | null
    const cwd = readString(body?.cwd)
    const url = readString(body?.url)
    const result = await probeWorkspacePreview({ cwd, url })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to probe workspace preview'
    setJson(res, 400, { error: message })
  }
}

export async function handleCaptureWorkspacePreviewScreenshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as PreviewScreenshotRequest | null
    const cwd = readString(body?.cwd)
    const url = readString(body?.url)
    const width = typeof body?.width === 'number' ? body.width : undefined
    const height = typeof body?.height === 'number' ? body.height : undefined
    const result = await captureWorkspacePreviewScreenshot({ cwd, url, width, height })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to capture workspace preview screenshot'
    setJson(res, 400, { error: message })
  }
}

export async function handleListTerminalSessions(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await listWorkspaceTerminalSessions(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list terminal sessions'
    setJson(res, 400, { error: message })
  }
}

export async function handleStartTerminalSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as TerminalSessionStartRequest | null
    const cwd = readString(body?.cwd)
    const scriptName = readString(body?.scriptName)
    const result = await startWorkspaceTerminalSession({ cwd, scriptName })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to start terminal session'
    setJson(res, 400, { error: message })
  }
}

export async function handleStopTerminalSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as TerminalSessionStopRequest | null
    const cwd = readString(body?.cwd)
    const sessionId = readString(body?.sessionId)
    const result = await stopWorkspaceTerminalSession({ cwd, sessionId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to stop terminal session'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceFiles(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const path = url.searchParams.get('path')?.trim() ?? ''
    const result = await listWorkspaceFiles({ cwd, path })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list workspace files'
    setJson(res, 400, { error: message })
  }
}

export async function handleReadWorkspaceFile(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const path = url.searchParams.get('path')?.trim() ?? ''
    const result = await readWorkspaceFile({ cwd, path })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workspace file'
    setJson(res, 400, { error: message })
  }
}

export async function handleSearchWorkspace(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const query = url.searchParams.get('q')?.trim() ?? ''
    const scope = url.searchParams.get('scope') === 'files' ? 'files' : 'content'
    const path = url.searchParams.get('path')?.trim() ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '80')
    const result = await searchWorkspace({ cwd, query, scope, path, limit: Number.isFinite(limit) ? limit : 80 })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to search workspace'
    setJson(res, 400, { error: message })
  }
}

const WORKSPACE_ASSET_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export async function readWorkspaceAsset(params: { cwd: string; path: string }): Promise<{
  path: string
  contentType: string
  content: Buffer
}> {
  const workspace = await getWorkspaceRoot(params.cwd)
  const target = normalizeWorkspaceTarget(workspace.root, params.path)
  if (!target.relativePath) throw new Error('path must point to an asset')
  await assertWorkspaceTargetAllowed(workspace.root, target.relativePath)
  const extension = `.${target.relativePath.split('.').at(-1)?.toLowerCase() ?? ''}`
  const contentType = WORKSPACE_ASSET_CONTENT_TYPES[extension]
  if (!contentType) throw new Error('unsupported workspace asset type')
  const targetStat = await stat(target.absolutePath)
  if (!targetStat.isFile()) throw new Error('path must point to a file')
  if (targetStat.size > MAX_WORKSPACE_ASSET_BYTES) throw new Error('workspace asset exceeds the preview limit')
  return { path: target.relativePath, contentType, content: await readFile(target.absolutePath) }
}

export async function handleReadWorkspaceAsset(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const path = url.searchParams.get('path')?.trim() ?? ''
    const result = await readWorkspaceAsset({ cwd, path })
    res.statusCode = 200
    res.setHeader('Content-Type', result.contentType)
    res.setHeader('Content-Length', String(result.content.byteLength))
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(result.content)
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workspace asset'
    setJson(res, 400, { error: message })
  }
}

export async function handleWriteWorkspaceFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkspaceFileWriteRequest | null
    const cwd = readString(body?.cwd)
    const path = readString(body?.path)
    const content = typeof body?.content === 'string' ? body.content : null
    if (content === null) throw new Error('content is required')

    const result = await writeWorkspaceFile({ cwd, path, content })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to write workspace file'
    setJson(res, 400, { error: message })
  }
}

export async function handleRunWorkspaceScript(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkspaceScriptRunRequest | null
    const cwd = readString(body?.cwd)
    const scriptName = readString(body?.scriptName)
    const result = await runWorkspaceScript({ cwd, scriptName })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to run workspace script'
    setJson(res, 400, { error: message })
  }
}

async function handleWorkspaceGitPathAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'stage' | 'unstage',
): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as GitPathActionRequest | null
    const cwd = readString(body?.cwd)
    const paths = Array.isArray(body?.paths)
      ? body.paths.map(readString).filter(Boolean)
      : []
    const result = await runWorkspaceGitPathAction({ cwd, action, paths })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : `Failed to ${action} workspace paths`
    setJson(res, 400, { error: message })
  }
}

export async function handleStageWorkspaceGitPaths(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleWorkspaceGitPathAction(req, res, 'stage')
}

export async function handleUnstageWorkspaceGitPaths(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleWorkspaceGitPathAction(req, res, 'unstage')
}

export async function handleListToolingCheckpoints(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const rawLimit = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined
    const result = await listToolingCheckpoints({ cwd, limit })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list checkpoints'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceAuditEvents(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const rawLimit = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined
    const result = await listWorkspaceAuditEvents({ cwd, limit })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list workspace audit events'
    setJson(res, 400, { error: message })
  }
}

export async function handleListApprovalGrants(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await listApprovalGrants(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list approval grants'
    setJson(res, 400, { error: message })
  }
}

export async function handleRevokeApprovalGrant(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as { cwd?: unknown; grantId?: unknown } | null
    const cwd = readString(body?.cwd)
    const grantId = readString(body?.grantId)
    const result = await revokeApprovalGrant({ cwd, grantId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to revoke approval grant'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceReviewComments(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const result = await listWorkspaceReviewComments(cwd)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list review comments'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateWorkspaceReviewComment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as ReviewCommentCreateRequest | null
    const cwd = readString(body?.cwd)
    const commentBody = reviewCommentBody(readString(body?.body))
    const anchor = reviewCommentAnchor(body?.anchor)
    const result = await createWorkspaceReviewComment({ cwd, body: commentBody, anchor })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create review comment'
    setJson(res, 400, { error: message })
  }
}

export async function handleUpdateWorkspaceReviewCommentStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as ReviewCommentStatusRequest | null
    const cwd = readString(body?.cwd)
    const commentId = readString(body?.commentId)
    const status = readString(body?.status)
    if (!isReviewCommentStatus(status)) throw new Error('review comment status is invalid')
    const result = await updateWorkspaceReviewCommentStatus({ cwd, commentId, status })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to update review comment'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateWorkspaceReviewFollowUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as ReviewFollowUpRequest | null
    const cwd = readString(body?.cwd)
    const commentId = readString(body?.commentId)
    const result = await createWorkspaceReviewFollowUp({ cwd, commentId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create review follow-up'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceValidationRuns(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const rawLimit = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined
    const result = await listWorkspaceValidationRuns({ cwd, limit })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list validation runs'
    setJson(res, 400, { error: message })
  }
}

export async function handleListWorkspaceWorkflows(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const rawLimit = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined
    const result = await listWorkspaceWorkflows({ cwd, limit })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to list workspace workflows'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateWorkspaceWorkflow(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowCreateRequest | null
    const cwd = readString(body?.cwd)
    const templateId = readString(body?.templateId)
    const goal = readString(body?.goal)
    const result = await createWorkspaceWorkflowRun({ cwd, templateId, goal })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create workspace workflow'
    setJson(res, 400, { error: message })
  }
}

export async function handleUpdateWorkspaceWorkflowAgentStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowAgentStatusRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const agentId = readString(body?.agentId)
    const status = readString(body?.status)
    const note = readString(body?.note)
    const result = await updateWorkspaceWorkflowAgentStatus({
      cwd,
      runId,
      agentId,
      status,
      note: note || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to update workflow agent status'
    setJson(res, 400, { error: message })
  }
}

export async function handleProvisionWorkspaceWorkflowAgentWorktree(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowAgentWorktreeRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const agentId = readString(body?.agentId)
    const baseRef = readString(body?.baseRef)
    const result = await provisionWorkspaceWorkflowAgentWorktree({
      cwd,
      runId,
      agentId,
      baseRef: baseRef || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to provision workflow agent worktree'
    setJson(res, 400, { error: message })
  }
}

export async function handleApplyWorkspaceWorkflowImplementation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowImplementationApplyRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const agentId = readString(body?.agentId)
    const result = await applyWorkspaceWorkflowImplementation({ cwd, runId, agentId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to apply workflow implementation'
    setJson(res, 400, { error: message })
  }
}

export async function handleDiscardWorkspaceWorkflowImplementation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowImplementationDiscardRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const agentId = readString(body?.agentId)
    const reason = readString(body?.reason)
    const result = await discardWorkspaceWorkflowImplementation({
      cwd,
      runId,
      agentId,
      reason: reason || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to discard workflow implementation'
    setJson(res, 400, { error: message })
  }
}

export async function handleGetWorkspaceWorkflowReplay(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const runId = url.searchParams.get('runId')?.trim() ?? ''
    const result = await getWorkspaceWorkflowReplay({ cwd, runId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read workflow replay'
    setJson(res, 400, { error: message })
  }
}

export async function handleGetWorkspaceWorkflowDeliveryDraft(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const runId = url.searchParams.get('runId')?.trim() ?? ''
    const result = await getWorkspaceWorkflowDeliveryDraft({ cwd, runId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to build workflow delivery draft'
    setJson(res, 400, { error: message })
  }
}

export async function handleMarkWorkspaceWorkflowReadyToMerge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowDeliveryStatusRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const note = readString(body?.note)
    const result = await markWorkspaceWorkflowReadyToMerge({
      cwd,
      runId,
      note: note || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to mark workflow ready to merge'
    setJson(res, 400, { error: message })
  }
}

export async function handleMarkWorkspaceWorkflowMerged(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowDeliveryStatusRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const commitHash = readString(body?.commitHash)
    const pullRequestUrl = readString(body?.pullRequestUrl)
    const note = readString(body?.note)
    const result = await markWorkspaceWorkflowMerged({
      cwd,
      runId,
      commitHash: commitHash || undefined,
      pullRequestUrl: pullRequestUrl || undefined,
      note: note || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to mark workflow merged'
    setJson(res, 400, { error: message })
  }
}

export async function handleRunWorkspaceWorkflowValidation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as WorkflowValidationRunRequest | null
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const scriptName = readString(body?.scriptName)
    const result = await runWorkspaceWorkflowValidation({ cwd, runId, scriptName })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to run workflow validation'
    setJson(res, 400, { error: message })
  }
}

export async function handleReadToolingCheckpointPatch(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const checkpointId = url.searchParams.get('checkpointId')?.trim() ?? ''
    const result = await readToolingCheckpointPatch({ cwd, checkpointId })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to read checkpoint patch'
    setJson(res, 400, { error: message })
  }
}

export async function handleCreateToolingCheckpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as CheckpointRequest | null
    const cwd = readString(body?.cwd)
    const label = readString(body?.label)
    const paths = Array.isArray(body?.paths)
      ? body.paths.map(readString).filter(Boolean)
      : []
    const result = await createToolingCheckpoint({ cwd, label, paths })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create checkpoint'
    setJson(res, 400, { error: message })
  }
}

export async function handleRollbackToolingFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as RollbackFileRequest | null
    const cwd = readString(body?.cwd)
    const filePath = readString(body?.filePath)
    const label = readString(body?.label)
    const result = await rollbackWorkspaceFile({ cwd, filePath, label })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to roll back file'
    setJson(res, 400, { error: message })
  }
}

export async function handleRollbackToolingWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as RollbackWorkspaceRequest | null
    const cwd = readString(body?.cwd)
    const label = readString(body?.label)
    const result = await rollbackWorkspaceChanges({
      cwd,
      label: label || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to rollback workspace changes'
    setJson(res, 400, { error: message })
  }
}

export async function handleRollbackToolingHunk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as RollbackHunkRequest | null
    const cwd = readString(body?.cwd)
    const filePath = readString(body?.filePath)
    const hunkIndex = Number(body?.hunkIndex)
    const label = readString(body?.label)
    const result = await rollbackWorkspaceHunk({
      cwd,
      filePath,
      hunkIndex,
      label: label || undefined,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to rollback workspace hunk'
    setJson(res, 400, { error: message })
  }
}

export async function handleStageToolingHunk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req)) as StageHunkRequest | null
    const cwd = readString(body?.cwd)
    const filePath = readString(body?.filePath)
    const hunkIndex = Number(body?.hunkIndex)
    const result = await stageWorkspaceHunk({
      cwd,
      filePath,
      hunkIndex,
    })
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to stage workspace hunk'
    setJson(res, 400, { error: message })
  }
}

export async function readCheckpointPatch(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
