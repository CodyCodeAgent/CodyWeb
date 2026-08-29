import type { CatalogProject, CatalogSnapshot, CatalogThread } from './catalogStore.js'
import { latestAssistantTextFromEvents, latestTerminalTurnEvent } from '@codycodeagent/cody-web-core/conversation'
import { normalizeCodexNotification } from '@codycodeagent/cody-web-core/session'

type Rpc = (method: string, params: unknown) => Promise<unknown>
type RespondToServerRequest = (payload: unknown) => Promise<void>
type Subscribe = (listener: (notification: { method: string; params?: unknown }) => void) => () => void

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

export type FeishuAutoRouteAnalysis = {
  requiredKeywords: string[]
  instruction: string
  reason: string
}

export type ScenarioPackageDraft = {
  title: string
  description: string
  category: string
  content: string
  primarySkill: { name: string; path: string; displayName: string; description: string } | null
  reason: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseAutoRouteAnalysis(text: string): FeishuAutoRouteAnalysis {
  const normalized = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const row = asRecord(JSON.parse(normalized) as unknown)
  const rawKeywords = Array.isArray(row?.required_keywords) ? row.required_keywords : []
  const proposal = {
    requiredKeywords: rawKeywords.filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim()).filter(Boolean).slice(0, 8),
    instruction: readString(row?.instruction).slice(0, 1_000),
    reason: readString(row?.reason).slice(0, 1_000),
  }
  if (!proposal.requiredKeywords.length || !proposal.instruction) throw new Error('Codex returned an invalid card route proposal')
  return proposal
}

