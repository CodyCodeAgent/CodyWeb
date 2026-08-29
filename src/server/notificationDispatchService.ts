import { latestTerminalTurnEvent } from '@codycodeagent/cody-web-core/conversation'
import { readThreadId, readTurnId } from '@codycodeagent/cody-web-core/protocol'
import { normalizeCodexNotification } from '@codycodeagent/cody-web-core/session'
import {
  getWorkspaceNotificationDispatchConfig,
  type ToolingWorkspaceNotificationChannelType,
  type ToolingWorkspaceNotificationDispatchChannel,
  type ToolingWorkspaceNotificationEvent,
} from './toolingService.js'

export type CodexNotification = {
  method: string
  params: unknown
  atIso?: string
}

export type NotificationDispatchSeverity = 'info' | 'success' | 'warning' | 'danger'

export type NotificationDispatchEvent = {
  id: string
  kind: ToolingWorkspaceNotificationEvent
  title: string
  summary: string
  severity: NotificationDispatchSeverity
  createdAtIso: string
  threadId: string
  turnId: string
  method: string
}

export type NotificationDispatcherOptions = {
  workspaceCwd: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => Date
  onError?: (error: Error) => void
}

export type ProductNotificationEventInput = {
  kind: ToolingWorkspaceNotificationEvent
  title: string
  summary: string
  severity: NotificationDispatchSeverity
  threadId?: string
  turnId?: string
  method?: string
  id?: string
}

export type NotificationDeliveryResult = {
  channelName: string
  channelType: ToolingWorkspaceNotificationChannelType
  target: string
  status: 'sent' | 'failed' | 'skipped'
  httpStatus: number | null
  durationMs: number
  error: string
}

export type NotificationDeliveryReport = {
  cwd: string
  generatedAtIso: string
  event: NotificationDispatchEvent
  enabled: boolean
  attemptedCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  results: NotificationDeliveryResult[]
  warnings: string[]
}

