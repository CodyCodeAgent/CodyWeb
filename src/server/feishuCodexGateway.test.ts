import { describe, expect, it, vi } from 'vitest'
import { FeishuCodexGateway } from './feishuCodexGateway'
import type { CatalogSnapshot } from './catalogStore'

const catalog: CatalogSnapshot = {
  projects: [{
    projectKey: '/repo', cwd: '/repo', displayName: 'Repository', sortOrder: null, hidden: false, hiddenAtIso: null,
    threads: [{ id: 'thread-1', cwd: '/repo', title: 'Existing session', preview: 'Latest work', createdAtIso: '2026-07-17T00:00:00.000Z', updatedAtIso: '2026-07-18T00:00:00.000Z', sourceArchived: false, hidden: false, hiddenAtIso: null }],
  }],
  visibility: 'visible', generatedAtIso: '2026-07-18T00:00:00.000Z', projectCount: 1, threadCount: 1,
}

function owner(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: unknown) => void>()
  return {
    start: vi.fn(async () => ({ threadId: 'thread-new' })),
    submitUntilStarted: vi.fn(async (intent: { threadId: string }) => ({ threadId: intent.threadId, turnId: 'turn-new' })),
    runEphemeral: vi.fn(async () => ({ assistantText: JSON.stringify({ required_keywords: ['任务 ID'], instruction: '定位根因', reason: '字段稳定' }), terminalEvent: { type: 'turn.completed', data: {} } })),
    read: vi.fn(async () => []),
    interrupt: vi.fn(async () => true),
    listSkills: vi.fn(async () => []),
    listCollaborationModes: vi.fn(async () => []),
    readConfig: vi.fn(async () => ({ config: { model: null, model_reasoning_effort: null, developer_instructions: null } })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    respondQuestion: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: (event: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    ...overrides,
  }
}

describe('FeishuCodexGateway', () => {
  it('maps the Cody catalog to project and session options', async () => {
    const refreshCatalog = vi.fn(async () => undefined)
    const gateway = new FeishuCodexGateway({ owner: owner() as never, readCatalog: vi.fn(async () => catalog), refreshCatalog })
    await expect(gateway.listProjects()).resolves.toEqual([{ id: '/repo', name: 'Repository', cwd: '/repo', sessionCount: 1 }])
    await expect(gateway.listSessions('/repo')).resolves.toEqual([{ id: 'thread-1', title: 'Existing session', preview: 'Latest work', updatedAtIso: '2026-07-18T00:00:00.000Z' }])
    expect(refreshCatalog).toHaveBeenCalledTimes(2)
  })

  it('submits a Feishu turn to the shared owner instead of issuing App Server RPC', async () => {
    const shared = owner()
    const gateway = new FeishuCodexGateway({ owner: shared as never, readCatalog: vi.fn(async () => catalog) })
    await expect(gateway.startSession('/repo')).resolves.toMatchObject({ id: 'thread-new', cwd: '/repo' })
    await expect(gateway.startTurn('thread-new', 'Ship it', ['/private/one.png'], 'default', 'yolo', [{ name: 'alert-triage', path: '/repo/SKILL.md' }]))
      .resolves.toEqual({ threadId: 'thread-new', turnId: 'turn-new' })
    expect(shared.start).toHaveBeenCalledWith({ thread: { cwd: '/repo' } })
    expect(shared.submitUntilStarted).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-new', mode: 'queue', input: expect.objectContaining({
        approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
        input: [{ type: 'skill', name: 'alert-triage', path: '/repo/SKILL.md' }, { type: 'text', text: 'Ship it', text_elements: [] }, { type: 'localImage', path: '/private/one.png' }],
      }),
    }))
  })

  it('uses the owner terminal outcome for structured card routing', async () => {
    const shared = owner()
    const gateway = new FeishuCodexGateway({ owner: shared as never, readCatalog: vi.fn(async () => catalog) })
    await expect(gateway.analyzeAutoRoute({ cwd: '/repo', cardTitle: '差异播报', cardText: '任务 ID：T1', candidateKeywords: ['任务 ID'], requestedInstruction: '排查根因' }))
      .resolves.toEqual({ requiredKeywords: ['任务 ID'], instruction: '定位根因', reason: '字段稳定' })
    expect(shared.runEphemeral).toHaveBeenCalledWith(expect.objectContaining({ thread: expect.objectContaining({ cwd: '/repo', ephemeral: true }) }), expect.objectContaining({ outputSchema: expect.any(Object) }), expect.stringMatching(/^feishu-analysis:/), undefined)
  })

  it('routes approval and question replies through the thread-bound owner request', async () => {
    const shared = owner()
    let listener: ((event: any) => void) | undefined
    shared.subscribe.mockImplementation((value: (event: any) => void) => { listener = value; return () => undefined })
    const gateway = new FeishuCodexGateway({ owner: shared as never, readCatalog: vi.fn(async () => catalog) })
    listener?.({ type: 'approval.requested', threadId: 'thread-1', data: { requestId: '42' } })
    listener?.({ type: 'question.requested', threadId: 'thread-1', data: { requestId: '7' } })
    await gateway.resolveApproval(42, 'acceptForSession')
    await gateway.resolveUserInput(7, { strategy: ['Safe'] })
    expect(shared.respondApproval).toHaveBeenCalledWith('thread-1', { thread: {} }, '42', 'acceptForSession')
    expect(shared.respondQuestion).toHaveBeenCalledWith('thread-1', { thread: {} }, '7', { answers: { strategy: { answers: ['Safe'] } } })
  })
})