function parseScenarioPackageDraft(
  text: string,
  skills: Array<{ name: string; path: string; displayName: string; description: string }>,
): ScenarioPackageDraft {
  const normalized = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const row = asRecord(JSON.parse(normalized) as unknown)
  const title = readString(row?.title).slice(0, 160)
  const content = readString(row?.content).slice(0, 128 * 1024)
  if (!title || !content) throw new Error('Codex returned an invalid scenario package draft')
  const skillPath = readString(row?.primary_skill_path)
  return {
    title,
    description: readString(row?.description).slice(0, 1_000),
    category: readString(row?.category).slice(0, 64) || 'General',
    content,
    primarySkill: skills.find((skill) => skill.path === skillPath) ?? null,
    reason: readString(row?.reason).slice(0, 1_000),
  }
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
    subscribe?: Subscribe
    readCatalog: () => Promise<CatalogSnapshot>
    refreshCatalog?: () => Promise<void>
  }) {}

  /** Drafts a reusable scenario package from a short operator brief and the live workspace skill catalog. */
  async draftScenarioPackage(input: { cwd: string; brief: string; timeoutMs?: number }): Promise<ScenarioPackageDraft> {
    if (!this.dependencies.subscribe) throw new Error('Codex draft notifications are unavailable')
    const cwd = input.cwd.trim()
    const brief = input.brief.trim()
    if (!cwd) throw new Error('A workspace is required to draft a scenario package')
    if (!brief) throw new Error('Describe the scenario package you want Codex to draft')

    const skillPayload = asRecord(await this.dependencies.rpc('skills/list', { cwds: [cwd] }))
    const data = Array.isArray(skillPayload?.data) ? skillPayload.data : []
    const skills = data.flatMap((entry) => {
      const rows = Array.isArray(asRecord(entry)?.skills) ? asRecord(entry)!.skills as unknown[] : []
      return rows.flatMap((value) => {
        const row = asRecord(value)
        const name = readString(row?.name); const path = readString(row?.path)
        if (!name || !path || row?.enabled === false) return []
        const iface = asRecord(row?.interface)
        return [{
          name,
          path,
          displayName: readString(iface?.displayName) || name,
          description: readString(iface?.shortDescription || row?.shortDescription || row?.description).slice(0, 500),
        }]
      })
    })
    const uniqueSkills = Array.from(new Map(skills.map((skill) => [skill.path, skill])).values()).slice(0, 160)
    const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? 60_000, 90_000))
    let threadId = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: () => void = () => {}

    const result = new Promise<ScenarioPackageDraft>((resolve, reject) => {
      const finish = (value: ScenarioPackageDraft | Error) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        unsubscribe()
        if (value instanceof Error) reject(value); else resolve(value)
      }
      unsubscribe = this.dependencies.subscribe?.((notification) => {
        const events = normalizeCodexNotification(notification, { fallbackThreadId: threadId })
          .filter((event) => event.threadId === threadId)
        const message = latestAssistantTextFromEvents(events)
        const terminal = latestTerminalTurnEvent(events)
        if (!terminal) {
          if (message) try { finish(parseScenarioPackageDraft(message, uniqueSkills)) } catch { /* terminal event reports invalid output */ }
          return
        }
        if (terminal.type !== 'turn.completed') {
          finish(new Error(readString(terminal.data.error) || 'Codex scenario package draft failed')); return
        }
        try { finish(parseScenarioPackageDraft(message, uniqueSkills)) } catch (parseError) {
          finish(parseError instanceof Error ? parseError : new Error(String(parseError)))
        }
      }) ?? (() => undefined)
      timeout = setTimeout(() => finish(new Error('Codex scenario package draft timed out')), timeoutMs)
      timeout.unref?.()
    })

    try {
      const started = asRecord(await this.dependencies.rpc('thread/start', {
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: [
          '你是 CodyWeb 的场景包设计器。',
          '把用户描述整理成可复用、证据优先、边界明确的任务指令。',
          '主要 Skill 是可选引导：只有目录中存在高度匹配的 Skill 时才选择，否则返回空字符串，让 Codex 自主发现能力。',
          '不要执行任务，不要修改文件，只生成场景包草稿，并严格遵守输出 Schema。',
        ].join('\n'),
      }))
      threadId = readString(asRecord(started?.thread)?.id)
      if (!threadId) throw new Error('thread/start did not return a draft thread id')
      await this.dependencies.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: [
          `用户描述：${brief.slice(0, 12_000)}`,
          '',
          '当前可用 Skill：',
          uniqueSkills.length
            ? uniqueSkills.map((skill) => `- ${skill.displayName} | ${skill.path} | ${skill.description || '无说明'}`).join('\n')
            : '无',
        ].join('\n'), text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        outputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 160 },
            description: { type: 'string', maxLength: 1_000 },
            category: { type: 'string', minLength: 1, maxLength: 64 },
            content: { type: 'string', minLength: 1, maxLength: 128_000 },
            primary_skill_path: { type: 'string', enum: ['', ...uniqueSkills.map((skill) => skill.path)] },
            reason: { type: 'string', maxLength: 1_000 },
          },
          required: ['title', 'description', 'category', 'content', 'primary_skill_path', 'reason'],
        },
      })
      return await result
    } catch (error) {
      if (timeout) clearTimeout(timeout)
      unsubscribe(); settled = true
      throw error
    }
  }

  /** Runs a short-lived, read-only Codex thread with a strict output schema. */
  async analyzeAutoRoute(input: {
    cwd: string
    cardTitle: string
    cardText: string
    candidateKeywords: string[]
    requestedInstruction: string
    timeoutMs?: number
  }): Promise<FeishuAutoRouteAnalysis> {
    if (!this.dependencies.subscribe) throw new Error('Codex analysis notifications are unavailable')
    const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? 45_000, 90_000))
    let threadId = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: () => void = () => {}

    const result = new Promise<FeishuAutoRouteAnalysis>((resolve, reject) => {
      const finish = (value: FeishuAutoRouteAnalysis | Error) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        unsubscribe()
        if (value instanceof Error) reject(value)
        else resolve(value)
      }
      unsubscribe = this.dependencies.subscribe?.((notification) => {
        const events = normalizeCodexNotification(notification, { fallbackThreadId: threadId })
          .filter((event) => event.threadId === threadId)
        const message = latestAssistantTextFromEvents(events)
        const terminal = latestTerminalTurnEvent(events)
        if (!terminal) {
          if (message) try { finish(parseAutoRouteAnalysis(message)) } catch { /* terminal event reports invalid output */ }
          return
        }
        if (terminal.type !== 'turn.completed') {
          finish(new Error(readString(terminal.data.error) || 'Codex card route analysis failed'))
          return
        }
        try { finish(parseAutoRouteAnalysis(message)) } catch (parseError) {
          finish(parseError instanceof Error ? parseError : new Error(String(parseError)))
        }
      }) ?? (() => undefined)
      timeout = setTimeout(() => finish(new Error('Codex card route analysis timed out')), timeoutMs)
      timeout.unref?.()
    })

    try {
      const started = asRecord(await this.dependencies.rpc('thread/start', {
        cwd: input.cwd.trim(),
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: [
          '你是 CodyWeb 的飞书卡片路由规则分析器。',
          '分析卡片结构，选择能区分卡片类型、且不会随每次告警变化的字段标签。',
          '只能从 candidate_keywords 中选择，不得创建正则、脚本或新字段。',
          '严格按照输出 Schema 返回；不要添加解释文字。',
        ].join('\n'),
      }))
      threadId = readString(asRecord(started?.thread)?.id)
      if (!threadId) throw new Error('thread/start did not return an analysis thread id')
      await this.dependencies.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: [
          `卡片标题：${input.cardTitle}`,
          `候选稳定字段：${input.candidateKeywords.join('、') || '无'}`,
          `用户希望的处理方式：${input.requestedInstruction || '分析异常，给出结论、原因与建议'}`,
          '',
          '卡片内容：',
          input.cardText.slice(0, 12_000),
        ].join('\n'), text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            required_keywords: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
            instruction: { type: 'string', minLength: 1, maxLength: 1_000 },
            reason: { type: 'string', minLength: 1, maxLength: 1_000 },
          },
          required: ['required_keywords', 'instruction', 'reason'],
        },
      })
      return await result
    } catch (error) {
      if (timeout) clearTimeout(timeout)
      unsubscribe()
      settled = true
      throw error
    }
  }

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
    skills: Array<{ name: string; path: string }> = [],
  ): Promise<FeishuStartedTurn> {
    const normalizedThreadId = threadId.trim()
    const normalizedText = text.trim()
    if (!normalizedThreadId) throw new Error('A thread id is required to start a turn')
    if (!normalizedText) throw new Error('A text message is required to start a turn')

    const isFreshThread = this.freshThreadIds.has(normalizedThreadId)
    if (!isFreshThread) await this.dependencies.rpc('thread/resume', { threadId: normalizedThreadId })
    const input: Array<Record<string, unknown>> = [
      ...skills
        .map((skill) => ({ name: skill.name.trim(), path: skill.path.trim() }))
        .filter((skill) => skill.name && skill.path)
        .map((skill) => ({ type: 'skill', name: skill.name, path: skill.path })),
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
