import { appendFile, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import {
  appendAgentTaskRunEvent,
  acquireAgentTaskSchedulerLease,
  claimAgentTask,
  claimQueuedAgentTask,
  completeAgentTaskRun,
  createAgentTask,
  createAgentTaskBatch,
  deleteAgentTask,
  permanentlyDeleteAgentTask,
  getActiveAgentTaskRun,
  enqueueManualAgentTask,
  getAgentTask,
  listActiveAgentTaskRuns,
  recoverQueuedAgentTaskRuns,
  releaseAgentTaskSchedulerLease,
  listAgentTaskRuns,
  listLatestAgentTaskRuns,
  listQueuedAgentTaskIds,
  listAgentTaskRunEvents,
  listAgentTasks,
  listAgentTaskVersions,
  listDueAgentTaskIds,
  markAgentTaskRunStarted,
  setAgentTaskEnabled,
  rollbackAgentTask,
  restoreAgentTask,
  setAgentTaskFixedThreadId,
  setAgentTaskRunDeliveryPending,
  updateAgentTask,
  updateAgentTaskRunState,
  updateAgentTaskRunUsage,
  updateAgentTaskRunDelivery,
  validateAgentTaskInput,
  type AgentTask,
  type AgentTaskInput,
  type AgentTaskRun,
  type AgentTaskRunEvent,
  type AgentTaskVersion,
} from './agentTaskStore.js'
import { parseAgentTaskInstruction, type AgentTaskDraft } from './agentTaskNaturalLanguage.js'
import { listCatalog } from './catalogStore.js'
import { latestAssistantTextFromEvents, latestTerminalTurnEvent, type CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { type ExecutionContext, type TurnInput } from '@codycodeagent/cody-web-core/session'
import type { CodyWebConversationOwner } from './conversationOwner.js'

type AgentTaskOwner = Pick<CodyWebConversationOwner, 'start' | 'submitUntilStarted' | 'read' | 'interrupt'>

type AgentTaskServiceOptions = {
  pollIntervalMs?: number
  now?: () => Date
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  onEvent?: (event: { task: AgentTask; run: AgentTaskRun; title: string; summary: string; severity: 'info' | 'success' | 'warning' | 'danger' }) => void | Promise<void>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function usageFromEvents(events: readonly CodexEvent[]): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  let event: CodexEvent | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'thread.context.updated') { event = events[index]; break }
  }
  if (!event) return null
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  const inputTokens = number(event.data.inputTokens)
  const outputTokens = number(event.data.outputTokens)
  return { inputTokens, outputTokens, totalTokens: number(event.data.totalTokens ?? event.data.usedTokens) || inputTokens + outputTokens }
}

export class AgentTaskService {
  private readonly owner: AgentTaskOwner
  private readonly pollIntervalMs: number
  private readonly now: () => Date
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly eventSink?: AgentTaskServiceOptions['onEvent']
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private stopped = true
  private readonly activeRunsByTurn = new Map<string, AgentTaskRun>()
  private readonly activeRunsByThread = new Map<string, AgentTaskRun>()
  private readonly waitingApprovalRunIds = new Set<string>()
  private readonly finishedRunIds = new Set<string>()
  private readonly timeoutByRun = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly ownerId = randomUUID()
  private schedulerOwned = false
  private recovered = false

