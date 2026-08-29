import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cwd as getProcessCwd } from 'node:process'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createAppServerHost,
  type AppServerHost as CoreAppServerHost,
} from '@codycodeagent/cody-web-core/runtime'
import { findCatalogThreadCwd } from './catalogStore.js'
import { CatalogSyncService } from './catalogSyncService.js'
import { AgentTaskService } from './agentTaskService.js'
import {
  isApprovalRequestMethod,
  isCommandApprovalRequestMethod,
  isFileChangeApprovalRequestMethod,
} from '@codycodeagent/cody-web-core/protocol'
import { NotificationDispatcher, type NotificationDispatchEvent } from './notificationDispatchService.js'
import { buildSecurityAccessSnapshot } from './securityAccess.js'
import { appendCodexSessionEvent } from './sessionEventStore.js'
import { TokenUsageReconciliationService } from './tokenUsageReconciliationService.js'
import { createAgentTaskRoutes } from './routes/agentTaskRoutes.js'
import { createBackgroundTaskRoutes } from './routes/backgroundTaskRoutes.js'
import { createCatalogRoutes } from './routes/catalogRoutes.js'
import { createContentRoutes } from './routes/contentRoutes.js'
import { createGatewayRoutes } from './routes/gatewayRoutes.js'
import { createFeishuRoutes } from './routes/feishuRoutes.js'
import { createThreadCacheRoutes } from './routes/threadCacheRoutes.js'
import { createWorkspaceToolingRoutes } from './routes/workspaceToolingRoutes.js'
import { createSmokeRoutes } from './routes/smokeRoutes.js'
import { createFeishuIntegration, type FeishuIntegration } from './feishuIntegration.js'
import { ThreadMessageCache } from './threadMessageCache.js'
import {
  createWorkspaceWorkflowRun,
  createToolingCheckpoint,
  getToolingCheckpointHealth,
  readToolingCheckpointFingerprint,
  createPersistentApprovalGrant,
  evaluateWorkspaceFileChangePolicy,
  evaluateWorkspaceCommandPolicy,
  findMatchingApprovalGrant,
  provisionWorkspaceWorkflowAgentWorktree,
  recordCommandPolicyDecisionAuditEvent,
  recordFileChangePolicyDecisionAuditEvent,
  recordApprovalGrantUse,
  recordApprovalDecisionAuditEvent,
  runWorkspaceWorkflowValidation,
  updateWorkspaceWorkflowAgentStatus,
  type ToolingApprovalDecisionScope,
  type ToolingApprovalGrant,
  type ToolingCommandPolicyEvaluation,
  type ToolingFileChangePolicyEvaluation,
  type ToolingWorkflowRun,
  type ToolingWorkflowStepStatus,
  type ToolingWorkflowValidationResult,
} from './toolingService.js'

export type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
  commandPolicy: ToolingCommandPolicyEvaluation | null
  fileChangePolicy: ToolingFileChangePolicyEvaluation | null
  isSmokeInjected?: boolean
}

type DiagnosticServerRequest = {
  id: number
  method: string
  receivedAtIso: string
  threadId: string
  turnId: string
  itemId: string
}

type AppServerDiagnosticLogLevel = 'info' | 'warning' | 'error'

type AppServerDiagnosticLogSource = 'bridge' | 'stdout' | 'stderr'

type AppServerDiagnosticLog = {
  id: string
  createdAtIso: string
  level: AppServerDiagnosticLogLevel
  source: AppServerDiagnosticLogSource
  message: string
}

type McpServerDiagnosticStatus = 'starting' | 'ready' | 'failed' | 'cancelled' | 'unknown'

type McpServerAuthStatus = 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth' | 'unknown'

