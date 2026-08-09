export type RpcEnvelope<T> = {
  result: T
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type UiCollaborationModeKind = 'default' | 'plan'

export type RpcMethodCatalog = {
  data: string[]
}

export type ThreadListResult = {
  data: ThreadSummary[]
  nextCursor?: string | null
}

export type ThreadSummary = {
  id: string
  preview: string
  title?: string
  name?: string
  cwd: string
  updatedAt: number
  createdAt: number
  source?: unknown
}

export type ThreadReadResult = {
  thread: ThreadDetail
}

export type ThreadDetail = {
  id: string
  cwd: string
  preview: string
  turns: ThreadTurn[]
  updatedAt: number
  createdAt: number
}

export type ThreadTurn = {
  id: string
  status: string
  items: ThreadItem[]
}

export type ThreadItem = {
  id: string
  type: string
  text?: string
  content?: unknown
  summary?: string[]
}

export type UserInput = {
  type: string
  text?: string
  path?: string
  url?: string
}

export type UiThread = {
  id: string
  title: string
  projectName: string
  cwd: string
  createdAtIso: string
  updatedAtIso: string
  preview: string
  unread: boolean
  inProgress: boolean
}

export type UiThreadContextUsage = {
  threadId: string
  turnId: string
  usedTokens: number
  inputTokens: number
  contextWindow: number | null
  autoCompactTokenLimit: number | null
  updatedAtIso: string
  compactionState: 'idle' | 'compacting' | 'compacted'
}

export type UiMessage = {
  id: string
  /** Parent Codex turn. Used to reconcile realtime items with history safely. */
  turnId?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  images?: string[]
  skills?: UiComposerSkill[]
  tool?: UiToolTimelineEntry
  messageType?: string
  rawPayload?: string
  isUnhandled?: boolean
}

export type UiConversationShareMessage = {
  id: string
  turnId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  messageType: string
  imageCount: number
  images?: string[]
  tool: UiToolTimelineEntry | null
}

export type UiConversationShareThemeSnapshot = {
  skinId: string
  skinName: string
  colorMode: 'light' | 'dark'
  colors: {
    background: string
    surface: string
    panel: string
    elevated: string
    text: string
    textMuted: string
    border: string
    accent: string
    codeBackground: string
  }
  fonts: {
    sans: string
    mono: string
  }
  radii: {
    sm: string
    md: string
    lg: string
  }
  recipes: {
    message: 'native' | 'bubble' | 'rail'
    identity: 'none' | 'avatars'
    panel: 'native' | 'beveled' | 'glass'
    backdrop: 'solid' | 'aero-grid' | 'grid' | 'image'
  }
  background: {
    type: 'solid' | 'grid' | 'noise' | 'image' | 'animated'
    fit: 'cover' | 'contain'
    position: string
    blur: number
    dim: number
    saturation: number
  } | null
  assets: {
    background?: string
    assistantAvatar?: string
    userAvatar?: string
  }
}

export type UiConversationShareSnapshot = {
  version: 1 | 2
  locale: 'en' | 'zh-CN'
  title: string
  threadTitle: string
  projectName: string
  createdAtIso: string
  messages: UiConversationShareMessage[]
  selectedTurnIds: string[]
  selectedMessageIds?: string[]
  theme?: UiConversationShareThemeSnapshot | null
  options: {
    includeToolDetails: boolean
    redactLocalPaths: boolean
  }
}

export type UiConversationShareSummary = {
  id: string
  title: string
  threadId: string
  publicPath: string
  createdAtIso: string
  expiresAtIso: string | null
  messageCount: number
  turnCount: number
}

export type UiToolTimelineEntry = {
  kind:
    | 'command'
    | 'fileChange'
    | 'mcp'
    | 'collabAgent'
    | 'webSearch'
    | 'imageView'
    | 'review'
    | 'context'
    | 'rollback'
    | 'unknown'
  title: string
  status: string
  summary: string
  details: string[]
  output?: string
  outputLabel?: string
}

export type UiComposerImage = {
  id: string
  name: string
  path: string
  url: string
  mimeType: string
}

export type UiComposerSkill = {
  name: string
  path: string
  description: string
  displayName: string
}

export type UiComposerContextKind =
  | 'diff'
  | 'folder'
  | 'workspace-rules'
  | 'file'
  | 'terminal'
  | 'problems'
  | 'test-results'
  | 'preview'
  | 'recent-thread'

export type UiComposerContextAttachment = {
  id: string
  kind: UiComposerContextKind
  label: string
  description: string
  content: string
  createdAtIso: string
  metadata: Record<string, string | number | boolean>
}

export type UiCollaborationModeOption = {
  name: string
  mode: UiCollaborationModeKind
  label: string
  model: string
  reasoningEffort: ReasoningEffort | ''
  developerInstructions: string | null
}

export type UiComposerPermissionMode = 'current' | 'yolo'

export type UiComposerSubmitPayload = {
  text: string
  images: UiComposerImage[]
  skills: UiComposerSkill[]
  contexts?: UiComposerContextAttachment[]
}

export type UiDirectoryEntry = {
  name: string
  path: string
}

export type UiDirectoryListing = {
  path: string
  parentPath: string
  directories: UiDirectoryEntry[]
}

export type UiDefaultWorkspace = {
  cwd: string
  label: string
}

export type UiRateLimitWindow = {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export type UiRateLimitSnapshot = {
  limitId: string
  limitName: string
  planType: string
  primary: UiRateLimitWindow | null
  secondary: UiRateLimitWindow | null
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: string
  } | null
  availableResetCredits: number | null
}

export type UiSecurityAccessRisk = {
  id: string
  level: 'info' | 'warning' | 'danger'
  title: string
  summary: string
}

export type UiSecurityAccessSnapshot = {
  generatedAtIso: string
  auth: {
    enabled: boolean
    sessionEndpoint: string
    loginEndpoint: string
    logoutEndpoint: string
  }
  network: {
    requestHost: string
    hostname: string
    protocol: 'http' | 'https' | 'unknown'
    forwardedProto: string
    isLoopbackRequest: boolean
    listenHost: string
    listenPort: number | null
    listenExposure: 'loopback' | 'wildcard' | 'external' | 'unknown'
  }
  risks: UiSecurityAccessRisk[]
  recommendations: string[]
  guide: Array<{
    title: string
    body: string
  }>
}

export type UiAuthSessionSnapshot = {
  authenticated: boolean
  deviceId?: string
  trustedDevice?: boolean
  trustedAtIso?: string | null
  createdAtIso?: string
  expiresAtIso?: string
  lastSeenAtIso?: string
}

export type UiTrustedDevice = {
  deviceId: string
  trustedAtIso: string
  lastSeenAtIso: string
  current: boolean
}

export type UiTrustedDeviceList = {
  devices: UiTrustedDevice[]
}

export type UiTrustedDeviceActionResult = {
  ok: boolean
  deviceId: string
  trustedDevice: boolean
  trustedAtIso?: string | null
}

export type UiCommandPolicyEvaluation = {
  status: 'allowed' | 'denied' | 'not_configured' | 'not_git_workspace'
  cwd: string
  repoRoot: string
  command: string
  checkedValues: string[]
  allowPatterns: string[]
  denyPatterns: string[]
  matchedPattern: string
  reason: string
}

export type UiFileChangePolicyEvaluation = {
  status: 'allowed' | 'denied' | 'not_git_workspace'
  cwd: string
  repoRoot: string
  grantRoot: string
  relativePath: string
  sandboxMode: UiWorkspaceConfig['sandboxMode']
  category: 'workspace' | 'outside_workspace' | 'sensitive' | 'ignored' | 'read_only' | 'missing_grant_root' | 'not_git_workspace'
  matchedPattern: string
  reason: string
}

export type UiServerRequest = {
  id: number
  method: string
  threadId: string
  turnId: string
  itemId: string
  receivedAtIso: string
  params: unknown
  commandPolicy?: UiCommandPolicyEvaluation | null
  fileChangePolicy?: UiFileChangePolicyEvaluation | null
}

export type UiServerRequestReply = {
  id: number
  approvalScope?: UiApprovalDecisionScope
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

export type UiApprovalDecisionScope = 'single' | 'session' | 'workspace' | 'permanent'

export type UiApprovalGrant = {
  id: string
  cwd: string
  repoRoot: string
  scope: Extract<UiApprovalDecisionScope, 'workspace' | 'permanent'>
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

export type UiApprovalGrantList = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  grants: UiApprovalGrant[]
}

export type UiToolingCheckpoint = {
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

export type UiCheckpointHealth = {
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
  automaticBackoff: {
    failureCount: number
    retryAtIso: string
    active: boolean
  } | null
}

export type UiToolingCheckpointPatch = {
  checkpoint: UiToolingCheckpoint
  patch: string
}

export type UiAuditSeverity = 'info' | 'success' | 'warning' | 'danger'

export type UiAuditEvent = {
  id: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  actor: 'local-user' | 'system'
  kind: string
  severity: UiAuditSeverity
  title: string
  summary: string
  metadata: Record<string, unknown>
}

export type UiAuditTrail = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  events: UiAuditEvent[]
  truncated: boolean
}

export type UiCodexSessionEventSeverity = 'info' | 'success' | 'warning' | 'danger'

export type UiCodexSessionEventKind =
  | 'task_started'
  | 'approval_required'
  | 'approval_resolved'
  | 'task_completed'
  | 'task_failed'
  | 'agent_message'
  | 'plan_updated'
  | 'thread_compacted'
  | 'rate_limit'

export type UiCodexSessionEvent = {
  id: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  threadId: string
  turnId: string
  method: string
  kind: UiCodexSessionEventKind
  severity: UiCodexSessionEventSeverity
  title: string
  summary: string
  metadata: Record<string, string | number | boolean>
}

export type UiCodexSessionEventTrail = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  events: UiCodexSessionEvent[]
  truncated: boolean
}

export type UiWorkspaceSessionStatus =
  | 'running'
  | 'waiting_for_approval'
  | 'failed'
  | 'completed'
  | 'active'
  | 'unknown'

export type UiWorkspaceSessionSummary = {
  threadId: string
  title: string
  status: UiWorkspaceSessionStatus
  severity: UiCodexSessionEventSeverity
  startedAtIso: string
  updatedAtIso: string
  latestTurnId: string
  latestEventKind: UiCodexSessionEventKind
  latestSummary: string
  eventCount: number
  approvalCount: number
  failedCount: number
  planUpdateCount: number
  messageCount: number
  compactedCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokenUsageEventCount: number
  costUsd: number | null
  costEventCount: number
}

export type UiWorkspaceSessionSummaryTrail = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  sessions: UiWorkspaceSessionSummary[]
  truncated: boolean
}

