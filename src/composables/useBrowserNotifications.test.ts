import { describe, expect, it } from 'vitest'
import {
  notificationFromProductNotification,
  notificationFromConversationEvent,
  shouldSendBrowserNotification,
  type BrowserNotificationEvent,
} from './useBrowserNotifications'
import type { ProductNotification } from '../api/codexRealtimeClient'

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

describe('notificationFromConversationEvent', () => {
  it('maps Core approval events to approval notifications', () => {
    const event = notificationFromConversationEvent({
      id: 'request-12', type: 'approval.requested', threadId: 'thread-1', turnId: 'turn-1',
      atIso: '2026-07-05T09:30:00.000Z', data: { method: 'item/commandExecution/requestApproval' },
    })

    expect(event).toMatchObject({
      kind: 'approval',
      title: 'Approval required',
      severity: 'warning',
    })
    expect(event?.body).toContain('item/commandExecution/requestApproval')
    expect(event?.sourceId).toBe('request-12')
  })

  it('maps terminal Core events without reparsing raw protocol', () => {
    const event = notificationFromConversationEvent({
      id: 'failed-7', type: 'turn.failed', threadId: 'thread-7', turnId: 'turn-7',
      atIso: '2026-07-05T09:30:00.000Z', data: { error: 'Typecheck failed' },
    })

    expect(event).toMatchObject({
      kind: 'turn-failed',
      title: 'Task failed',
      body: 'Typecheck failed',
      severity: 'danger',
    })
  })

  it('keeps successful Core turn completions for the notification center', () => {
    const event = notificationFromConversationEvent({
      id: 'done-9', type: 'turn.completed', threadId: 'thread-9', turnId: 'turn-9',
      atIso: '2026-07-05T09:30:00.000Z', data: {},
    })

    expect(event).toMatchObject({
      kind: 'turn-completed',
      title: 'Task completed',
      severity: 'success',
    })
  })

  it('keeps unrelated Core diagnostics out of the product notification center', () => {
    expect(notificationFromConversationEvent({
      id: 'activity-1', type: 'turn.activity', threadId: 'thread-1', turnId: 'turn-1',
      atIso: '2026-07-05T09:30:00.000Z', data: { label: 'Reconnecting... 2/5' },
    })).toBeNull()
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
