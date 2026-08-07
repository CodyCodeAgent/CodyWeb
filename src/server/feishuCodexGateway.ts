import type { CatalogProject, CatalogSnapshot, CatalogThread } from './catalogStore.js'

type Rpc = (method: string, params: unknown) => Promise<unknown>
type RespondToServerRequest = (payload: unknown) => Promise<void>

export type FeishuProjectOption = {
  id: string
  name: string
  cwd: string
  sessionCount: number
}

export type FeishuSessionOption = {
  id: string
  title: string
  preview: string
  updatedAtIso: string
}

export type FeishuStartedSession = {
  id: string
  title: string
  cwd: string
}

export type FeishuStartedTurn = {
  threadId: string
  turnId: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function projectName(project: CatalogProject): string {
  const configured = project.displayName.trim()
  if (configured) return configured
  const normalized = project.cwd.replace(/[\\/]+$/u, '')
  return normalized.split(/[\\/]/u).pop() || project.cwd
}

function findProject(catalog: CatalogSnapshot, projectIdOrCwd: string): CatalogProject | null {
  const key = projectIdOrCwd.trim()
  return catalog.projects.find((project) => project.projectKey === key || project.cwd === key) ?? null
}

function mapThread(thread: CatalogThread): FeishuSessionOption {
  return {
    id: thread.id,
    title: thread.title,
    preview: thread.preview,
    updatedAtIso: thread.updatedAtIso,
  }
}

export class FeishuCodexGateway {
  private readonly freshThreadIds = new Set<string>()

  constructor(private readonly dependencies: {
    rpc: Rpc
    respondToServerRequest: RespondToServerRequest
    readCatalog: () => Promise<CatalogSnapshot>
    refreshCatalog?: () => Promise<void>
  }) {}

  async listProjects(): Promise<FeishuProjectOption[]> {
    await this.dependencies.refreshCatalog?.()
    const catalog = await this.dependencies.readCatalog()
    return catalog.projects.map((project) => ({
      id: project.projectKey,
      name: projectName(project),
      cwd: project.cwd,
      sessionCount: project.threads.length,
    }))
  }

  async listSessions(projectIdOrCwd: string): Promise<FeishuSessionOption[]> {
    await this.dependencies.refreshCatalog?.()
    const catalog = await this.dependencies.readCatalog()
    const project = findProject(catalog, projectIdOrCwd)
    if (!project) return []
    return [...project.threads]
      .sort((first, second) => Date.parse(second.updatedAtIso) - Date.parse(first.updatedAtIso))
      .map(mapThread)
  }

  async findSession(projectIdOrCwd: string, threadId: string): Promise<FeishuSessionOption | null> {
    const sessions = await this.listSessions(projectIdOrCwd)
    return sessions.find((session) => session.id === threadId.trim()) ?? null
  }

  async startSession(cwd: string): Promise<FeishuStartedSession> {
    const normalizedCwd = cwd.trim()
    if (!normalizedCwd) throw new Error('A project cwd is required to create a session')
    const payload = asRecord(await this.dependencies.rpc('thread/start', { cwd: normalizedCwd }))
    const thread = asRecord(payload?.thread)
    const id = readString(thread?.id)
    if (!id) throw new Error('thread/start did not return a thread id')
    // A thread/start result exists only in the app-server process until its
    // first user turn materializes the rollout. thread/read(includeTurns) and
    // thread/resume reject that valid intermediate state, so remember it and
    // send the first turn directly.
    this.freshThreadIds.add(id)
    return { id, title: readString(thread?.name) || readString(thread?.title) || 'New session', cwd: normalizedCwd }
  }

  async startTurn(
    threadId: string,
    text: string,
    localImagePaths: string[] = [],
    collaborationMode: 'default' | 'plan' = 'default',
    permissionMode: 'normal' | 'yolo' = 'yolo',
  ): Promise<FeishuStartedTurn> {
    const normalizedThreadId = threadId.trim()
    const normalizedText = text.trim()
    if (!normalizedThreadId) throw new Error('A thread id is required to start a turn')
    if (!normalizedText) throw new Error('A text message is required to start a turn')

    const isFreshThread = this.freshThreadIds.has(normalizedThreadId)
    if (!isFreshThread) await this.dependencies.rpc('thread/resume', { threadId: normalizedThreadId })
    const input: Array<Record<string, unknown>> = [
      { type: 'text', text: normalizedText, text_elements: [] },
      ...localImagePaths
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => ({ type: 'localImage', path })),
    ]
    const turnStartParams: Record<string, unknown> = {
      threadId: normalizedThreadId,
      input,
    }
    if (permissionMode === 'yolo') {
      turnStartParams.approvalPolicy = 'never'
      turnStartParams.sandboxPolicy = { type: 'dangerFullAccess' }
    }
    if (collaborationMode === 'plan') {
      const [modePayload, configPayload] = await Promise.all([
        this.dependencies.rpc('collaborationMode/list', {}),
        this.dependencies.rpc('config/read', {}),
      ])
      const modeData = asRecord(modePayload)?.data
      const modes = Array.isArray(modeData) ? modeData : []
      const plan = modes.map((row) => asRecord(row)).find((row) => readString(row?.mode) === 'plan')
      const config = asRecord(asRecord(configPayload)?.config)
      turnStartParams.collaborationMode = {
        mode: 'plan',
        settings: {
          model: readString(plan?.model) || readString(config?.model),
          reasoning_effort: readString(plan?.reasoning_effort) || readString(config?.model_reasoning_effort) || null,
          developer_instructions: readString(plan?.developer_instructions) || null,
        },
      }
    }
    const payload = asRecord(await this.dependencies.rpc('turn/start', turnStartParams))
    const turn = asRecord(payload?.turn)
    const turnId = readString(turn?.id)
    if (!turnId) throw new Error('turn/start did not return a turn id')
    this.freshThreadIds.delete(normalizedThreadId)
    return { threadId: normalizedThreadId, turnId }
  }

  async stopTurn(threadId: string, turnId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedTurnId = turnId.trim()
    if (!normalizedThreadId || !normalizedTurnId) throw new Error('threadId and turnId are required to stop a turn')
    await this.dependencies.rpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  }

  async isThreadBusy(threadId: string): Promise<boolean> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return false
    if (this.freshThreadIds.has(normalizedThreadId)) return false
    const payload = asRecord(await this.dependencies.rpc('thread/read', {
      threadId: normalizedThreadId,
      includeTurns: true,
    }))
    const turns = asRecord(payload?.thread)?.turns
    return Array.isArray(turns) && turns.some((value) => readString(asRecord(value)?.status) === 'inProgress')
  }

  async findActiveTurnId(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return null
    if (this.freshThreadIds.has(normalizedThreadId)) return null
    const payload = asRecord(await this.dependencies.rpc('thread/read', {
      threadId: normalizedThreadId,
      includeTurns: true,
    }))
    const turns = asRecord(payload?.thread)?.turns
    if (!Array.isArray(turns)) return null
    // thread/read keeps historical turns in chronological order. Interrupted
    // clients can leave an older turn marked inProgress, while app-server only
    // accepts interrupts for the newest active turn. Always prefer the last
    // active record instead of the first stale one.
    const active = turns.map(asRecord)
      .filter((value) => readString(value?.status) === 'inProgress')
      .at(-1)
    return readString(active?.id) || null
  }

  async readTurnState(threadId: string, turnId: string): Promise<{
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'missing'
    responseText?: string
    error?: string
  }> {
    const payload = asRecord(await this.dependencies.rpc('thread/read', { threadId: threadId.trim(), includeTurns: true }))
    const turns = asRecord(payload?.thread)?.turns
    const turn = Array.isArray(turns)
      ? turns.map(asRecord).find((value) => readString(value?.id) === turnId.trim())
      : null
    if (!turn) return { status: 'missing' }
    const rawStatus = readString(turn.status)
    const errorValue = asRecord(turn.error)
    const error = readString(errorValue?.message || turn.error)
    const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : []
    const responseText = items.filter((item) => readString(item?.type) === 'agentMessage')
      .map((item) => readString(item?.text || item?.content)).filter(Boolean).at(-1)
    if (rawStatus === 'inProgress') return { status: 'running', responseText }
    if (rawStatus === 'failed' || error) return { status: 'failed', responseText, error }
    if (rawStatus === 'interrupted' || rawStatus === 'cancelled') return { status: 'cancelled', responseText }
    return { status: 'completed', responseText }
  }

  async renameSession(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedTitle = title.trim()
    if (!normalizedThreadId || !normalizedTitle) throw new Error('threadId and title are required to rename a session')
    await this.dependencies.rpc('thread/name/set', { threadId: normalizedThreadId, name: normalizedTitle })
  }

  async archiveSession(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) throw new Error('A thread id is required to archive a session')
    await this.dependencies.rpc('thread/archive', { threadId: normalizedThreadId })
  }

  async resolveApproval(requestId: number, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): Promise<void> {
    if (!Number.isInteger(requestId)) throw new Error('A numeric request id is required')
    await this.dependencies.respondToServerRequest({
      id: requestId,
      approvalScope: decision === 'acceptForSession' ? 'session' : 'single',
      result: { decision },
    })
  }

  async resolveUserInput(requestId: number, answers: Record<string, string[]>): Promise<void> {
    if (!Number.isInteger(requestId)) throw new Error('A numeric request id is required')
    await this.dependencies.respondToServerRequest({
      id: requestId,
      result: {
        answers: Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
        ),
      },
    })
  }
}