export type UiDailyTokenUsage = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  date: string
  timezoneOffsetMinutes: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokenUsageEventCount: number
  threadCount: number
  turnCount: number
  costUsd: number | null
  costEventCount: number
  source: 'reconciled-rollouts' | 'realtime-events' | 'none'
  lastReconciledAtIso: string | null
  partial?: boolean
  skippedWorkspaceCount?: number
}

export type UiGatewayDiagnosticLog = {
  id: string
  createdAtIso: string
  level: 'info' | 'warning' | 'error'
  source: 'bridge' | 'stdout' | 'stderr'
  message: string
}

export type UiGatewayPendingServerRequest = {
  id: number
  method: string
  receivedAtIso: string
  threadId: string
  turnId: string
  itemId: string
}

export type UiMcpServerDiagnostic = {
  name: string
  status: 'starting' | 'ready' | 'failed' | 'cancelled' | 'unknown'
  authStatus: 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth' | 'unknown'
  title: string
  version: string
  websiteUrl: string
  toolCount: number
  resourceCount: number
  resourceTemplateCount: number
  error: string
  threadId: string
  updatedAtIso: string
}

export type UiGatewayDiagnostics = {
  generatedAtIso: string
  appServer: {
    status: 'running' | 'stopped'
    pid: number | null
    initialized: boolean
    startedAtIso: string | null
    exitedAtIso: string | null
    exitCode: number | null
    exitSignal: string | null
    pendingClientRequestCount: number
    pendingServerRequestCount: number
    sentClientRequestCount: number
    completedClientRequestCount: number
    failedClientRequestCount: number
    notificationCount: number
    serverRequestCount: number
    notificationCountsByMethod: Record<string, number>
    pendingServerRequests: UiGatewayPendingServerRequest[]
    mcpServers: UiMcpServerDiagnostic[]
    mcpInventoryError: string
    recentLogs: UiGatewayDiagnosticLog[]
  }
  methodCatalog: {
    methods: string[]
    notifications: string[]
    methodCount: number
    notificationCount: number
    errors: string[]
  }
}