type McpServerDiagnostic = {
  name: string
  status: McpServerDiagnosticStatus
  authStatus: McpServerAuthStatus
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

type AppServerDiagnostics = {
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
  pendingServerRequests: DiagnosticServerRequest[]
  mcpServers: McpServerDiagnostic[]
  mcpInventoryError: string
  recentLogs: AppServerDiagnosticLog[]
}

type GatewayDiagnostics = {
  generatedAtIso: string
  appServer: AppServerDiagnostics
  methodCatalog: {
    methods: string[]
    notifications: string[]
    methodCount: number
    notificationCount: number
    errors: string[]
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

function readNestedString(value: unknown, keys: string[]): string {
  let cursor: unknown = value
  for (const key of keys) {
    const record = asRecord(cursor)
    if (!record) return ''
    cursor = record[key]
  }
  return typeof cursor === 'string' ? cursor.trim() : ''
}

function readNotificationThreadId(params: unknown): string {
  return (
    readNestedString(params, ['threadId']) ||
    readNestedString(params, ['thread', 'id']) ||
    readNestedString(params, ['turn', 'threadId']) ||
    readNestedString(params, ['request', 'threadId'])
  )
}

function readNotificationCwd(params: unknown): string {
  return (
    readNestedString(params, ['cwd']) ||
    readNestedString(params, ['thread', 'cwd']) ||
    readNestedString(params, ['turn', 'cwd']) ||
    readNestedString(params, ['request', 'cwd'])
  )
}

export async function resolveNotificationWorkspaceCwd(params: unknown, fallbackCwd = getProcessCwd()): Promise<string> {
  const notificationCwd = readNotificationCwd(params)
  if (notificationCwd) return notificationCwd
  const threadId = readNotificationThreadId(params)
  if (threadId) {
    try {
      const catalogCwd = await findCatalogThreadCwd(threadId)
      if (catalogCwd) return catalogCwd
    } catch {
      // Catalog lookup is best effort; rollout reconciliation remains the durable fallback.
    }
  }
  return fallbackCwd
}

function readNotificationTurnId(params: unknown): string {
  return (
    readNestedString(params, ['turnId']) ||
    readNestedString(params, ['turn', 'id']) ||
    readNestedString(params, ['request', 'turnId'])
  )
}

function shortId(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed || 'unknown'
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeApprovalDecisionScope(value: unknown, decision = ''): ToolingApprovalDecisionScope {
  if (value === 'single' || value === 'session' || value === 'workspace' || value === 'permanent') {
    return value
  }
  return decision === 'acceptForSession' ? 'session' : 'single'
}

export function readApprovalDecisionFromReply(reply: ServerRequestReply): string {
  if (reply.error) return 'rejected'
  const result = asRecord(reply.result)
  const decision = readString(result?.decision)
  if (decision) return decision
  return 'responded'
}

function readServerRequestCwd(params: unknown): string {
  return (
    readNestedString(params, ['cwd']) ||
    readNestedString(params, ['request', 'cwd']) ||
    readNestedString(params, ['params', 'cwd']) ||
    getProcessCwd()
  )
}

function readServerRequestSubject(method: string, params: unknown): string {
  return (
    readNestedString(params, ['command']) ||
    readNestedString(params, ['request', 'command']) ||
    readNestedString(params, ['params', 'command']) ||
    readNestedString(params, ['grantRoot']) ||
    readNestedString(params, ['request', 'grantRoot']) ||
    readNestedString(params, ['params', 'grantRoot']) ||
    method
  )
}

function isStoredGrantEligibleRequest(method: string): boolean {
  return isApprovalRequestMethod(method)
}

function areSmokeHooksEnabled(): boolean {
  return process.env.CODY_WEB_UI_ENABLE_SMOKE_HOOKS === '1'
}

function isCommandApprovalRequest(method: string): boolean {
  return isCommandApprovalRequestMethod(method)
}

function isFileChangeApprovalRequest(method: string): boolean {
  return isFileChangeApprovalRequestMethod(method)
}

function buildApprovalAuditInput(params: {
  requestId: number
  pendingRequest: PendingServerRequest
  reply: ServerRequestReply
  scope: ToolingApprovalDecisionScope
  mode: 'manual' | 'automatic'
  resolvedAtIso: string
}): Parameters<typeof recordApprovalDecisionAuditEvent>[0] {
  const requestParams = asRecord(params.pendingRequest.params)
  const threadId =
    typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
      ? requestParams.threadId
      : ''
  return {
    cwd: readServerRequestCwd(params.pendingRequest.params),
    requestId: params.requestId,
    method: params.pendingRequest.method,
    subject: readServerRequestSubject(params.pendingRequest.method, params.pendingRequest.params),
    receivedAtIso: params.pendingRequest.receivedAtIso,
    resolvedAtIso: params.resolvedAtIso,
    threadId,
    turnId: readNestedString(params.pendingRequest.params, ['turnId']),
    itemId: readNestedString(params.pendingRequest.params, ['itemId']),
    decision: readApprovalDecisionFromReply(params.reply),
    scope: params.scope,
    mode: params.mode,
    errorMessage: params.reply.error?.message ?? '',
  }
}

function normalizeMcpServerStatus(value: unknown): McpServerDiagnosticStatus {
  if (value === 'starting' || value === 'ready' || value === 'failed' || value === 'cancelled') {
    return value
  }
  return 'unknown'
}

function normalizeMcpAuthStatus(value: unknown): McpServerAuthStatus {
  if (value === 'unsupported' || value === 'notLoggedIn' || value === 'bearerToken' || value === 'oAuth') {
    return value
  }
  return 'unknown'
}

function collectionSize(value: unknown): number {
  if (Array.isArray(value)) return value.length
  const record = asRecord(value)
  return record ? Object.keys(record).length : 0
}

function createEmptyMcpServerDiagnostic(name: string, updatedAtIso: string): McpServerDiagnostic {
  return {
    name,
    status: 'unknown',
    authStatus: 'unknown',
    title: '',
    version: '',
    websiteUrl: '',
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
    error: '',
    threadId: '',
    updatedAtIso,
  }
}

export function normalizeMcpServerInventory(payload: unknown): McpServerDiagnostic[] {
  const root = asRecord(payload)
  const data = Array.isArray(root?.data) ? root.data : []
  const updatedAtIso = new Date().toISOString()
  const rows: McpServerDiagnostic[] = []

  for (const row of data) {
    const record = asRecord(row)
    const name = readString(record?.name)
    if (!record || !name) continue

    const serverInfo = asRecord(record.serverInfo)
    rows.push({
      ...createEmptyMcpServerDiagnostic(name, updatedAtIso),
      authStatus: normalizeMcpAuthStatus(record.authStatus),
      title: readString(serverInfo?.title) || readString(serverInfo?.name),
      version: readString(serverInfo?.version),
      websiteUrl: readString(serverInfo?.websiteUrl),
      toolCount: collectionSize(record.tools),
      resourceCount: collectionSize(record.resources),
      resourceTemplateCount: collectionSize(record.resourceTemplates),
    })
  }

  return rows
}

export function mergeMcpServerDiagnostics(
  startupRows: McpServerDiagnostic[],
  inventoryRows: McpServerDiagnostic[],
): McpServerDiagnostic[] {
  const byName = new Map<string, McpServerDiagnostic>()
  for (const row of startupRows) {
    byName.set(row.name, row)
  }

  for (const inventory of inventoryRows) {
    const startup = byName.get(inventory.name)
    byName.set(inventory.name, {
      ...inventory,
      status: startup?.status ?? inventory.status,
      error: startup?.error ?? inventory.error,
      threadId: startup?.threadId ?? inventory.threadId,
      updatedAtIso: startup?.updatedAtIso ?? inventory.updatedAtIso,
    })
  }

  return Array.from(byName.values()).sort((first, second) => first.name.localeCompare(second.name))
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function resultErrorMessage(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'fulfilled') return ''
  return result.reason instanceof Error && result.reason.message
    ? result.reason.message
    : String(result.reason)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    chunks.push(buffer)
  }

  if (chunks.length === 0) return null

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return null

  return JSON.parse(raw) as unknown
}

function workflowNotificationId(run: ToolingWorkflowRun, suffix: string): string {
  return `workflow:${run.id}:${suffix}:${run.updatedAtIso}`
}

async function dispatchWorkflowProductNotification(
  cwd: string,
  event: Parameters<NotificationDispatcher['dispatchProductEvent']>[0],
  productEventHub?: ProductEventHub,
): Promise<void> {
  const dispatcher = new NotificationDispatcher({ workspaceCwd: cwd })
  const report = await dispatcher.dispatchProductEvent(event)
  productEventHub?.emit(report.event)
  if (report.failedCount > 0) {
    console.warn(`Workflow notification dispatch failed for ${event.title}: ${String(report.failedCount)} channel(s) failed.`)
  }
}

async function handleCreateWorkspaceWorkflowWithNotifications(
  req: IncomingMessage,
  res: ServerResponse,
  productEventHub: ProductEventHub,
): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req))
    const cwd = readString(body?.cwd)
    const templateId = readString(body?.templateId)
    const goal = readString(body?.goal)
    const result = await createWorkspaceWorkflowRun({ cwd, templateId, goal })
    await dispatchWorkflowProductNotification(cwd, {
      id: workflowNotificationId(result, 'created'),
      kind: 'task_started',
      title: 'Workflow created',
      summary: `${result.templateName}: ${result.goal.slice(0, 160)}`,
      severity: result.warnings.length > 0 ? 'warning' : 'info',
      method: 'tooling/workflows:create',
    }, productEventHub)
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to create workspace workflow'
    setJson(res, 400, { error: message })
  }
}

