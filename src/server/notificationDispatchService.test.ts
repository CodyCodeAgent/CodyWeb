import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationDispatcher,
  notificationDispatchEventFromCodex,
} from './notificationDispatchService'

const tempDirs: string[] = []

async function createWorkspace(config: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-notifications-'))
  tempDirs.push(dir)
  await writeFile(join(dir, '.cody-web-ui.yml'), config, 'utf8')
  return dir
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })))
})

describe('notificationDispatchEventFromCodex', () => {
  it('maps task lifecycle and approval notifications to product events', () => {
    expect(notificationDispatchEventFromCodex({
      method: 'turn/started',
      params: { turn: { id: 'turn-1', threadId: 'thread-1' } },
      atIso: '2026-07-05T10:00:00.000Z',
    })).toMatchObject({
      kind: 'task_started',
      title: 'Task started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })

    expect(notificationDispatchEventFromCodex({
      method: 'server/request',
      params: {
        request: {
          method: 'item/commandExecution/requestApproval',
          threadId: 'thread-2',
        },
      },
      atIso: '2026-07-05T10:01:00.000Z',
    })).toMatchObject({
      kind: 'approval_required',
      severity: 'warning',
      summary: 'item/commandExecution/requestApproval is waiting for approval.',
    })

    expect(notificationDispatchEventFromCodex({
      method: 'turn/completed',
      params: { threadId: 'thread-3', turn: { id: 'turn-3', status: 'failed', error: { message: 'Tests failed' } } },
      atIso: '2026-07-05T10:02:00.000Z',
    })).toMatchObject({
      kind: 'task_failed',
      severity: 'danger',
      summary: 'Tests failed',
    })
  })
})

describe('NotificationDispatcher', () => {
  it('posts generic webhook payloads for configured event kinds', async () => {
    const workspace = await createWorkspace(`
notifications:
  enabled: true
  events:
    - approval_required
  channels:
    - name: approvals
      type: webhook
      url: http://127.0.0.1:9999/hook
`)
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const dispatcher = new NotificationDispatcher({
      workspaceCwd: workspace,
      fetchImpl,
      now: () => new Date('2026-07-05T10:00:00.000Z'),
    })
    await dispatcher.handleCodexNotification({
      method: 'server/request',
      params: {
        request: {
          method: 'item/fileChange/requestApproval',
          threadId: 'thread-7',
        },
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:9999/hook')
    expect(calls[0].body).toMatchObject({
      source: 'cody-web-ui',
      version: 1,
      event: {
        kind: 'approval_required',
        threadId: 'thread-7',
        title: 'Approval required',
      },
    })
  })

  it('formats Slack and Lark bodies without dispatching filtered events', async () => {
    const workspace = await createWorkspace(`
notifications:
  enabled: true
  channels:
    - name: slack
      type: slack
      url: http://127.0.0.1:9999/slack
      events:
        - task_failed
    - name: lark
      type: lark
      url: http://127.0.0.1:9999/lark
      events:
        - task_failed
`)
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const dispatcher = new NotificationDispatcher({
      workspaceCwd: workspace,
      fetchImpl,
    })
    await dispatcher.handleCodexNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      atIso: '2026-07-05T10:00:00.000Z',
    })
    await dispatcher.handleCodexNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'failed', error: { message: 'Build failed' } } },
      atIso: '2026-07-05T10:01:00.000Z',
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({
      text: '[DANGER] Task failed: Build failed',
      blocks: expect.any(Array),
    })
    expect(bodies[1]).toEqual({
      msg_type: 'text',
      content: {
        text: '[DANGER] Task failed: Build failed',
      },
    })
  })

  it('returns delivery evidence for user-triggered channel tests', async () => {
    const workspace = await createWorkspace(`
notifications:
  enabled: true
  channels:
    - name: smoke
      type: webhook
      url: http://127.0.0.1:9999/smoke
`)
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const dispatcher = new NotificationDispatcher({
      workspaceCwd: workspace,
      fetchImpl,
      now: () => new Date('2026-07-05T10:10:00.000Z'),
    })
    const report = await dispatcher.dispatchTestNotification()

    expect(report).toMatchObject({
      enabled: true,
      attemptedCount: 1,
      sentCount: 1,
      failedCount: 0,
      results: [
        expect.objectContaining({
          channelName: 'smoke',
          channelType: 'webhook',
          status: 'sent',
          httpStatus: 200,
        }),
      ],
    })
    expect(bodies[0]).toMatchObject({
      source: 'cody-web-ui',
      event: {
        kind: 'ready_for_review',
        method: 'tooling/notifications/test',
      },
    })
  })

  it('dispatches product workflow events through configured channels', async () => {
    const workspace = await createWorkspace(`
notifications:
  enabled: true
  events:
    - ready_for_review
  channels:
    - name: workflow
      type: webhook
      url: http://127.0.0.1:9999/workflow
      events:
        - ready_for_review
`)
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const dispatcher = new NotificationDispatcher({
      workspaceCwd: workspace,
      fetchImpl,
      now: () => new Date('2026-07-05T10:20:00.000Z'),
    })
    const report = await dispatcher.dispatchProductEvent({
      kind: 'ready_for_review',
      title: 'Workflow ready for review',
      summary: 'Feature Build has review agents ready.',
      severity: 'success',
      method: 'tooling/workflows/agent-status',
      id: 'workflow-ready:test-run',
    })

    expect(report).toMatchObject({
      enabled: true,
      attemptedCount: 1,
      sentCount: 1,
      failedCount: 0,
      event: {
        id: 'workflow-ready:test-run',
        kind: 'ready_for_review',
        method: 'tooling/workflows/agent-status',
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:9999/workflow',
      body: {
        source: 'cody-web-ui',
        version: 1,
        event: {
          kind: 'ready_for_review',
          title: 'Workflow ready for review',
          summary: 'Feature Build has review agents ready.',
        },
      },
    })
  })

  it('does not send test notifications when workspace notifications are disabled', async () => {
    const workspace = await createWorkspace(`
notifications:
  enabled: false
  channels:
    - name: disabled
      type: webhook
      url: http://127.0.0.1:9999/disabled
`)
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    const dispatcher = new NotificationDispatcher({
      workspaceCwd: workspace,
      fetchImpl,
    })

    const report = await dispatcher.dispatchTestNotification()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(report).toMatchObject({
      enabled: false,
      attemptedCount: 0,
      sentCount: 0,
      warnings: ['Notifications are disabled in .cody-web-ui.yml.'],
    })
  })
})
