import { describe, expect, it } from 'vitest'
import {
  notificationFromProductNotification,
  notificationFromRpcNotification,
  shouldSendBrowserNotification,
  type BrowserNotificationEvent,
} from './useBrowserNotifications'
import type { ProductNotification, RpcNotification } from '../api/codexRealtimeClient'

function buildNotification(method: string, params: unknown): RpcNotification {
  return {
    method,
    params,
    atIso: '2026-07-05T09:30:00.000Z',
  }
}

function buildProductNotification(overrides: Partial<ProductNotification> = {}): ProductNotification {
  return {
    id: 'workflow:run-1:ready',
    kind: 'ready_for_review',
    title: 'Workflow ready for review',
    summary: 'Feature Build has review agents ready.',
    severity: 'success',
    createdAtIso: '2026-07-05T09:31:00.000Z',
    threadId: '',
    turnId: '',
    method: 'tooling/workflows/agent-status',
    ...overrides,
  }
}

describe('notificationFromRpcNotification', () => {
  it('maps server requests to approval notifications', () => {
    const event = notificationFromRpcNotification(buildNotification('server/request', {
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    }))

    expect(event).toMatchObject({
      kind: 'approval',
      title: 'Approval required',
      severity: 'warning',
    })
    expect(event?.body).toContain('item/commandExecution/requestApproval')
    expect(event?.sourceId).toContain('thread-1')
    expect(event?.sourceId).toContain('turn-1')
  })

  it('maps failed completed turns to danger notifications', () => {
    const event = notificationFromRpcNotification(buildNotification('turn/completed', {
      turn: {
        id: 'turn-7',
        threadId: 'thread-7',
        status: 'failed',
        error: {
          message: 'Typecheck failed',
        },
      },
    }))

    expect(event).toMatchObject({
      kind: 'turn-failed',
      title: 'Task failed',
      body: 'Typecheck failed',
      severity: 'danger',
    })
  })

  it('keeps successful turn completions for the notification center', () => {
    const event = notificationFromRpcNotification(buildNotification('turn/completed', {
      turn: {
        id: 'turn-9',
        threadId: 'thread-9',
        status: 'completed',
      },
    }))

    expect(event).toMatchObject({
      kind: 'turn-completed',
      title: 'Task completed',
      severity: 'success',
    })
  })

  it('only emits rate-limit notifications for high usage', () => {
    const lowEvent = notificationFromRpcNotification(buildNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 71 },
      },
    }))
    const highEvent = notificationFromRpcNotification(buildNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 91.4 },
      },
    }))

    expect(lowEvent).toBeNull()
    expect(highEvent).toMatchObject({
      kind: 'rate-limit',
      body: 'Codex usage is at 91%.',
      severity: 'warning',
    })
  })

  it('keeps retryable reconnect diagnostics quiet but surfaces an exhausted reconnect', () => {
    expect(notificationFromRpcNotification(buildNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      message: 'Reconnecting... 2/5',
    }))).toBeNull()

    expect(notificationFromRpcNotification(buildNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      message: 'Reconnecting... 5/5',
    }))).toMatchObject({
      kind: 'turn-failed',
      severity: 'danger',
      body: 'Codex 上游响应流恢复失败，未自动重发。Reconnecting... 5/5',
    })
  })
})

describe('notificationFromProductNotification', () => {
  it('maps workflow product events into browser notification center events', () => {
    expect(notificationFromProductNotification(buildProductNotification())).toMatchObject({
      id: 'product:workflow:run-1:ready',
      kind: 'ready-for-review',
      title: 'Workflow ready for review',
      body: 'Feature Build has review agents ready.',
      severity: 'success',
      sourceId: 'workflow:run-1:ready',
    })

    expect(notificationFromProductNotification(buildProductNotification({
      id: 'workflow:run-1:test',
      kind: 'test_failed',
      title: 'Workflow test failed',
      summary: 'npm test -> failed',
      severity: 'danger',
      method: 'tooling/workflows/validation-run',
    }))).toMatchObject({
      kind: 'test-failed',
      title: 'Workflow test failed',
      body: 'npm test -> failed',
      severity: 'danger',
    })
  })
})

describe('shouldSendBrowserNotification', () => {
  const successEvent: BrowserNotificationEvent = {
    id: 'success',
    kind: 'turn-completed',
    title: 'Task completed',
    body: 'Done',
    severity: 'success',
    createdAtIso: '2026-07-05T09:30:00.000Z',
    sourceId: 'success',
  }
  const warningEvent: BrowserNotificationEvent = {
    ...successEvent,
    id: 'warning',
    kind: 'approval',
    title: 'Approval required',
    severity: 'warning',
    sourceId: 'warning',
  }

  it('filters native notifications by preference', () => {
    expect(shouldSendBrowserNotification(warningEvent, 'important')).toBe(true)
    expect(shouldSendBrowserNotification(successEvent, 'important')).toBe(false)
    expect(shouldSendBrowserNotification(successEvent, 'all')).toBe(true)
    expect(shouldSendBrowserNotification(warningEvent, 'off')).toBe(false)
  })
})