export type UiToolingRollbackFileResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  checkpoint: UiToolingCheckpoint
  rollbackApplied: boolean
  remainingStatus: string
}

export type UiToolingRollbackHunkResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  hunkIndex: number
  hunkHeader: string
  checkpoint: UiToolingCheckpoint
  rollbackApplied: boolean
  remainingStatus: string
}

export type UiToolingRollbackWorkspaceResult = {
  cwd: string
  repoRoot: string
  checkpoint: UiToolingCheckpoint
  rollbackApplied: boolean
  restoredFileCount: number
  removedUntrackedCount: number
  remainingStatus: UiGitStatusSnapshot
}

export type UiToolingStageHunkResult = {
  cwd: string
  repoRoot: string
  filePath: string
  relativePath: string
  hunkIndex: number
  hunkHeader: string
  status: UiGitStatusSnapshot
}

export type UiToolingDiffSnapshot = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  status: string
  patch: string
}

export type UiWorkspaceStatusFile = {
  path: string
  status: string
  indexStatus: string
  worktreeStatus: string
}

export type UiGitStatusSnapshot = {
  cwd: string
  repoRoot: string
  branch: string
  upstream: string
  generatedAtIso: string
  stagedFileCount: number
  unstagedFileCount: number
  untrackedFileCount: number
  conflictedFileCount: number
  files: UiWorkspaceStatusFile[]
}

