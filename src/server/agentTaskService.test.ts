import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskService } from './agentTaskService'
import { getAgentTask, setAgentTaskFixedThreadId, type AgentTaskInput } from './agentTaskStore'
import { normalizeThreadHistory } from '@codycodeagent/cody-web-core/session'
import type { CodexEvent, CodexEventType } from '@codycodeagent/cody-web-core/conversation'

let tempDir = ''
const previousDb = process.env.CODY_WEB_UI_SETTINGS_DB

function taskInput(permission: AgentTaskInput['permission'] = 'read-only'): AgentTaskInput {
  return {
    name: 'Repository watch', description: '', cwd: tempDir,
    prompt: 'Inspect the repository and report risks.',
    schedule: { kind: 'interval', intervalMinutes: 60 }, timezone: 'UTC', model: 'gpt-test', effort: 'high',
    permission, enabled: true, timeoutMinutes: 30, maxRetries: 1,
    concurrencyPolicy: 'skip', notificationPolicy: 'important', conversationMode: 'new', outputMode: 'conversation', outputPath: '',
    maxTokens: 0, pauseAfterFailures: 3,
  }
}

/** Test-only App Server adapter. Production services receive the shared
 * conversation owner directly; this keeps legacy wire assertions local to
 * the fake server tests. */
function ownerFromRpc(rpc: (method: string, params?: unknown) => Promise<any>) {
  const activeTurnByThread = new Map<string, string>()
  return {
    start: vi.fn(async (context: { thread: unknown }) => {
      const result = await rpc('thread/start', context.thread)
      const threadId = String((result as any)?.thread?.id || '')
      return { threadId }
    }),
    submitUntilStarted: vi.fn(async (intent: any) => {
      const result = await rpc('turn/start', { threadId: intent.threadId, ...intent.input })
      const turnId = String((result as any)?.turn?.id || '')
      activeTurnByThread.set(intent.threadId, turnId)
      return { threadId: intent.threadId, turnId }
    }),
    read: vi.fn(async (threadId: string) => {
      await rpc('thread/resume', { threadId })
      const result = await rpc('thread/read', { threadId, includeTurns: true })
      return (result as any)?.thread ? normalizeThreadHistory(result, threadId) : []
    }),
    interrupt: vi.fn(async (threadId: string) => rpc('turn/interrupt', { threadId, turnId: activeTurnByThread.get(threadId) || '' })),
  }
}

function event(type: CodexEventType, threadId: string, turnId: string, data: Record<string, unknown> = {}): CodexEvent {
  return { id: `${type}:${threadId}:${turnId}`, type, threadId, turnId, atIso: '2026-09-02T00:00:00.000Z', data }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-agent-service-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  if (previousDb === undefined) delete process.env.CODY_WEB_UI_SETTINGS_DB
  else process.env.CODY_WEB_UI_SETTINGS_DB = previousDb
  await rm(tempDir, { recursive: true, force: true })
})