type NotificationPayload = {
  source: 'cody-web-ui'
  version: 1
  event: NotificationDispatchEvent
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readNestedString(value: unknown, keys: string[]): string {
  let cursor: unknown = value
  for (const key of keys) {
    const record = asRecord(cursor)
    if (!record) return ''
    cursor = record[key]
  }
  return readString(cursor)
}

function readServerRequestMethod(params: unknown): string {
  return (
    readNestedString(params, ['method']) ||
    readNestedString(params, ['request', 'method']) ||
    readNestedString(params, ['params', 'method'])
  )
}

function readMaxRateLimitPercent(params: unknown): number | null {
  const root = asRecord(params)
  if (!root) return null

  const candidates: unknown[] = []
  const directSnapshot = asRecord(root.rateLimits)
  if (directSnapshot) {
    candidates.push(asRecord(directSnapshot.primary), asRecord(directSnapshot.secondary))
  }

  const codexSnapshot = asRecord(asRecord(root.rateLimitsByLimitId)?.codex)
  if (codexSnapshot) {
    candidates.push(asRecord(codexSnapshot.primary), asRecord(codexSnapshot.secondary))
  }

  const percents = candidates
    .map((candidate) => readNumber(asRecord(candidate)?.usedPercent))
    .filter((percent): percent is number => percent !== null)

  return percents.length > 0 ? Math.max(...percents) : null
}

function eventIdFor(notification: CodexNotification, createdAtIso: string): string {
  return [
    notification.method,
    readThreadId(notification.params),
    readTurnId(notification.params),
    createdAtIso,
  ].filter(Boolean).join(':')
}

export function notificationDispatchEventFromCodex(
  notification: CodexNotification,
  now: () => Date = () => new Date(),
): NotificationDispatchEvent | null {
  const createdAtIso = notification.atIso || now().toISOString()
  const threadId = readThreadId(notification.params)
  const turnId = readTurnId(notification.params)
  const id = eventIdFor(notification, createdAtIso)
  const events = normalizeCodexNotification({ ...notification, atIso: createdAtIso })
  const started = events.find((event) => event.type === 'turn.started')
  const terminal = latestTerminalTurnEvent(events)

  if (started) {
    return {
      id,
      kind: 'task_started',
      title: 'Task started',
      summary: threadId ? `Codex started working on thread ${threadId}.` : 'Codex started a task.',
      severity: 'info',
      createdAtIso,
      threadId,
      turnId,
      method: notification.method,
    }
  }

  if (notification.method === 'server/request') {
    const requestMethod = readServerRequestMethod(notification.params)
    return {
      id,
      kind: 'approval_required',
      title: 'Approval required',
      summary: requestMethod ? `${requestMethod} is waiting for approval.` : 'Codex is waiting for approval.',
      severity: 'warning',
      createdAtIso,
      threadId,
      turnId,
      method: notification.method,
    }
  }

  if (terminal) {
    const eventThreadId = terminal.threadId || threadId
    const eventTurnId = terminal.turnId || turnId
    if (terminal.type === 'turn.failed') {
      const errorMessage = readString(terminal.data.error) || 'Codex failed to complete the task.'
      return {
        id,
        kind: 'task_failed',
        title: 'Task failed',
        summary: errorMessage,
        severity: 'danger',
        createdAtIso,
        threadId: eventThreadId,
        turnId: eventTurnId,
        method: notification.method,
      }
    }

    if (terminal.type === 'turn.interrupted') {
      return {
        id,
        kind: 'task_failed',
        title: 'Task interrupted',
        summary: eventThreadId ? `Codex stopped working on thread ${eventThreadId}.` : 'Codex stopped the task.',
        severity: 'warning',
        createdAtIso,
        threadId: eventThreadId,
        turnId: eventTurnId,
        method: notification.method,
      }
    }

    return {
      id,
      kind: 'task_completed',
      title: 'Task completed',
      summary: eventThreadId ? `Codex completed thread ${eventThreadId}.` : 'Codex completed a task.',
      severity: 'success',
      createdAtIso,
      threadId: eventThreadId,
      turnId: eventTurnId,
      method: notification.method,
    }
  }

  if (notification.method === 'account/rateLimits/updated') {
    const maxPercent = readMaxRateLimitPercent(notification.params)
    if (maxPercent === null || maxPercent < 90) return null

    return {
      id,
      kind: 'rate_limit',
      title: 'Rate limit is high',
      summary: `Codex usage is at ${Math.round(maxPercent)}%.`,
      severity: 'warning',
      createdAtIso,
      threadId,
      turnId,
      method: notification.method,
    }
  }

  return null
}

function channelAllowsEvent(
  channel: ToolingWorkspaceNotificationDispatchChannel,
  event: NotificationDispatchEvent,
  workspaceEvents: ToolingWorkspaceNotificationEvent[],
): boolean {
  const workspaceAllows = workspaceEvents.length === 0 || workspaceEvents.includes(event.kind)
  const channelAllows = channel.events.length === 0 || channel.events.includes(event.kind)
  return channel.enabled && workspaceAllows && channelAllows
}

function textForEvent(event: NotificationDispatchEvent): string {
  return `[${event.severity.toUpperCase()}] ${event.title}: ${event.summary}`
}

function bodyForChannel(type: ToolingWorkspaceNotificationChannelType, payload: NotificationPayload): unknown {
  if (type === 'slack') {
    return {
      text: textForEvent(payload.event),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${payload.event.title}*\n${payload.event.summary}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `${payload.event.kind} · ${payload.event.createdAtIso}`,
            },
          ],
        },
      ],
    }
  }

  if (type === 'lark') {
    return {
      msg_type: 'text',
      content: {
        text: textForEvent(payload.event),
      },
    }
  }

  return payload
}

export class NotificationDispatcher {
  private readonly workspaceCwd: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly onError: (error: Error) => void