export type UiGitPathActionResult = {
  cwd: string
  repoRoot: string
  action: 'stage' | 'unstage'
  paths: string[]
  status: UiGitStatusSnapshot
}

export type UiGitDeliveryFile = {
  path: string
  status: string
  insertions: number | null
  deletions: number | null
}

export type UiGitDeliveryDraft = {
  cwd: string
  repoRoot: string
  branch: string
  upstream: string
  generatedAtIso: string
  hasStagedChanges: boolean
  files: UiGitDeliveryFile[]
  fileCount: number
  insertions: number
  deletions: number
  stat: string
  commitMessage: string
  prBody: string
  riskSummary: string[]
  validationPlan: string[]
}

export type UiWorkspaceReviewDraft = UiGitDeliveryDraft & {
  source: 'workspace_diff'
  hasReviewChanges: boolean
  untrackedFiles: string[]
  warnings: string[]
}

export type UiGitCommitResult = {
  cwd: string
  repoRoot: string
  branch: string
  commitHash: string
  commitMessage: string
  committedAtIso: string
  draft: UiGitDeliveryDraft
  status: UiGitStatusSnapshot
}

export type UiPullRequestDraft = {
  cwd: string
  repoRoot: string
  branch: string
  baseBranch: string
  remote: string
  generatedAtIso: string
  commitCount: number
  commits: string[]
  files: UiGitDeliveryFile[]
  fileCount: number
  insertions: number
  deletions: number
  title: string
  body: string
  warnings: string[]
}