function workflowAgentStatusNotificationKind(status: ToolingWorkflowStepStatus | string): {
  kind: Parameters<NotificationDispatcher['dispatchProductEvent']>[0]['kind']
  severity: Parameters<NotificationDispatcher['dispatchProductEvent']>[0]['severity']
  title: string
} | null {
  if (status === 'blocked') {
    return {
      kind: 'user_input_required',
      severity: 'warning',
      title: 'Workflow agent blocked',
    }
  }
  if (status === 'running') {
    return {
      kind: 'task_started',
      severity: 'info',
      title: 'Workflow agent started',
    }
  }
  return null
}

function workflowRunStatusNotification(run: ToolingWorkflowRun): {
  kind: Parameters<NotificationDispatcher['dispatchProductEvent']>[0]['kind']
  severity: Parameters<NotificationDispatcher['dispatchProductEvent']>[0]['severity']
  title: string
  suffix: string
} | null {
  if (run.status === 'ready_for_review') {
    return {
      kind: 'ready_for_review',
      severity: 'success',
      title: 'Workflow ready for review',
      suffix: 'ready-for-review',
    }
  }
  if (run.status === 'completed') {
    return {
      kind: 'task_completed',
      severity: 'success',
      title: 'Workflow completed',
      suffix: 'completed',
    }
  }
  if (run.status === 'failed') {
    return {
      kind: 'task_failed',
      severity: 'danger',
      title: 'Workflow failed',
      suffix: 'failed',
    }
  }
  return null
}

async function handleUpdateWorkspaceWorkflowAgentStatusWithNotifications(
  req: IncomingMessage,
  res: ServerResponse,
  productEventHub: ProductEventHub,
): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req))
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
    const agent = result.agents.find((candidate) => candidate.id === agentId)
    const runNotification = workflowRunStatusNotification(result)
    const statusNotification = workflowAgentStatusNotificationKind(status)
    const notification = runNotification ?? statusNotification
    if (notification) {
      await dispatchWorkflowProductNotification(cwd, {
        id: workflowNotificationId(result, runNotification?.suffix ?? `agent-${agentId}-${status}`),
        kind: notification.kind,
        title: notification.title,
        summary: agent
          ? `${result.templateName}: ${agent.agentName} is ${agent.status}. ${result.summary}`
          : `${result.templateName}: ${result.summary}`,
        severity: notification.severity,
        method: 'tooling/workflows/agent-status',
      }, productEventHub)
    }
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to update workflow agent status'
    setJson(res, 400, { error: message })
  }
}

async function handleProvisionWorkspaceWorkflowAgentWorktreeWithNotifications(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req))
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

async function handleRunWorkspaceWorkflowValidationWithNotifications(
  req: IncomingMessage,
  res: ServerResponse,
  productEventHub: ProductEventHub,
): Promise<void> {
  try {
    const body = asRecord(await readJsonBody(req))
    const cwd = readString(body?.cwd)
    const runId = readString(body?.runId)
    const scriptName = readString(body?.scriptName)
    const result: ToolingWorkflowValidationResult = await runWorkspaceWorkflowValidation({ cwd, runId, scriptName })
    if (result.validationRun.status !== 'passed') {
      const isTestCommand = /(^|[:_-])(test|spec)($|[:_-])/iu.test(result.validationRun.scriptName)
      await dispatchWorkflowProductNotification(cwd, {
        id: workflowNotificationId(result.run, `validation-${scriptName}-${result.validationRun.status}`),
        kind: isTestCommand ? 'test_failed' : 'command_failed',
        title: isTestCommand ? 'Workflow test failed' : 'Workflow command failed',
        summary: `${result.validationRun.command} -> ${result.validationRun.status}`,
        severity: 'danger',
        method: 'tooling/workflows/validation-run',
      }, productEventHub)
    } else {
      const runNotification = workflowRunStatusNotification(result.run)
      if (runNotification) {
        await dispatchWorkflowProductNotification(cwd, {
          id: workflowNotificationId(result.run, runNotification.suffix),
          kind: runNotification.kind,
          title: runNotification.title,
          summary: `${result.run.templateName}: ${result.run.summary}`,
          severity: runNotification.severity,
          method: 'tooling/workflows/validation-run',
        }, productEventHub)
      }
    }
    setJson(res, 200, { result })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Failed to run workflow validation'
    setJson(res, 400, { error: message })
  }
}

export const CODEX_APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'] as const
export const APP_SERVER_RPC_TIMEOUT_MS = 20_000
export const APP_SERVER_DIAGNOSTICS_RPC_TIMEOUT_MS = 5_000
export const APP_SERVER_RESTART_COOLDOWN_MS = 1_750
export const APP_SERVER_TIMEOUT_RECOVERY_METHODS = new Set([
  'thread/read',
  'thread/loaded/list',
])

export function appServerRpcTimeoutMessage(method: string, timeoutMs: number): string {
  return `codex app-server RPC ${method} timed out after ${String(timeoutMs)}ms`
}

export function shouldRecoverAppServerAfterRpcTimeout(input: {
  method: string
  pendingClientRequestCount: number
  pendingServerRequestCount: number
}): boolean {
  return (
    APP_SERVER_TIMEOUT_RECOVERY_METHODS.has(input.method) &&
    input.pendingClientRequestCount === 0 &&
    input.pendingServerRequestCount === 0
  )
}

export function isAppServerAlreadyInitializedError(payload: unknown): boolean {
  return /already initialized/iu.test(getErrorMessage(payload, ''))
}

class AppServerProcess {
  private readonly host: CoreAppServerHost
  private logSequence = 0
  private readonly recentLogs: AppServerDiagnosticLog[] = []
  private readonly mcpServers = new Map<string, McpServerDiagnostic>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly pendingServerRequestApprovalScopes = new Map<number, ToolingApprovalDecisionScope>()
  private nextSmokeServerRequestId = 900_000