  constructor(options: NotificationDispatcherOptions) {
    this.workspaceCwd = options.workspaceCwd
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5000
    this.now = options.now ?? (() => new Date())
    this.onError = options.onError ?? (() => {})
  }

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const event = notificationDispatchEventFromCodex(notification, this.now)
    if (!event) return

    await this.dispatchEvent(event)
  }

  async dispatchProductEvent(input: ProductNotificationEventInput): Promise<NotificationDeliveryReport> {
    const createdAtIso = this.now().toISOString()
    const method = input.method?.trim() || 'tooling/product-event'
    const event: NotificationDispatchEvent = {
      id: input.id?.trim() || [
        method,
        input.kind,
        input.threadId?.trim() ?? '',
        input.turnId?.trim() ?? '',
        createdAtIso,
      ].filter(Boolean).join(':'),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      severity: input.severity,
      createdAtIso,
      threadId: input.threadId?.trim() ?? '',
      turnId: input.turnId?.trim() ?? '',
      method,
    }

    return this.dispatchEvent(event)
  }

  private async dispatchEvent(event: NotificationDispatchEvent): Promise<NotificationDeliveryReport> {
    const config = await getWorkspaceNotificationDispatchConfig(this.workspaceCwd)
    const results = config.enabled
      ? await Promise.all(config.channels
        .filter((channel) => channelAllowsEvent(channel, event, config.events))
        .map((channel) => this.sendToChannel(channel, event)))
      : []

    for (const result of results) {
      if (result.status === 'failed') {
        this.onError(new Error(result.error || `Notification channel ${result.channelName} failed`))
      }
    }

    const sentCount = results.filter((result) => result.status === 'sent').length
    const failedCount = results.filter((result) => result.status === 'failed').length
    const skippedCount = results.filter((result) => result.status === 'skipped').length
    return {
      cwd: this.workspaceCwd,
      generatedAtIso: this.now().toISOString(),
      event,
      enabled: config.enabled,
      attemptedCount: results.length,
      sentCount,
      failedCount,
      skippedCount,
      results,
      warnings: config.enabled
        ? config.warnings
        : ['Notifications are disabled in .cody-web-ui.yml.'],
    }
  }

  async dispatchTestNotification(): Promise<NotificationDeliveryReport> {
    const generatedAt = this.now()
    const event: NotificationDispatchEvent = {
      id: `notification-test:${generatedAt.toISOString()}`,
      kind: 'ready_for_review',
      title: 'Notification channel test',
      summary: 'CodyWeb sent a test notification from the workspace dashboard.',
      severity: 'info',
      createdAtIso: generatedAt.toISOString(),
      threadId: '',
      turnId: '',
      method: 'tooling/notifications/test',
    }
    return this.dispatchEvent(event)
  }

  private async sendToChannel(
    channel: ToolingWorkspaceNotificationDispatchChannel,
    event: NotificationDispatchEvent,
  ): Promise<NotificationDeliveryResult> {
    const startedAt = Date.now()
    if (!channel.enabled) {
      return {
        channelName: channel.name,
        channelType: channel.type,
        target: channel.target,
        status: 'skipped',
        httpStatus: null,
        durationMs: 0,
        error: 'Channel is disabled.',
      }
    }

    const payload: NotificationPayload = {
      source: 'cody-web-ui',
      version: 1,
      event,
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(channel.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'cody-web-ui-notifier',
        },
        body: JSON.stringify(bodyForChannel(channel.type, payload)),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Notification channel ${channel.name} returned HTTP ${String(response.status)}`)
      }

      return {
        channelName: channel.name,
        channelType: channel.type,
        target: channel.target,
        status: 'sent',
        httpStatus: response.status,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: '',
      }
    } catch (error) {
      return {
        channelName: channel.name,
        channelType: channel.type,
        target: channel.target,
        status: 'failed',
        httpStatus: null,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: error instanceof Error ? error.message : 'Notification dispatch failed',
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