export type UiPullRequestCreateResult = {
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

export type UiWorktree = {
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

export type UiWorktreeSnapshot = {
  cwd: string
  repoRoot: string
  managedRoot: string
  generatedAtIso: string
  worktrees: UiWorktree[]
  warnings: string[]
}

export type UiWorktreeCreateResult = {
  worktree: UiWorktree
  snapshot: UiWorktreeSnapshot
}

export type UiWorktreeRemoveResult = {
  removedPath: string
  snapshot: UiWorktreeSnapshot
}

export type UiWorktreeApplyPatchResult = {
  worktree: UiWorktree
  snapshot: UiWorktreeSnapshot
  targetStatus: UiGitStatusSnapshot
  patchBytes: number
  appliedAtIso: string
}

export type UiWorkflowAppliedImplementation = {
  agentId: string
  agentName: string
  branchName: string | null
  worktreePath: string
  appliedAtIso: string
  patchBytes: number
  changedFileCount: number
  checkpointId: string
}

export type UiWorkflowDiscardedImplementation = {
  agentId: string
  agentName: string
  branchName: string | null
  worktreePath: string | null
  discardedAtIso: string
  reason: string
}

export type UiWorkflowDeliveryState = {
  readyToMergeAtIso: string | null
  mergedAtIso: string | null
  commitHash: string | null
  pullRequestUrl: string | null
  note: string
}

export type UiPortExposure = 'loopback' | 'wildcard' | 'external'

export type UiListeningPort = {
  protocol: 'tcp'
  host: string
  port: number
  address: string
  processName: string
  pid: number
  url: string
  exposure: UiPortExposure
  policy: UiPortPolicyEvaluation
}

export type UiPortsSnapshot = {
  cwd: string
  root: string
  generatedAtIso: string
  ports: UiListeningPort[]
  knownPorts: UiWorkspaceKnownPort[]
  policy: UiPortPolicyConfig
  warnings: string[]
}

export type UiPortPolicyConfig = {
  allow: string[]
  deny: string[]
  allowExternal: boolean
  allowWildcard: boolean
}

export type UiPortPolicyEvaluation = {
  status: 'allowed' | 'denied' | 'not_configured'
  severity: UiAuditSeverity
  port: number
  exposure: UiPortExposure
  matchedRule: string
  reason: string
}

export type UiPreviewProbe = {
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

export type UiPreviewScreenshot = {
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

export type UiReviewCommentStatus = 'open' | 'follow_up_created' | 'resolved'

export type UiReviewCommentAnchor = {
  filePath: string
  hunkHeader: string
  lineKind: 'add' | 'remove' | 'context' | 'meta'
  oldLineNumber: number | null
  newLineNumber: number | null
  lineContent: string
}

export type UiReviewComment = {
  id: string
  cwd: string
  repoRoot: string
  createdAtIso: string
  updatedAtIso: string
  author: 'local-user'
  status: UiReviewCommentStatus
  body: string
  anchor: UiReviewCommentAnchor
  followUpRunId: string | null
}

export type UiReviewCommentList = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  comments: UiReviewComment[]
}

export type UiReviewFollowUpResult = {
  comment: UiReviewComment
  workflowRun: UiWorkflowRun
}

export type UiTerminalSession = {
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

export type UiTerminalSessionList = {
  cwd: string
  root: string
  generatedAtIso: string
  sessions: UiTerminalSession[]
}

export type UiWorkspaceSnapshot = {
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
    files: UiWorkspaceStatusFile[]
  }
  packageManager: string
  scripts: Array<{ name: string; command: string }>
  validationPlan: UiWorkspaceValidationPlan
  projectContext: UiWorkspaceProjectContext
  workspaceConfig: UiWorkspaceConfig
  configFiles: {
    codyWebUi: boolean
    agents: boolean
    aiIgnore: boolean
    gitIgnore: boolean
  }
  warnings: string[]
}

export type UiWorkspaceSecurityFinding = {
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

export type UiWorkspaceSecuritySnapshot = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  findings: UiWorkspaceSecurityFinding[]
  secretFindingCount: number
  sensitivePathFindingCount: number
  highRiskFileCount: number
  warnings: string[]
}

export type UiWorkspaceKnownPort = {
  name: string
  port: number
  url: string | null
  required: boolean
}

export type UiWorkspaceValidationCommand = {
  name: string
  command: string
}

export type UiValidationPlanKind =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'preview'
  | 'browser_smoke'
  | 'screenshot'
  | 'manual'

export type UiValidationPlanItem = {
  id: string
  kind: UiValidationPlanKind
  title: string
  priority: 'required' | 'recommended' | 'optional'
  source: 'workspace_config' | 'package_script' | 'workspace_port' | 'inferred'
  status: 'ready' | 'covered' | 'failed' | 'blocked' | 'manual'
  command: string
  scriptName: string | null
  targetUrl: string | null
  reason: string
  evidence: {
    status: UiWorkspaceScriptRun['status'] | 'missing' | 'manual' | 'not_applicable'
    runAtIso: string | null
    durationMs: number | null
    exitCode: number | null
    problemCount: number
    testSummary: UiValidationTestSummary | null
    coverageSummary: UiValidationCoverageSummary | null
  }
}

export type UiWorkspaceValidationPlan = {
  generatedAtIso: string
  items: UiValidationPlanItem[]
  requiredCount: number
  recommendedCount: number
  optionalCount: number
  coveredCount: number
  failedCount: number
  missingEvidenceCount: number
}

export type UiWorkspaceContextKind =
  | 'agents'
  | 'codex_config'
  | 'cody_web_ui'
  | 'ai_ignore'
  | 'git_ignore'
  | 'local_skill'
  | 'mcp_config'
  | 'custom_rules'

export type UiWorkspaceContextSource = {
  id: string
  kind: UiWorkspaceContextKind
  title: string
  path: string
  present: boolean
  bytes: number
  excerpt: string
  truncated: boolean
  summary: string
}

export type UiWorkspaceProjectContext = {
  generatedAtIso: string
  sources: UiWorkspaceContextSource[]
  presentCount: number
  warnings: string[]
}

export type UiWorkspaceNotificationEvent =
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

export type UiWorkspaceNotificationChannel = {
  name: string
  type: 'webhook' | 'slack' | 'lark'
  enabled: boolean
  events: UiWorkspaceNotificationEvent[]
  target: string
}

export type UiWorkspaceNotificationConfig = {
  enabled: boolean
  events: UiWorkspaceNotificationEvent[]
  channels: UiWorkspaceNotificationChannel[]
}

export type UiNotificationDeliveryResult = {
  channelName: string
  channelType: UiWorkspaceNotificationChannel['type']
  target: string
  status: 'sent' | 'failed' | 'skipped'
  httpStatus: number | null
  durationMs: number
  error: string
}

export type UiNotificationDeliveryReport = {
  cwd: string
  generatedAtIso: string
  event: {
    id: string
    kind: UiWorkspaceNotificationEvent
    title: string
    summary: string
    severity: 'info' | 'success' | 'warning' | 'danger'
    createdAtIso: string
    threadId: string
    turnId: string
    method: string
  }
  enabled: boolean
  attemptedCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  results: UiNotificationDeliveryResult[]
  warnings: string[]
}

export type UiWorkspaceConfig = {
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
  validationCommands: UiWorkspaceValidationCommand[]
  knownPorts: UiWorkspaceKnownPort[]
  portPolicy: UiPortPolicyConfig
  notifications: UiWorkspaceNotificationConfig
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

export type UiWorkspaceFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file'
  sizeBytes: number
  modifiedAtIso: string
}

export type UiWorkspaceFileList = {
  cwd: string
  root: string
  path: string
  parentPath: string
  entries: UiWorkspaceFileEntry[]
  truncated: boolean
}

export type UiWorkspaceFileContent = {
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

export type UiWorkspaceLocation = {
  path: string
  line?: number
  column?: number
  mode?: 'file' | 'diff'
}

export type UiWorkspaceSearchScope = 'files' | 'content'

export type UiWorkspaceSearchItem = {
  path: string
  line: number | null
  column: number | null
  preview: string
}

export type UiWorkspaceSearchResult = {
  cwd: string
  root: string
  query: string
  scope: UiWorkspaceSearchScope
  path: string
  items: UiWorkspaceSearchItem[]
  truncated: boolean
}

export type UiWorkspaceCodeTab = UiWorkspaceLocation & {
  id: string
  name: string
}

export type UiWorkspaceFileWriteResult = {
  file: UiWorkspaceFileContent
  checkpoint: UiToolingCheckpoint
}

export type UiWorkspaceProblem = {
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

export type UiValidationTestSummary = {
  total: number | null
  passed: number | null
  failed: number | null
  skipped: number | null
  rawLines: string[]
}

export type UiValidationCoverageSummary = {
  statements: number | null
  branches: number | null
  functions: number | null
  lines: number | null
  rawLines: string[]
}

export type UiWorkspaceScriptRun = {
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
  problems: UiWorkspaceProblem[]
  testSummary?: UiValidationTestSummary | null
  coverageSummary?: UiValidationCoverageSummary | null
}

export type UiWorkspaceValidationRunHistory = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  runs: UiWorkspaceScriptRun[]
  truncated: boolean
}

export type UiWorkflowAgentRole =
  | 'research'
  | 'implementation'
  | 'review'
  | 'test'
  | 'security'
  | 'docs'

export type UiWorkflowStepStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'skipped'

export type UiWorkflowRunStatus =
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

export type UiWorkflowTemplateStep = {
  id: string
  title: string
  role: UiWorkflowAgentRole
  objective: string
  deliverables: string[]
  requiresWorktree: boolean
  dependsOn: string[]
}

export type UiWorkflowTemplate = {
  id: string
  name: string
  description: string
  recommendedFor: string[]
  defaultStatus: UiWorkflowRunStatus
  validationPlan: string[]
  riskLabels: string[]
  steps: UiWorkflowTemplateStep[]
}

export type UiWorkflowAgentStep = UiWorkflowTemplateStep & {
  status: UiWorkflowStepStatus
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

export type UiWorkflowImplementationOption = {
  agentId: string
  agentName: string
  agentStatus: UiWorkflowStepStatus
  worktreeStatus: UiWorkflowAgentStep['worktreeStatus']
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

export type UiWorkflowAcceptanceGateStatus =
  | 'pending_worktree'
  | 'waiting_for_agents'
  | 'waiting_for_validation'
  | 'validation_failed'
  | 'ready_for_review'
  | 'accepted'
  | 'blocked'

export type UiWorkflowAcceptanceGate = {
  status: UiWorkflowAcceptanceGateStatus
  label: string
  summary: string
  validationStatus: UiWorkflowImplementationOption['validationStatus']
  validationCommand: string | null
  requiredValidationCount: number
  completedAgentCount: number
  totalAgentCount: number
  readyImplementationOptionCount: number
  totalImplementationOptionCount: number
  risks: string[]
}

export type UiWorkflowRun = {
  id: string
  cwd: string
  repoRoot: string
  templateId: string
  templateName: string
  goal: string
  status: UiWorkflowRunStatus
  createdAtIso: string
  updatedAtIso: string
  branch: string
  dirtyFileCount: number
  agents: UiWorkflowAgentStep[]
  validationPlan: string[]
  riskLabels: string[]
  warnings: string[]
  summary: string
  implementationOptions?: UiWorkflowImplementationOption[]
  acceptance?: UiWorkflowAcceptanceGate
  appliedImplementation?: UiWorkflowAppliedImplementation
  discardedImplementations?: UiWorkflowDiscardedImplementation[]
  deliveryState?: UiWorkflowDeliveryState
}

export type UiWorkflowDashboard = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  templates: UiWorkflowTemplate[]
  runs: UiWorkflowRun[]
  truncated: boolean
}

export type UiWorkflowReplayEvent = {
  id: string
  createdAtIso: string
  kind: string
  severity: UiAuditSeverity
  title: string
  summary: string
  agentId: string | null
  agentName: string | null
  metadata: Record<string, unknown>
}

export type UiWorkflowReplay = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  run: UiWorkflowRun
  events: UiWorkflowReplayEvent[]
  agentSnapshots: Array<{
    id: string
    agentName: string
    role: UiWorkflowAgentRole
    status: UiWorkflowStepStatus
    worktreeStatus: UiWorkflowAgentStep['worktreeStatus']
    branchName: string | null
    worktreePath: string | null
  }>
  validationEvidence: {
    totalRuns: number
    matchedRuns: number
    latestStatus: UiWorkspaceScriptRun['status'] | null
    latestCommand: string | null
    latestEndedAtIso: string | null
  }
  evidenceSummary: string[]
}

export type UiWorkflowValidationResult = {
  run: UiWorkflowRun
  validationRun: UiWorkspaceScriptRun
  replay: UiWorkflowReplay
}

export type UiWorkflowImplementationApplyResult = {
  run: UiWorkflowRun
  appliedImplementation: UiWorkflowAppliedImplementation
  checkpoint: UiToolingCheckpoint
  targetStatus: UiGitStatusSnapshot
}

export type UiWorkflowImplementationDiscardResult = {
  run: UiWorkflowRun
  discardedImplementation: UiWorkflowDiscardedImplementation
  removedWorktreePath: string | null
}

export type UiWorkflowDeliveryDraft = {
  cwd: string
  repoRoot: string
  generatedAtIso: string
  runId: string
  templateName: string
  goal: string
  status: UiWorkflowRunStatus
  title: string
  body: string
  commitMessage: string
  reviewDraft: UiWorkspaceReviewDraft
  acceptance: UiWorkflowAcceptanceGate | null
  appliedImplementation: UiWorkflowAppliedImplementation | null
  discardedImplementations: UiWorkflowDiscardedImplementation[]
  validationEvidence: UiWorkflowReplay['validationEvidence']
  riskSummary: string[]
  warnings: string[]
}

export type UiWorkflowDeliveryStatusResult = {
  run: UiWorkflowRun
  deliveryState: UiWorkflowDeliveryState
}

export type UiLiveOverlay = {
  activityLabel: string
  activityDetails: string[]
  reasoningText: string
  errorText: string
}

export type UiProjectGroup = {
  projectName: string
  cwd: string
  threads: UiThread[]
}

export type ThreadScrollState = {
  scrollTop: number
  isAtBottom: boolean
  scrollRatio?: number
}

export type ChatMessage = {
  id: string
  role: string
  text: string
  createdAt: string | null
}

export type ChatThread = {
  id: string
  title: string
  projectName: string
  updatedAt: string | null
  messages: ChatMessage[]
}