  constructor(owner: AgentTaskOwner, options: AgentTaskServiceOptions = {}) {
    this.owner = owner
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 10_000)
    this.now = options.now ?? (() => new Date())
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.eventSink = options.onEvent
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    if (!await this.ensureSchedulerOwnership()) {
      this.schedulePoll()
      return
    }
    await this.recoverActiveRuns()
    await this.tick()
  }

  private async recoverActiveRuns(): Promise<void> {
    if (this.recovered) return
    this.recovered = true
    const activeRuns = await listActiveAgentTaskRuns()
    for (const run of activeRuns) {
      if (run.turnId) {
        this.activeRunsByTurn.set(run.turnId, run)
        if (run.threadId) this.activeRunsByThread.set(run.threadId, run)
        const task = await getAgentTask(run.taskId)
        if (task) await this.recoverRun(task, run)
      }
    }
    const queuedTaskIds = await recoverQueuedAgentTaskRuns()
    for (const taskId of queuedTaskIds) await this.launchNextQueued(taskId)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    for (const timeout of this.timeoutByRun.values()) this.clearTimer(timeout)
    this.timeoutByRun.clear()
    this.activeRunsByTurn.clear()
    this.activeRunsByThread.clear()
    this.waitingApprovalRunIds.clear()
    this.finishedRunIds.clear()
    this.schedulerOwned = false
    this.recovered = false
    void releaseAgentTaskSchedulerLease(this.ownerId)
  }

  async list(visibility: 'active' | 'archived' = 'active'): Promise<{ tasks: AgentTask[]; runs: AgentTaskRun[] }> {
    const [tasks, latest, active] = await Promise.all([listAgentTasks(visibility), listLatestAgentTaskRuns(), listActiveAgentTaskRuns()])
    const taskIds = new Set(tasks.map((task) => task.id))
    const runs = [...active, ...latest.filter((run) => !active.some((activeRun) => activeRun.id === run.id))]
      .filter((run) => taskIds.has(run.taskId))
    return { tasks, runs }
  }

  async create(input: AgentTaskInput): Promise<AgentTask> {
    await this.assertWorkspace(input.cwd)
    const task = await createAgentTask(input, this.now())
    this.schedulePoll(0)
    return task
  }

  async update(id: string, input: AgentTaskInput): Promise<AgentTask> {
    await this.assertWorkspace(input.cwd)
    const task = await updateAgentTask(id, input, this.now())
    this.schedulePoll(0)
    return task
  }

  async remove(id: string): Promise<void> { await deleteAgentTask(id) }

  async restore(id: string): Promise<AgentTask> { return restoreAgentTask(id, this.now()) }

  async permanentlyDelete(id: string): Promise<void> { await permanentlyDeleteAgentTask(id) }

  parse(instruction: string, timezone?: string): AgentTaskDraft {
    return parseAgentTaskInstruction(instruction, timezone, this.now())
  }

  async duplicate(id: string): Promise<AgentTask> {
    const source = await getAgentTask(id)
    if (!source) throw new Error('Agent task not found')
    const { id: _id, version: _version, nextRunAtIso: _next, lastRunAtIso: _last, consecutiveFailures: _failures,
      archivedAtIso: _archived, fixedThreadId: _fixedThreadId,
      createdAtIso: _created, updatedAtIso: _updated, ...input } = source
    return this.create({ ...input, name: `${source.name} copy`, enabled: false })
  }

  async versions(id: string): Promise<AgentTaskVersion[]> { return listAgentTaskVersions(id) }

  async rollback(id: string, version: number): Promise<AgentTask> {
    const task = await rollbackAgentTask(id, version, this.now())
    this.schedulePoll(0)
    return task
  }

  async exportDefinitions(ids?: string[]): Promise<{ version: 1; exportedAtIso: string; tasks: AgentTaskInput[] }> {
    const selected = (await listAgentTasks()).filter((task) => !ids?.length || ids.includes(task.id))
    return {
      version: 1,
      exportedAtIso: this.now().toISOString(),
      tasks: selected.map(({ id: _id, version: _version, nextRunAtIso: _next, lastRunAtIso: _last,
        consecutiveFailures: _failures, archivedAtIso: _archived, fixedThreadId: _fixedThreadId,
        createdAtIso: _created, updatedAtIso: _updated, ...input }) => input),
    }
  }

  async importDefinitions(value: unknown): Promise<AgentTask[]> {
    const row = record(value)
    const definitions = Array.isArray(row?.tasks) ? row.tasks : Array.isArray(value) ? value : []
    if (definitions.length === 0 || definitions.length > 100) throw new Error('Import must contain between 1 and 100 tasks')
    const inputs = definitions.map((definition) => record(definition) as AgentTaskInput)
    for (const input of inputs) await this.assertWorkspace(input?.cwd ?? '')
    // Validate every definition before writing the first row. This keeps a bad
    // import from leaving a partially-created batch behind.
    for (const input of inputs) validateAgentTaskInput(input)
    const created = await createAgentTaskBatch(inputs, this.now())
    this.schedulePoll(0)
    return created
  }

  async setEnabled(id: string, enabled: boolean): Promise<AgentTask> {
    const task = await setAgentTaskEnabled(id, enabled, this.now())
    this.schedulePoll(0)
    return task
  }

  async runNow(id: string): Promise<AgentTaskRun> {
    const task = await getAgentTask(id)
    if (!task) throw new Error('Agent task not found')
    if (!await this.ensureSchedulerOwnership()) return enqueueManualAgentTask(id, this.now())
    const active = await getActiveAgentTaskRun(id)
    if (active && task.concurrencyPolicy === 'replace') await this.cancel(id, active.id, 'Replaced by a newer run.')
    else if (active && task.concurrencyPolicy === 'queue') return enqueueManualAgentTask(id, this.now())
    else if (active) throw new Error('Agent task is already running')
    const claimed = await claimAgentTask(id, 'manual', this.now())
    if (!claimed) {
      if (task.concurrencyPolicy === 'queue') return enqueueManualAgentTask(id, this.now())
      throw new Error('Agent task is already running')
    }
    void this.launch(claimed.task, claimed.run)
    return claimed.run
  }

  async runs(taskId: string, limit = 50): Promise<AgentTaskRun[]> {
    return listAgentTaskRuns(taskId, limit)
  }

  async runEvents(runId: string): Promise<AgentTaskRunEvent[]> { return listAgentTaskRunEvents(runId) }

  async cancel(taskId: string, runId?: string, reason = 'Cancelled by user.'): Promise<AgentTaskRun> {
    const active = await getActiveAgentTaskRun(taskId)
    if (!active || (runId && active.id !== runId)) throw new Error('No active run found for this task')
    if (active.threadId && active.turnId) {
      await this.owner.interrupt(active.threadId, this.threadContext()).catch(() => undefined)
    }
    await this.finish(active, { status: 'cancelled', error: reason })
    return { ...active, status: 'cancelled', error: reason, completedAtIso: this.now().toISOString() }
  }

  onEvent(event: CodexEvent): void {
    const { turnId, threadId } = event
    const run = (turnId && this.activeRunsByTurn.get(turnId)) || (threadId && this.activeRunsByThread.get(threadId))
    if (!run) return
    if (threadId && !run.threadId) run.threadId = threadId
    if (turnId && !run.turnId) {
      run.turnId = turnId
      this.activeRunsByTurn.set(turnId, run)
    }
    if (event.type === 'approval.requested' || event.type === 'question.requested') {
      this.waitingApprovalRunIds.add(run.id)
      void updateAgentTaskRunState(run.id, 'waiting_approval')
      void this.emitForRun(run, 'Approval required', 'This Agent task is waiting for approval.', 'warning')
      return
    }
    if (event.type === 'approval.resolved' || event.type === 'question.resolved') {
      this.waitingApprovalRunIds.delete(run.id)
      void updateAgentTaskRunState(run.id, 'running')
      return
    }
    const summary = latestAssistantTextFromEvents([event])
    if (summary) {
      run.summary = summary
      void updateAgentTaskRunState(run.id, 'running', summary)
    }
    const usage = usageFromEvents([event])
    if (usage?.totalTokens) {
      Object.assign(run, usage)
      void updateAgentTaskRunUsage(run.id, usage)
      void this.enforceTokenLimit(run, usage.totalTokens)
    }
    const terminal = latestTerminalTurnEvent([event])
    if (!terminal) return
    const error = terminal.type === 'turn.failed' ? readString(terminal.data.error) || 'Codex turn failed' : ''
    void this.finish(run, {
      status: terminal.type === 'turn.interrupted' ? 'cancelled' : terminal.type === 'turn.failed' ? 'failed' : 'succeeded',
      error,
      summary: summary || run.summary,
      inputTokens: usage?.inputTokens || run.inputTokens,
      outputTokens: usage?.outputTokens || run.outputTokens,
      totalTokens: usage?.totalTokens || run.totalTokens,
    })
  }

  ownsEvent(event: CodexEvent): boolean {
    const { turnId, threadId } = event
    return Boolean((turnId && this.activeRunsByTurn.has(turnId)) || (threadId && this.activeRunsByThread.has(threadId)))
  }

  private async assertWorkspace(cwd: string): Promise<void> {
    const path = cwd.trim()
    if (!path) throw new Error('Workspace is required')
    const details = await stat(path).catch(() => null)
    if (!details?.isDirectory()) throw new Error('Workspace directory does not exist')
    const catalog = await listCatalog('visible')
    if (catalog.projects.length > 0) {
      const requested = await realpath(path)
      const allowed = await Promise.all(catalog.projects.map((project) => realpath(project.cwd).catch(() => '')))
      if (!allowed.includes(requested)) throw new Error('Workspace must be a visible project from the CodyWeb catalog')
    }
  }

  private schedulePoll(delayMs = this.pollIntervalMs): void {
    if (this.stopped) return
    if (this.timer) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.tick()
    }, Math.max(0, delayMs))
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      if (!await this.ensureSchedulerOwnership()) return
      await this.recoverActiveRuns()
      for (const taskId of await listQueuedAgentTaskIds()) {
        const task = await getAgentTask(taskId)
        const active = task?.concurrencyPolicy === 'replace' ? await getActiveAgentTaskRun(taskId) : null
        if (active) {
          await this.cancel(taskId, active.id, 'Replaced by a newer run.')
          continue
        }
        await this.launchNextQueued(taskId)
      }
      const ids = await listDueAgentTaskIds(this.now())
      for (const id of ids) {
        const task = await getAgentTask(id)
        if (task?.concurrencyPolicy === 'replace') {
          const active = await getActiveAgentTaskRun(id)
          if (active) await this.cancel(id, active.id, 'Replaced by the next scheduled run.')
        }
        const trigger = task && task.consecutiveFailures > 0 ? 'retry' : 'schedule'
        const claimed = await claimAgentTask(id, trigger, this.now())
        if (claimed) void this.launch(claimed.task, claimed.run)
      }
    } catch (error) {
      console.warn(`Agent task scheduler failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.ticking = false
      this.schedulePoll()
    }
  }

  private async ensureSchedulerOwnership(): Promise<boolean> {
    const owned = await acquireAgentTaskSchedulerLease(this.ownerId, this.now(), Math.max(30_000, this.pollIntervalMs * 3))
    this.schedulerOwned = owned
    if (!owned) this.recovered = false
    return owned
  }

  private async launch(task: AgentTask, run: AgentTaskRun): Promise<void> {
    try {
      await this.assertWorkspace(task.cwd)
      const threadId = await this.prepareThread(task, run)
      run.threadId = threadId
      this.activeRunsByThread.set(threadId, run)
      const handle = await this.owner.submitUntilStarted({
        threadId,
        clientCommandId: `agent-task:${run.id}`,
        mode: 'queue',
        context: this.threadContext(task),
        input: {
        input: [{ type: 'text', text: task.prompt, text_elements: [] }],
        approvalPolicy: 'on-request',
        sandboxPolicy: task.permission === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [task.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
        ...(task.model ? { model: task.model } : {}),
        ...(task.effort ? { effort: task.effort } : {}),
        },
      })
      const turnId = handle.turnId
      if (task.conversationMode === 'reuse' && task.fixedThreadId !== threadId) {
        try {
          await setAgentTaskFixedThreadId(task.id, threadId)
        } catch (error) {
          await appendAgentTaskRunEvent(run.id, 'progress', `Fixed conversation id could not be saved. ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (this.finishedRunIds.has(run.id)) return
      if (!await markAgentTaskRunStarted(run.id, threadId, turnId, this.now())) {
        this.activeRunsByThread.delete(threadId)
        await this.owner.interrupt(threadId, this.threadContext(task)).catch(() => undefined)
        return
      }
      run.status = 'running'
      run.startedAtIso = this.now().toISOString()
      run.threadId = threadId
      run.turnId = turnId
      this.activeRunsByTurn.set(turnId, run)
      if (this.waitingApprovalRunIds.has(run.id)) await updateAgentTaskRunState(run.id, 'waiting_approval')
      this.armTimeout(task, run)
      await this.emit(task, run, 'Agent task started', `${task.name} started.`, 'info', task.notificationPolicy === 'all')
    } catch (error) {
      await this.finish(run, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async prepareThread(task: AgentTask, run: AgentTaskRun): Promise<string> {
    if (task.conversationMode === 'reuse' && task.fixedThreadId) {
      try {
        await this.owner.read(task.fixedThreadId, this.threadContext(task))
        return task.fixedThreadId
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await appendAgentTaskRunEvent(run.id, 'progress', `Fixed conversation could not be resumed; creating a replacement. ${message}`)
      }
    }
    return (await this.owner.start({ thread: { cwd: task.cwd, ...(task.model ? { model: task.model } : {}) } })).threadId
  }

  private async recoverRun(task: AgentTask, run: AgentTaskRun): Promise<void> {
    try {
      const events = (await this.owner.read(run.threadId, this.threadContext(task))).filter((event) => event.turnId === run.turnId)
      const terminal = latestTerminalTurnEvent(events)
      if (terminal) {
        const error = terminal.type === 'turn.failed' ? readString(terminal.data.error) || 'Codex turn failed' : ''
        await this.finish(run, {
          status: terminal.type === 'turn.interrupted' ? 'cancelled' : terminal.type === 'turn.failed' ? 'failed' : 'succeeded',
          error,
          summary: latestAssistantTextFromEvents(events) || run.summary,
        })
        return
      }
    } catch (error) {
      console.warn(`Agent task recovery check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.armTimeout(task, run)
  }

  private armTimeout(task: AgentTask, run: AgentTaskRun): void {
    const startedAtMs = run.startedAtIso ? Date.parse(run.startedAtIso) : this.now().getTime()
    const remainingMs = Math.max(1_000, startedAtMs + task.timeoutMinutes * 60_000 - this.now().getTime())
    const timer = this.setTimer(() => {
      this.timeoutByRun.delete(run.id)
      void this.owner.interrupt(run.threadId, this.threadContext(task)).catch(() => undefined)
      void this.finish(run, { status: 'timed_out', error: `Agent task exceeded ${String(task.timeoutMinutes)} minutes.` })
    }, remainingMs)
    timer.unref?.()
    this.timeoutByRun.set(run.id, timer)
  }

  private async finish(run: AgentTaskRun, result: Parameters<typeof completeAgentTaskRun>[1]): Promise<void> {
    if (this.finishedRunIds.has(run.id)) return
    this.finishedRunIds.add(run.id)
    this.waitingApprovalRunIds.delete(run.id)
    if (run.turnId) this.activeRunsByTurn.delete(run.turnId)
    if (run.threadId) this.activeRunsByThread.delete(run.threadId)
    const timer = this.timeoutByRun.get(run.id)
    if (timer) this.clearTimer(timer)
    this.timeoutByRun.delete(run.id)
    const completed = await completeAgentTaskRun(run.id, result, this.now())
    if (!completed) {
      this.finishedRunIds.delete(run.id)
      return
    }
    const task = await getAgentTask(run.taskId)
    if (task) {
      if (result.status === 'succeeded') await this.deliver(task, run, result.summary || run.summary)
      const important = result.status !== 'succeeded'
      const autoPaused = important && result.status !== 'cancelled' && !task.enabled && task.consecutiveFailures >= task.pauseAfterFailures
      await this.emit(task, run,
        result.status === 'succeeded' ? 'Agent task completed' : result.status === 'cancelled' ? 'Agent task cancelled' : autoPaused ? 'Agent task auto-paused' : 'Agent task failed',
        autoPaused ? `${result.error || 'Repeated failures'} The schedule was paused after ${String(task.consecutiveFailures)} consecutive failures.` : result.error || result.summary || `${task.name}: ${result.status}`,
        result.status === 'succeeded' ? 'success' : result.status === 'cancelled' ? 'warning' : 'danger',
        task.notificationPolicy === 'all' || (task.notificationPolicy === 'important' && important))
    }
    this.finishedRunIds.delete(run.id)
    await this.launchNextQueued(run.taskId)
    this.schedulePoll(0)
  }

  private async launchNextQueued(taskId: string): Promise<void> {
    const claimed = await claimQueuedAgentTask(taskId, this.now())
    if (claimed) void this.launch(claimed.task, claimed.run)
  }

  private async enforceTokenLimit(run: AgentTaskRun, totalTokens: number): Promise<void> {
    if (this.finishedRunIds.has(run.id)) return
    const task = await getAgentTask(run.taskId)
    if (!task?.maxTokens || totalTokens < task.maxTokens) return
    if (run.threadId && run.turnId) await this.owner.interrupt(run.threadId, this.threadContext()).catch(() => undefined)
    await this.finish(run, { status: 'failed', error: `Token limit reached (${String(task.maxTokens)}).`, totalTokens })
  }

  /** All background actions join the same Core owner as browser and Feishu
   * turns.  The task still owns its workspace policy, never a second queue. */
  private threadContext(task?: AgentTask): ExecutionContext {
    return { thread: task ? { cwd: task.cwd, ...(task.model ? { model: task.model } : {}) } : {} }
  }

  private async deliver(task: AgentTask, run: AgentTaskRun, summary: string): Promise<void> {
    if (task.outputMode === 'conversation' || !summary) return
    await setAgentTaskRunDeliveryPending(run.id)
    try {
      if (task.outputMode === 'file' || task.outputMode === 'file-and-notification') {
        const target = resolve(task.cwd, task.outputPath)
        const root = resolve(task.cwd)
        if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Output path escapes the workspace')
        await mkdir(dirname(target), { recursive: true })
        const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(target))])
        if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) throw new Error('Output path resolves outside the workspace')
        const targetDetails = await lstat(target).catch(() => null)
        if (targetDetails?.isSymbolicLink()) throw new Error('Output file cannot be a symbolic link')
        await appendFile(target, `\n## ${task.name} · ${this.now().toISOString()}\n\n${summary.trim()}\n`, 'utf8')
      }
      if (task.outputMode === 'notification' || task.outputMode === 'file-and-notification') {
        await this.emit(task, run, 'Agent task result', summary.slice(0, 1_000), 'success', true)
      }
      await updateAgentTaskRunDelivery(run.id, 'sent', '', this.now())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateAgentTaskRunDelivery(run.id, 'failed', message, this.now())
      await this.emit(task, run, 'Agent task delivery failed', message, 'danger', true)
    }
  }

  private async emitForRun(run: AgentTaskRun, title: string, summary: string, severity: 'info' | 'success' | 'warning' | 'danger'): Promise<void> {
    const task = await getAgentTask(run.taskId)
    if (task) await this.emit(task, run, title, summary, severity, task.notificationPolicy !== 'off')
  }

  private async emit(task: AgentTask, run: AgentTaskRun, title: string, summary: string, severity: 'info' | 'success' | 'warning' | 'danger', enabled: boolean): Promise<void> {
    if (!enabled || !this.eventSink) return
    try {
      await this.eventSink({ task, run, title, summary, severity })
    } catch (error) {
      console.warn(`Agent task notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