describe('AgentTaskService', () => {
  it('turns common Chinese and English schedule descriptions into editable drafts', () => {
    const service = new AgentTaskService(ownerFromRpc(vi.fn()) as never)
    expect(service.parse('每周一 9点检查项目', 'Asia/Shanghai')).toMatchObject({ schedule: { kind: 'weekly', weekday: 1, time: '09:00' }, confidence: 'high' })
    expect(service.parse('every 2 hours review CI', 'UTC')).toMatchObject({ schedule: { kind: 'interval', intervalMinutes: 120 } })
  })

  it('validates a full import before creating any definitions', async () => {
    const service = new AgentTaskService(ownerFromRpc(vi.fn()) as never)
    await expect(service.importDefinitions({ tasks: [taskInput(), { ...taskInput(), name: '' }] })).rejects.toThrow()
    expect((await service.list()).tasks).toHaveLength(0)
  })

  it('keeps one manual run queued behind an executing run', async () => {
    let sequence = 0
    const rpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: `thread-queue-${String(++sequence)}` } }
      : { turn: { id: `turn-queue-${String(sequence)}` } })
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create({ ...taskInput(), concurrencyPolicy: 'queue' })
    const first = await service.runNow(task.id)
    await vi.waitFor(async () => expect((await service.list()).runs.find((run) => run.id === first.id)?.status).toBe('running'))
    const queued = await service.runNow(task.id)
    expect(queued.status).toBe('queued')
    await expect(service.runNow(task.id)).rejects.toThrow('queued')
    service.onEvent(event('turn.completed', 'thread-queue-1', 'turn-queue-1'))
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('thread/start', expect.anything()))
    await vi.waitFor(() => expect(rpc.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(2))
    service.stop()
  })

  it('hands a replace request from a standby process back to the scheduler through SQLite', async () => {
    let sequence = 0
    const ownerRpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: `thread-owner-${String(++sequence)}` } }
      : method === 'turn/start' ? { turn: { id: `turn-owner-${String(sequence)}` } } : {})
    const standbyRpc = vi.fn(async () => ({}))
    const owner = new AgentTaskService(ownerFromRpc(ownerRpc) as never, { pollIntervalMs: 1_000 })
    const standby = new AgentTaskService(ownerFromRpc(standbyRpc) as never, { pollIntervalMs: 1_000 })
    await owner.start()
    const task = await owner.create({ ...taskInput(), concurrencyPolicy: 'replace' })
    const first = await owner.runNow(task.id)
    await vi.waitFor(async () => expect((await owner.list()).runs.find((run) => run.id === first.id)?.status).toBe('running'))

    const replacement = await standby.runNow(task.id)
    expect(replacement.status).toBe('queued')
    expect(standbyRpc).not.toHaveBeenCalled()
    await vi.waitFor(
      async () => expect((await owner.runs(task.id)).find((run) => run.id === first.id)?.status).toBe('cancelled'),
      { timeout: 2_500 },
    )
    expect(ownerRpc).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-owner-1', turnId: 'turn-owner-1' })
    await vi.waitFor(() => expect(ownerRpc.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(2), { timeout: 2_500 })

    owner.stop()
    standby.stop()
  })

  it('starts an isolated Codex thread and records completion notifications', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'thread-agent-1' } }
      : { turn: { id: 'turn-agent-1' } })
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create(taskInput())
    await service.runNow(task.id)

    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    expect(rpc).toHaveBeenNthCalledWith(1, 'thread/start', { cwd: tempDir, model: 'gpt-test' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'turn/start', expect.objectContaining({
      threadId: 'thread-agent-1',
      effort: 'high',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }))

    service.onEvent(event('assistant.completed', 'thread-agent-1', 'turn-agent-1', { text: 'Everything is healthy.' }))
    service.onEvent(event('thread.context.updated', 'thread-agent-1', 'turn-agent-1', { inputTokens: 100, outputTokens: 20, totalTokens: 120 }))
    service.onEvent(event('turn.completed', 'thread-agent-1', 'turn-agent-1'))

    await vi.waitFor(async () => {
      const result = await service.list()
      expect(result.runs[0]).toMatchObject({ status: 'succeeded', summary: 'Everything is healthy.', totalTokens: 120 })
    })
    service.stop()
  })

  it('resumes a fixed conversation instead of creating a new thread', async () => {
    const rpc = vi.fn(async (method: string) => method === 'turn/start'
      ? { turn: { id: 'turn-reused' } }
      : method === 'thread/resume' ? {} : { thread: { id: 'unexpected-new-thread' } })
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create({ ...taskInput(), conversationMode: 'reuse' })
    await setAgentTaskFixedThreadId(task.id, 'thread-fixed')

    await service.runNow(task.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-fixed' })))

    expect(rpc).toHaveBeenCalledWith('thread/resume', { threadId: 'thread-fixed' })
    expect(rpc).not.toHaveBeenCalledWith('thread/start', expect.anything())
    service.stop()
  })

  it('replaces a fixed conversation when it can no longer be resumed', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'thread/resume') throw new Error('Thread not found')
      if (method === 'thread/start') return { thread: { id: 'thread-replacement' } }
      return { turn: { id: 'turn-replacement' } }
    })
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create({ ...taskInput(), conversationMode: 'reuse' })
    await setAgentTaskFixedThreadId(task.id, 'thread-stale')

    await service.runNow(task.id)
    await vi.waitFor(async () => expect((await getAgentTask(task.id))?.fixedThreadId).toBe('thread-replacement'))

    expect(rpc).toHaveBeenCalledWith('thread/resume', { threadId: 'thread-stale' })
    expect(rpc).toHaveBeenCalledWith('thread/start', { cwd: tempDir, model: 'gpt-test' })
    service.stop()
  })

  it('marks unattended runs as waiting when Codex requests approval', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'thread-agent-2' } }
      : { turn: { id: 'turn-agent-2' } })
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create(taskInput('workspace-write'))
    await service.runNow(task.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    expect(rpc).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [tempDir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    }))

    service.onEvent(event('approval.requested', 'thread-agent-2', 'turn-agent-2'))
    await vi.waitFor(async () => expect((await service.list()).runs[0]?.status).toBe('waiting_approval'))
    service.onEvent(event('approval.resolved', 'thread-agent-2', 'turn-agent-2'))
    await vi.waitFor(async () => expect((await service.list()).runs[0]?.status).toBe('running'))
    service.stop()
  })

  it('interrupts an active run when the user cancels it', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start' ? { thread: { id: 'thread-cancel' } } : method === 'turn/start' ? { turn: { id: 'turn-cancel' } } : {})
    const service = new AgentTaskService(ownerFromRpc(rpc) as never)
    const task = await service.create(taskInput())
    const run = await service.runNow(task.id)
    await vi.waitFor(async () => expect((await service.list()).runs[0]?.status).toBe('running'))
    await service.cancel(task.id, run.id)
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-cancel', turnId: 'turn-cancel' })
    expect((await service.list()).runs[0]).toMatchObject({ status: 'cancelled', error: 'Cancelled by user.' })
    service.stop()
  })

  it('enforces token limits and delivers successful output to a workspace file and notifications', async () => {
    const rpc = vi.fn(async (method: string) => method === 'thread/start' ? { thread: { id: 'thread-output' } } : method === 'turn/start' ? { turn: { id: 'turn-output' } } : {})
    const onEvent = vi.fn()
    const service = new AgentTaskService(ownerFromRpc(rpc) as never, { onEvent })
    const limited = await service.create({ ...taskInput(), name: 'Limited', maxTokens: 100 })
    await service.runNow(limited.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    service.onEvent(event('thread.context.updated', 'thread-output', 'turn-output', { totalTokens: 120 }))
    await vi.waitFor(async () => expect((await service.list()).runs.find((run) => run.taskId === limited.id)?.status).toBe('failed'))
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-output', turnId: 'turn-output' })

    const delivered = await service.create({ ...taskInput(), name: 'Delivered', outputMode: 'file-and-notification', outputPath: 'reports/agent.md', notificationPolicy: 'all' })
    await service.runNow(delivered.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(5))
    service.onEvent(event('assistant.completed', 'thread-output', 'turn-output', { text: 'Ship it.' }))
    service.onEvent(event('turn.completed', 'thread-output', 'turn-output'))
    await vi.waitFor(async () => expect(await readFile(join(tempDir, 'reports/agent.md'), 'utf8')).toContain('Ship it.'))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent task result', summary: 'Ship it.' }))
    service.stop()
  })
})