  constructor() {
    this.host = createAppServerHost({
      command: 'codex',
      args: [...CODEX_APP_SERVER_ARGS],
      rpcTimeoutMs: APP_SERVER_RPC_TIMEOUT_MS,
      restartCooldownMs: APP_SERVER_RESTART_COOLDOWN_MS,
      initializeParams: {
        clientInfo: { name: 'cody-web-ui', title: 'CodyWeb', version: '0.5.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    })
    this.host.subscribe((notification) => {
      if (notification.method === 'server/request') {
        const request = asRecord(notification.params)
        if (request && typeof request.id === 'number' && typeof request.method === 'string') {
          void this.handleServerRequest(request.id, request.method, request.params ?? null)
        }
        return
      }
      // CodyWeb emits a richer resolved notification after policy/audit work.
      if (notification.method === 'server/request/resolved') return
      if (notification.method === 'server/request/expired') {
        const request = asRecord(notification.params)
        if (request && typeof request.id === 'number') {
          this.pendingServerRequests.delete(request.id)
          this.pendingServerRequestApprovalScopes.delete(request.id)
        }
      }
      this.emitNotification(notification)
    })
  }

  private pushLog(
    level: AppServerDiagnosticLogLevel,
    source: AppServerDiagnosticLogSource,
    rawMessage: string,
  ): void {
    const message = rawMessage.replace(/\s+/gu, ' ').trim()
    if (!message) return

    this.logSequence += 1
    this.recentLogs.push({
      id: `app-server-log-${String(this.logSequence)}`,
      createdAtIso: new Date().toISOString(),
      level,
      source,
      message: message.length > 500 ? `${message.slice(0, 500)}...` : message,
    })
    if (this.recentLogs.length > 80) {
      this.recentLogs.splice(0, this.recentLogs.length - 80)
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    this.captureMcpServerStatus(notification)
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private captureMcpServerStatus(notification: { method: string; params: unknown }): void {
    if (notification.method !== 'mcpServer/startupStatus/updated') return

    const params = asRecord(notification.params)
    if (!params) return

    const name = readString(params.name)
    if (!name) return

    this.mcpServers.set(name, {
      ...createEmptyMcpServerDiagnostic(name, new Date().toISOString()),
      status: normalizeMcpServerStatus(params.status),
      error: readString(params.error),
      threadId: readString(params.threadId),
    })
  }

  private async sendServerRequestReply(requestId: number, reply: ServerRequestReply): Promise<void> {
    await this.host.resolveServerRequest(requestId, reply)
  }

  private async resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): Promise<void> {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    if (!pendingRequest.isSmokeInjected) {
      await this.sendServerRequestReply(requestId, reply)
    }
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    const resolvedAtIso = new Date().toISOString()
    const decision = readApprovalDecisionFromReply(reply)
    const scope = normalizeApprovalDecisionScope(this.pendingServerRequestApprovalScopes.get(requestId), decision)
    this.pendingServerRequestApprovalScopes.delete(requestId)
    const auditInput = buildApprovalAuditInput({
      requestId,
      pendingRequest,
      reply,
      scope,
      mode: 'manual',
      resolvedAtIso,
    })
    void recordApprovalDecisionAuditEvent(auditInput)
    void createPersistentApprovalGrant(auditInput)
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        decision,
        scope,
        mode: 'manual',
        resolvedAtIso,
      },
    })
  }

  private async resolveServerRequestWithStoredGrant(pendingRequest: PendingServerRequest): Promise<ToolingApprovalGrant | null> {
    if (!isStoredGrantEligibleRequest(pendingRequest.method)) return null

    const cwd = readServerRequestCwd(pendingRequest.params)
    const subject = readServerRequestSubject(pendingRequest.method, pendingRequest.params)
    const grant = await findMatchingApprovalGrant({
      cwd,
      method: pendingRequest.method,
      subject,
    })
    if (!grant) return null

    const reply: ServerRequestReply = { result: { decision: 'accept' } }
    const resolvedAtIso = new Date().toISOString()
    await this.sendServerRequestReply(pendingRequest.id, reply)
    const auditInput = buildApprovalAuditInput({
      requestId: pendingRequest.id,
      pendingRequest,
      reply,
      scope: grant.scope,
      mode: 'automatic',
      resolvedAtIso,
    })
    void recordApprovalDecisionAuditEvent(auditInput)
    void recordApprovalGrantUse({
      cwd,
      grant,
      requestId: pendingRequest.id,
      method: pendingRequest.method,
      subject,
      threadId: auditInput.threadId,
      turnId: auditInput.turnId,
      itemId: auditInput.itemId,
    })
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: pendingRequest.id,
        method: pendingRequest.method,
        threadId: auditInput.threadId,
        decision: 'accept',
        scope: grant.scope,
        mode: 'automatic',
        grantId: grant.id,
        resolvedAtIso,
      },
    })
    return grant
  }

  private async evaluatePendingRequestCommandPolicy(pendingRequest: PendingServerRequest): Promise<ToolingCommandPolicyEvaluation | null> {
    if (!isCommandApprovalRequest(pendingRequest.method)) return null
    return evaluateWorkspaceCommandPolicy({
      cwd: readServerRequestCwd(pendingRequest.params),
      command: readServerRequestSubject(pendingRequest.method, pendingRequest.params),
    })
  }

  private async evaluatePendingRequestFileChangePolicy(pendingRequest: PendingServerRequest): Promise<ToolingFileChangePolicyEvaluation | null> {
    if (!isFileChangeApprovalRequest(pendingRequest.method)) return null
    return evaluateWorkspaceFileChangePolicy({
      cwd: readServerRequestCwd(pendingRequest.params),
      grantRoot: readServerRequestSubject(pendingRequest.method, pendingRequest.params),
    })
  }

  private async rejectServerRequestByCommandPolicy(pendingRequest: PendingServerRequest, evaluation: ToolingCommandPolicyEvaluation): Promise<void> {
    const reply: ServerRequestReply = {
      error: {
        code: -32000,
        message: evaluation.reason,
      },
    }
    const resolvedAtIso = new Date().toISOString()
    await this.sendServerRequestReply(pendingRequest.id, reply)
    const auditInput = buildApprovalAuditInput({
      requestId: pendingRequest.id,
      pendingRequest,
      reply,
      scope: 'single',
      mode: 'automatic',
      resolvedAtIso,
    })
    void recordCommandPolicyDecisionAuditEvent({
      cwd: readServerRequestCwd(pendingRequest.params),
      requestId: pendingRequest.id,
      method: pendingRequest.method,
      threadId: auditInput.threadId,
      turnId: auditInput.turnId,
      itemId: auditInput.itemId,
      evaluation,
      action: 'auto_rejected',
    })
    void recordApprovalDecisionAuditEvent(auditInput)
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: pendingRequest.id,
        method: pendingRequest.method,
        threadId: auditInput.threadId,
        decision: 'rejected',
        scope: 'single',
        mode: 'automatic',
        policyStatus: evaluation.status,
        policyReason: evaluation.reason,
        resolvedAtIso,
      },
    })
  }

  private async rejectServerRequestByFileChangePolicy(pendingRequest: PendingServerRequest, evaluation: ToolingFileChangePolicyEvaluation): Promise<void> {
    const reply: ServerRequestReply = {
      error: {
        code: -32000,
        message: evaluation.reason,
      },
    }
    const resolvedAtIso = new Date().toISOString()
    await this.sendServerRequestReply(pendingRequest.id, reply)
    const auditInput = buildApprovalAuditInput({
      requestId: pendingRequest.id,
      pendingRequest,
      reply,
      scope: 'single',
      mode: 'automatic',
      resolvedAtIso,
    })
    void recordFileChangePolicyDecisionAuditEvent({
      cwd: readServerRequestCwd(pendingRequest.params),
      requestId: pendingRequest.id,
      method: pendingRequest.method,
      threadId: auditInput.threadId,
      turnId: auditInput.turnId,
      itemId: auditInput.itemId,
      evaluation,
      action: 'auto_rejected',
    })
    void recordApprovalDecisionAuditEvent(auditInput)
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: pendingRequest.id,
        method: pendingRequest.method,
        threadId: auditInput.threadId,
        decision: 'rejected',
        scope: 'single',
        mode: 'automatic',
        policyStatus: evaluation.status,
        policyReason: evaluation.reason,
        resolvedAtIso,
      },
    })
  }

  private async handleServerRequest(requestId: number, method: string, params: unknown): Promise<void> {
    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
      commandPolicy: null,
      fileChangePolicy: null,
    }

    try {
      pendingRequest.commandPolicy = await this.evaluatePendingRequestCommandPolicy(pendingRequest)
      if (pendingRequest.commandPolicy?.status === 'denied') {
        await this.rejectServerRequestByCommandPolicy(pendingRequest, pendingRequest.commandPolicy)
        return
      }
      if (pendingRequest.commandPolicy) {
        const auditInput = buildApprovalAuditInput({
          requestId: pendingRequest.id,
          pendingRequest,
          reply: { result: { decision: 'pending' } },
          scope: 'single',
          mode: 'automatic',
          resolvedAtIso: new Date().toISOString(),
        })
        void recordCommandPolicyDecisionAuditEvent({
          cwd: readServerRequestCwd(pendingRequest.params),
          requestId: pendingRequest.id,
          method: pendingRequest.method,
          threadId: auditInput.threadId,
          turnId: auditInput.turnId,
          itemId: auditInput.itemId,
          evaluation: pendingRequest.commandPolicy,
          action: 'pending',
        })
      }
    } catch (error) {
      this.pushLog('warning', 'bridge', `Command policy lookup failed: ${getErrorMessage(error, 'unknown error')}`)
    }

    try {
      pendingRequest.fileChangePolicy = await this.evaluatePendingRequestFileChangePolicy(pendingRequest)
      if (pendingRequest.fileChangePolicy && pendingRequest.fileChangePolicy.status !== 'allowed') {
        await this.rejectServerRequestByFileChangePolicy(pendingRequest, pendingRequest.fileChangePolicy)
        return
      }
      if (pendingRequest.fileChangePolicy) {
        const auditInput = buildApprovalAuditInput({
          requestId: pendingRequest.id,
          pendingRequest,
          reply: { result: { decision: 'pending' } },
          scope: 'single',
          mode: 'automatic',
          resolvedAtIso: new Date().toISOString(),
        })
        void recordFileChangePolicyDecisionAuditEvent({
          cwd: readServerRequestCwd(pendingRequest.params),
          requestId: pendingRequest.id,
          method: pendingRequest.method,
          threadId: auditInput.threadId,
          turnId: auditInput.turnId,
          itemId: auditInput.itemId,
          evaluation: pendingRequest.fileChangePolicy,
          action: 'pending',
        })
      }
    } catch (error) {
      this.pushLog('warning', 'bridge', `File change policy lookup failed: ${getErrorMessage(error, 'unknown error')}`)
    }

    try {
      const grant = await this.resolveServerRequestWithStoredGrant(pendingRequest)
      if (grant) return
    } catch (error) {
      this.pushLog('warning', 'bridge', `Stored approval grant lookup failed: ${getErrorMessage(error, 'unknown error')}`)
    }

    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown, timeoutMs = APP_SERVER_RPC_TIMEOUT_MS): Promise<unknown> {
    return this.host.call(method, params, { timeoutMs })
  }

  private async ensureInitialized(_timeoutMs = APP_SERVER_RPC_TIMEOUT_MS): Promise<void> {
    await this.host.ensureInitialized()
  }

  async rpc(method: string, params: unknown, timeoutMs = APP_SERVER_RPC_TIMEOUT_MS): Promise<unknown> {
    await this.ensureInitialized(timeoutMs)
    return this.call(method, params, timeoutMs)
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const pendingRequest = this.pendingServerRequests.get(id)
    if (!pendingRequest?.isSmokeInjected) {
      await this.ensureInitialized()
    }

    if (
      body.approvalScope === 'single' ||
      body.approvalScope === 'session' ||
      body.approvalScope === 'workspace' ||
      body.approvalScope === 'permanent'
    ) {
      this.pendingServerRequestApprovalScopes.set(id, body.approvalScope)
    }

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      await this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    await this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    return Array.from(this.pendingServerRequests.values())
  }

  isServerRequestPending(id: number): boolean {
    return this.pendingServerRequests.has(id)
  }

  injectSmokeServerRequest(payload: unknown): PendingServerRequest {
    if (!areSmokeHooksEnabled()) {
      throw new Error('Smoke hooks are disabled')
    }

    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid smoke request payload: expected object')
    }

    const method = readString(body.method)
    if (!method) {
      throw new Error('Invalid smoke request payload: "method" is required')
    }

    const id = typeof body.id === 'number' && Number.isInteger(body.id)
      ? body.id
      : this.nextSmokeServerRequestId++
    const pendingRequest: PendingServerRequest = {
      id,
      method,
      params: body.params ?? {},
      receivedAtIso: new Date().toISOString(),
      commandPolicy: asRecord(body.commandPolicy) as ToolingCommandPolicyEvaluation | null,
      fileChangePolicy: asRecord(body.fileChangePolicy) as ToolingFileChangePolicyEvaluation | null,
      isSmokeInjected: true,
    }

    this.pendingServerRequests.set(id, pendingRequest)
    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
    return pendingRequest
  }

  async listMcpServerInventory(timeoutMs = APP_SERVER_DIAGNOSTICS_RPC_TIMEOUT_MS): Promise<McpServerDiagnostic[]> {
    const result = await this.rpc('mcpServerStatus/list', {
      cursor: null,
      detail: 'toolsAndAuthOnly',
      limit: 100,
      threadId: null,
    }, timeoutMs)
    return normalizeMcpServerInventory(result)
  }

  listDiagnosticServerRequests(): DiagnosticServerRequest[] {
    return this.listPendingServerRequests().map((request) => ({
      id: request.id,
      method: request.method,
      receivedAtIso: request.receivedAtIso,
      threadId:
        readNestedString(request.params, ['threadId']) ||
        readNestedString(request.params, ['thread', 'id']) ||
        readNestedString(request.params, ['request', 'threadId']),
      turnId:
        readNestedString(request.params, ['turnId']) ||
        readNestedString(request.params, ['turn', 'id']) ||
        readNestedString(request.params, ['request', 'turnId']),
      itemId:
        readNestedString(request.params, ['itemId']) ||
        readNestedString(request.params, ['item', 'id']) ||
        readNestedString(request.params, ['request', 'itemId']),
    }))
  }

  getDiagnostics(): AppServerDiagnostics {
    const diagnostics = this.host.diagnostics()
    const coreLogs: AppServerDiagnosticLog[] = diagnostics.recentLogs.map((log, index) => ({
      id: `core-app-server-log-${String(index)}-${log.atIso}`,
      createdAtIso: log.atIso,
      level: log.level,
      source: log.source,
      message: log.message,
    }))
    return {
      ...diagnostics,
      pendingServerRequestCount: this.pendingServerRequests.size,
      pendingServerRequests: this.listDiagnosticServerRequests(),
      mcpServers: Array.from(this.mcpServers.values())
        .sort((first, second) => first.name.localeCompare(second.name)),
      mcpInventoryError: '',
      recentLogs: [...this.recentLogs, ...coreLogs].sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso)),
    }
  }

  dispose(): void {
    this.pendingServerRequests.clear()
    this.pendingServerRequestApprovalScopes.clear()
    void this.host.dispose()
  }
}

