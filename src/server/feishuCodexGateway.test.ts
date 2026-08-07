import { describe, expect, it, vi } from 'vitest'
import { FeishuCodexGateway } from './feishuCodexGateway'
import type { CatalogSnapshot } from './catalogStore'

const catalog: CatalogSnapshot = {
  projects: [{
    projectKey: '/repo', cwd: '/repo', displayName: 'Repository', sortOrder: null,
    hidden: false, hiddenAtIso: null,
    threads: [{
      id: 'thread-1', cwd: '/repo', title: 'Existing session', preview: 'Latest work',
      createdAtIso: '2026-07-17T00:00:00.000Z', updatedAtIso: '2026-07-18T00:00:00.000Z',
      sourceArchived: false, hidden: false, hiddenAtIso: null,
    }],
  }],
  visibility: 'visible', generatedAtIso: '2026-07-18T00:00:00.000Z', projectCount: 1, threadCount: 1,
}

describe('FeishuCodexGateway', () => {
  it('maps the Cody catalog to project and session options', async () => {
    const refreshCatalog = vi.fn(async () => undefined)
    const gateway = new FeishuCodexGateway({
      rpc: vi.fn(), respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog), refreshCatalog,
    })
    await expect(gateway.listProjects()).resolves.toEqual([{ id: '/repo', name: 'Repository', cwd: '/repo', sessionCount: 1 }])
    await expect(gateway.listSessions('/repo')).resolves.toEqual([{
      id: 'thread-1', title: 'Existing session', preview: 'Latest work', updatedAtIso: '2026-07-18T00:00:00.000Z',
    }])
    expect(refreshCatalog).toHaveBeenCalledTimes(2)
  })

  it('starts a session and sends the first turn through app-server', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new' } }
      if (method === 'turn/start') return { turn: { id: 'turn-new' } }
      return {}
    })
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })
    await expect(gateway.startSession('/repo')).resolves.toMatchObject({ id: 'thread-new', cwd: '/repo' })
    await expect(gateway.isThreadBusy('thread-new')).resolves.toBe(false)
    await expect(gateway.findActiveTurnId('thread-new')).resolves.toBeNull()
    await expect(gateway.startTurn('thread-new', 'Ship it', ['/private/one.png', '  ', '/private/two.jpg'])).resolves.toEqual({ threadId: 'thread-new', turnId: 'turn-new' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-new', input: [
        { type: 'text', text: 'Ship it', text_elements: [] },
        { type: 'localImage', path: '/private/one.png' },
        { type: 'localImage', path: '/private/two.jpg' },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
    expect(rpc).not.toHaveBeenCalledWith('thread/resume', expect.anything())
  })

  it('resumes a materialized session before starting another turn', async () => {
    const rpc = vi.fn(async (method: string) => method === 'turn/start' ? { turn: { id: 'turn-next' } } : {})
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })

    await expect(gateway.startTurn('thread-1', 'Continue')).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-next' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread/resume', { threadId: 'thread-1' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'Continue', text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('restores Codex approval and sandbox defaults in Normal mode', async () => {
    const rpc = vi.fn(async (method: string) => method === 'turn/start' ? { turn: { id: 'turn-normal' } } : {})
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })

    await expect(gateway.startTurn('thread-1', 'Proceed carefully', [], 'default', 'normal')).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-normal' })
    expect(rpc).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'Proceed carefully', text_elements: [] }],
    })
  })

  it('starts Plan turns with the live collaboration preset and model configuration', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'collaborationMode/list') return { data: [{ name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' }] }
      if (method === 'config/read') return { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'high' } }
      if (method === 'turn/start') return { turn: { id: 'turn-plan' } }
      return {}
    })
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })

    await expect(gateway.startTurn('thread-1', 'Ask before deciding', [], 'plan')).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-plan' })
    expect(rpc).toHaveBeenCalledWith('collaborationMode/list', {})
    expect(rpc).toHaveBeenCalledWith('config/read', {})
    expect(rpc).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Ask before deciding', text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    })
  })

  it('resolves approvals through the existing server-request channel', async () => {
    const respondToServerRequest = vi.fn(async () => undefined)
    const gateway = new FeishuCodexGateway({ rpc: vi.fn(), respondToServerRequest, readCatalog: vi.fn(async () => catalog) })
    await gateway.resolveApproval(42, 'acceptForSession')
    expect(respondToServerRequest).toHaveBeenCalledWith({
      id: 42, approvalScope: 'session', result: { decision: 'acceptForSession' },
    })
  })

  it('maps user-input answers to the app-server response schema', async () => {
    const respondToServerRequest = vi.fn(async () => undefined)
    const gateway = new FeishuCodexGateway({ rpc: vi.fn(), respondToServerRequest, readCatalog: vi.fn(async () => catalog) })
    await gateway.resolveUserInput(7, { strategy: ['Safe'], note: ['Keep tests'] })
    expect(respondToServerRequest).toHaveBeenCalledWith({
      id: 7,
      result: { answers: { strategy: { answers: ['Safe'] }, note: { answers: ['Keep tests'] } } },
    })
  })

  it('renames and archives sessions through app-server', async () => {
    const rpc = vi.fn(async () => ({}))
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })
    await gateway.renameSession(' thread-1 ', ' Shared session ')
    await gateway.archiveSession(' thread-1 ')
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread/name/set', { threadId: 'thread-1', name: 'Shared session' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'thread/archive', { threadId: 'thread-1' })
  })

  it('finds the active turn so another CodyWeb client can stop it', async () => {
    const rpc = vi.fn(async () => ({
      thread: { turns: [
        { id: 'turn-done', status: 'completed' },
        { id: 'turn-stale', status: 'inProgress' },
        { id: 'turn-live', status: 'inProgress' },
      ] },
    }))
    const gateway = new FeishuCodexGateway({ rpc, respondToServerRequest: vi.fn(), readCatalog: vi.fn(async () => catalog) })
    await expect(gateway.findActiveTurnId(' thread-1 ')).resolves.toBe('turn-live')
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-1', includeTurns: true })
  })
})