class MethodCatalog {
  private methodCache: string[] | null = null
  private notificationCache: string[] | null = null

  private async runGenerateSchemaCommand(outDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const process = spawn('codex', ['app-server', 'generate-json-schema', '--out', outDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''

      process.stderr.setEncoding('utf8')
      process.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      process.on('error', reject)
      process.on('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `generate-json-schema exited with code ${String(code)}`))
      })
    })
  }

  private extractMethodsFromClientRequest(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  private extractMethodsFromServerNotification(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  async listMethods(): Promise<string[]> {
    if (this.methodCache) {
      return this.methodCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const clientRequestPath = join(outDir, 'ClientRequest.json')
    const raw = await readFile(clientRequestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromClientRequest(parsed)

    this.methodCache = methods
    return methods
  }

  async listNotificationMethods(): Promise<string[]> {
    if (this.notificationCache) {
      return this.notificationCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const serverNotificationPath = join(outDir, 'ServerNotification.json')
    const raw = await readFile(serverNotificationPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromServerNotification(parsed)

    this.notificationCache = methods
    return methods
  }
}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
}

type SharedBridgeState = {
  appServer: AppServerProcess
  catalogSync: CatalogSyncService
  threadMessageCache: ThreadMessageCache
  tokenUsageReconciliation?: TokenUsageReconciliationService
  agentTasks?: AgentTaskService
  methodCatalog: MethodCatalog
  stopNotificationDispatch: () => void
  productEventHub: ProductEventHub
  feishuIntegration: FeishuIntegration
}

export type CodexBridgeWebSocketOptions = {
  authorizeUpgrade?: (req: IncomingMessage) => boolean
}

type BridgeWebSocketMessage =
  | {
      type: 'ready'
      atIso: string
    }
  | {
      type: 'rpc'
      notification: unknown
      atIso: string
    }
  | {
      type: 'product'
      notification: NotificationDispatchEvent
      atIso: string
    }

type ProductEventListener = (event: NotificationDispatchEvent) => void

class ProductEventHub {
  private readonly listeners = new Set<ProductEventListener>()

  subscribe(listener: ProductEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: NotificationDispatchEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

function sendBridgeWebSocketMessage(socket: WebSocket, message: BridgeWebSocketMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(message))
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'
const notificationPersistenceQueueByThread = new Map<string, Promise<void>>()
const automaticCheckpointFingerprintByTurn = new Map<string, string>()
const AUTOMATIC_CHECKPOINT_BACKOFF_BASE_MS = 30_000
const AUTOMATIC_CHECKPOINT_BACKOFF_MAX_MS = 5 * 60_000
const automaticCheckpointBackoffByWorkspace = new Map<string, { failureCount: number; retryAtMs: number }>()

function enqueueNotificationPersistence(key: string, task: () => Promise<void>): void {
  const previous = notificationPersistenceQueueByThread.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task).finally(() => {
    if (notificationPersistenceQueueByThread.get(key) === current) notificationPersistenceQueueByThread.delete(key)
  })
  notificationPersistenceQueueByThread.set(key, current)
}

export async function createAutomaticTurnCheckpoint(
  cwd: string,
  notification: { method: string; params?: unknown },
): Promise<Record<string, unknown>> {
  const phase = notification.method === 'turn/started'
    ? 'before'
    : notification.method === 'turn/completed'
      ? 'after'
      : ''
  if (!phase) return {}

  const prefix = phase === 'before' ? 'beforeCheckpoint' : 'afterCheckpoint'
  const backoffKey = resolve(cwd)
  const backoff = automaticCheckpointBackoffByWorkspace.get(backoffKey)
  if (backoff && backoff.retryAtMs > Date.now()) {
    return {
      [`${prefix}Skipped`]: true,
      [`${prefix}Reason`]: 'checkpoint-failure-backoff',
      [`${prefix}FailureCount`]: backoff.failureCount,
      [`${prefix}RetryAtIso`]: new Date(backoff.retryAtMs).toISOString(),
    }
  }

  try {
    const threadId = readNotificationThreadId(notification.params)
    const turnId = readNotificationTurnId(notification.params)
    const { repositoryKey, fingerprint, dirty } = await readToolingCheckpointFingerprint(cwd)
    const fingerprintKey = `${repositoryKey}:${threadId}:${turnId}`
    if (phase === 'after' && automaticCheckpointFingerprintByTurn.get(fingerprintKey) === fingerprint) {
      automaticCheckpointFingerprintByTurn.delete(fingerprintKey)
      automaticCheckpointBackoffByWorkspace.delete(backoffKey)
      return { afterCheckpointSkipped: true, afterCheckpointReason: 'workspace-unchanged' }
    }
    if (phase === 'before') automaticCheckpointFingerprintByTurn.set(fingerprintKey, fingerprint)
    else automaticCheckpointFingerprintByTurn.delete(fingerprintKey)
    while (automaticCheckpointFingerprintByTurn.size > 1_000) {
      const oldestKey = automaticCheckpointFingerprintByTurn.keys().next().value as string | undefined
      if (!oldestKey) break
      automaticCheckpointFingerprintByTurn.delete(oldestKey)
    }
    if (!dirty) {
      automaticCheckpointBackoffByWorkspace.delete(backoffKey)
      return { [`${prefix}Skipped`]: true, [`${prefix}Reason`]: 'workspace-clean' }
    }
    const label = `${phase === 'before' ? 'Before' : 'After'} turn ${shortId(turnId)} (${shortId(threadId)})`
    const checkpoint = await createToolingCheckpoint({
      cwd,
      label,
      untrackedPolicy: 'files-only',
    })
    automaticCheckpointBackoffByWorkspace.delete(backoffKey)
    return {
      [`${prefix}Id`]: checkpoint.id,
      [`${prefix}HasPatch`]: checkpoint.hasPatch,
      [`${prefix}PatchBytes`]: checkpoint.patchBytes,
      ...(checkpoint.pruneFailedCheckpointIds?.length
        ? { [`${prefix}PruneFailedCheckpointIds`]: checkpoint.pruneFailedCheckpointIds }
        : {}),
    }
  } catch (error) {
    const failureCount = (backoff?.failureCount ?? 0) + 1
    const delayMs = Math.min(
      AUTOMATIC_CHECKPOINT_BACKOFF_MAX_MS,
      AUTOMATIC_CHECKPOINT_BACKOFF_BASE_MS * 2 ** Math.min(failureCount - 1, 10),
    )
    automaticCheckpointBackoffByWorkspace.delete(backoffKey)
    automaticCheckpointBackoffByWorkspace.set(backoffKey, { failureCount, retryAtMs: Date.now() + delayMs })
    while (automaticCheckpointBackoffByWorkspace.size > 1_000) {
      const oldestKey = automaticCheckpointBackoffByWorkspace.keys().next().value as string | undefined
      if (!oldestKey) break
      automaticCheckpointBackoffByWorkspace.delete(oldestKey)
    }
    throw error
  }
}

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_BRIDGE_KEY]?: SharedBridgeState
  }

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing) {
    // Older tests and hot-reloaded processes may have created the shared bridge
    // before the Feishu integration existed. Hydrate it in place so the shared
    // app-server remains reusable instead of forcing a second process.
    if (!existing.feishuIntegration) {
      existing.feishuIntegration = createFeishuIntegration({
        rpc: (method, params) => existing.appServer.rpc(method, params),
        respondToServerRequest: (payload) => existing.appServer.respondToServerRequest(payload),
        isServerRequestPending: (id) => existing.appServer.isServerRequestPending(id),
        subscribe: (listener) => existing.appServer.onNotification(listener),
        catalogSync: existing.catalogSync,
      })
    }
    if (!existing.threadMessageCache) {
      existing.threadMessageCache = new ThreadMessageCache({
        rpc: (method, params) => existing.appServer.rpc(method, params),
      })
      existing.threadMessageCache.start()
    }
    return existing
  }

  const appServer = new AppServerProcess()
  const catalogSync = new CatalogSyncService((method, params) => appServer.rpc(method, params))
  const threadMessageCache = new ThreadMessageCache({
    rpc: (method, params) => appServer.rpc(method, params),
  })
  threadMessageCache.start()
  const tokenUsageReconciliation = new TokenUsageReconciliationService()
  const productEventHub = new ProductEventHub()
  const agentTasks = new AgentTaskService((method, params) => appServer.rpc(method, params), {
    onEvent: async ({ task, run, title, summary, severity }) => {
      await dispatchWorkflowProductNotification(task.cwd, {
        id: `agent-task:${task.id}:${run.id}:${title}`,
        kind: severity === 'danger' ? 'task_failed' : severity === 'warning' ? 'user_input_required' : severity === 'success' ? 'task_completed' : 'task_started',
        title,
        summary,
        severity,
        threadId: run.threadId,
        turnId: run.turnId,
        method: 'agent-task/event',
      }, productEventHub)
    },
  })
  const notificationDispatcher = new NotificationDispatcher({
    workspaceCwd: getProcessCwd(),
  })
  const feishuIntegration = createFeishuIntegration({
    rpc: (method, params) => appServer.rpc(method, params),
    respondToServerRequest: (payload) => appServer.respondToServerRequest(payload),
    isServerRequestPending: (id) => appServer.isServerRequestPending(id),
    subscribe: (listener) => appServer.onNotification(listener),
    catalogSync,
  })
  const stopNotificationDispatch = appServer.onNotification((notification) => {
    catalogSync.onNotification(notification.method)
    const cachedThreadId = readNotificationThreadId(notification.params)
    if (
      cachedThreadId &&
      (
        notification.method === 'turn/completed' ||
        notification.method === 'thread/compacted' ||
        notification.method === 'thread/rollback'
      )
    ) {
      threadMessageCache.markDirty(cachedThreadId)
    }
    const isAgentTaskNotification = agentTasks.ownsNotification(notification)
    agentTasks.onNotification(notification)
    const payload = {
      ...notification,
      atIso: new Date().toISOString(),
      metadata: {} as Record<string, unknown>,
    }
    if (!isAgentTaskNotification) void notificationDispatcher.handleCodexNotification(payload)
    const queueKey = readNotificationThreadId(notification.params) || 'global'
    enqueueNotificationPersistence(queueKey, async () => {
      const workspaceCwd = await resolveNotificationWorkspaceCwd(notification.params)
      try {
        payload.metadata = await createAutomaticTurnCheckpoint(workspaceCwd, notification)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`Failed to create automatic turn checkpoint: ${message}`)
      }

      try {
        await appendCodexSessionEvent(workspaceCwd, payload)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`Failed to persist Codex session event: ${message}`)
      }
    })
  })

  const created: SharedBridgeState = {
    appServer,
    catalogSync,
    threadMessageCache,
    tokenUsageReconciliation,
    agentTasks,
    methodCatalog: new MethodCatalog(),
    stopNotificationDispatch,
    productEventHub,
    feishuIntegration,
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  if (process.env.NODE_ENV !== 'test') {
    catalogSync.start()
    tokenUsageReconciliation.start()
    void agentTasks.start().catch((error: unknown) => {
      console.warn(`Agent task scheduler failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
    void feishuIntegration.start().catch((error: unknown) => {
      console.warn(`Feishu bot service failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return created
}

async function buildGatewayDiagnostics(
  appServer: AppServerProcess,
  methodCatalog: MethodCatalog,
): Promise<GatewayDiagnostics> {
  const [methodsResult, notificationsResult] = await Promise.allSettled([
    methodCatalog.listMethods(),
    methodCatalog.listNotificationMethods(),
  ])
  const methods = methodsResult.status === 'fulfilled' ? methodsResult.value : []
  const notifications = notificationsResult.status === 'fulfilled' ? notificationsResult.value : []
  const errors = [
    resultErrorMessage(methodsResult),
    resultErrorMessage(notificationsResult),
  ].filter(Boolean)
  const appDiagnostics = appServer.getDiagnostics()

  return {
    generatedAtIso: new Date().toISOString(),
    appServer: appDiagnostics,
    methodCatalog: {
      methods,
      notifications,
      methodCount: methods.length,
      notificationCount: notifications.length,
      errors,
    },
  }
}

async function handleCheckpointHealthRoute(url: URL, res: ServerResponse): Promise<void> {
  try {
    const cwd = url.searchParams.get('cwd')?.trim() ?? ''
    const health = await getToolingCheckpointHealth(cwd)
    const backoff = automaticCheckpointBackoffByWorkspace.get(resolve(cwd))
    setJson(res, 200, {
      result: {
        ...health,
        status: backoff && health.status === 'healthy' ? 'degraded' : health.status,
        automaticBackoff: backoff ? {
          failureCount: backoff.failureCount,
          retryAtIso: new Date(backoff.retryAtMs).toISOString(),
          active: backoff.retryAtMs > Date.now(),
        } : null,
      },
    })
  } catch (error) {
    setJson(res, 400, { error: error instanceof Error && error.message ? error.message : 'Failed to inspect checkpoint health' })
  }
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const { appServer, catalogSync, threadMessageCache, tokenUsageReconciliation, agentTasks, methodCatalog, stopNotificationDispatch, productEventHub, feishuIntegration } = getSharedBridgeState()
  const domainRoutes = [
    createGatewayRoutes({
      rpc: (method, params) => appServer.rpc(method, params),
      respond: (payload) => appServer.respondToServerRequest(payload),
      listPending: () => appServer.listPendingServerRequests(),
      listMethods: () => methodCatalog.listMethods(),
      listNotifications: () => methodCatalog.listNotificationMethods(),
      diagnostics: () => buildGatewayDiagnostics(appServer, methodCatalog),
      accessSecurity: ({ req }) => buildSecurityAccessSnapshot(req, { authEnabled: false, listenHost: '127.0.0.1', listenPort: null }),
    }),
    createBackgroundTaskRoutes({ catalogSync, tokenUsageReconciliation }),
    createAgentTaskRoutes(agentTasks),
    createCatalogRoutes(catalogSync),
    createThreadCacheRoutes(threadMessageCache),
    createFeishuRoutes(feishuIntegration.routes),
    createContentRoutes({ draftScenarioPackage: feishuIntegration.draftScenarioPackage }),
    createWorkspaceToolingRoutes({
      checkpointHealth: ({ url, res }) => handleCheckpointHealthRoute(url, res),
      createWorkflow: ({ req, res }) => handleCreateWorkspaceWorkflowWithNotifications(req, res, productEventHub),
      updateWorkflowAgentStatus: ({ req, res }) => handleUpdateWorkspaceWorkflowAgentStatusWithNotifications(req, res, productEventHub),
      provisionWorkflowAgentWorktree: ({ req, res }) => handleProvisionWorkspaceWorkflowAgentWorktreeWithNotifications(req, res),
      runWorkflowValidation: ({ req, res }) => handleRunWorkspaceWorkflowValidationWithNotifications(req, res, productEventHub),
    }),
    createSmokeRoutes({ enabled: areSmokeHooksEnabled, injectServerRequest: (payload) => appServer.injectSmokeServerRequest(payload) }),
  ]

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    try {
      if (!req.url) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')

      for (const route of domainRoutes) {
        if (await route({ req, res, url })) return
      }

      next()
    } catch (error) {
      const message = getErrorMessage(error, 'Unknown bridge error')
      setJson(res, 502, { error: message })
    }
  }

  middleware.dispose = () => {
    catalogSync.stop()
    threadMessageCache.stop()
    tokenUsageReconciliation?.stop()
    agentTasks?.stop()
    stopNotificationDispatch()
    productEventHub.clear()
    void feishuIntegration.stop()
    appServer.dispose()
    const globalScope = globalThis as typeof globalThis & {
      [SHARED_BRIDGE_KEY]?: SharedBridgeState
    }
    if (globalScope[SHARED_BRIDGE_KEY]?.appServer === appServer) {
      delete globalScope[SHARED_BRIDGE_KEY]
    }
  }

  return middleware
}

export function attachCodexBridgeWebSocketServer(
  server: HttpServer,
  options: CodexBridgeWebSocketOptions = {},
): () => void {
  const { appServer, productEventHub } = getSharedBridgeState()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/codex-api/ws') return

    if (options.authorizeUpgrade && !options.authorizeUpgrade(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, req)
    })
  }

  webSocketServer.on('connection', (socket) => {
    clients.add(socket)
    sendBridgeWebSocketMessage(socket, {
      type: 'ready',
      atIso: new Date().toISOString(),
    })

    const unsubscribeNotifications = appServer.onNotification((notification) => {
      sendBridgeWebSocketMessage(socket, {
        type: 'rpc',
        notification,
        atIso: new Date().toISOString(),
      })
    })

    const unsubscribeProductEvents = productEventHub.subscribe((event) => {
      sendBridgeWebSocketMessage(socket, {
        type: 'product',
        notification: event,
        atIso: new Date().toISOString(),
      })
    })

    socket.on('close', () => {
      unsubscribeNotifications()
      unsubscribeProductEvents()
      clients.delete(socket)
    })
  })

  server.on('upgrade', onUpgrade)

  return () => {
    server.off('upgrade', onUpgrade)
    for (const client of clients) {
      client.close()
    }
    clients.clear()
    webSocketServer.close()
  }
}
