import type { CatalogProject, CatalogSnapshot, CatalogThread } from './catalogStore.js'
import { randomUUID } from 'node:crypto'
import { latestAssistantTextFromEvents, latestTerminalTurnEvent, type CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { buildTurnUserInput, type ExecutionContext, type TurnInput } from '@codycodeagent/cody-web-core/session'
import type { CodyWebConversationOwner } from './conversationOwner.js'

type ConversationOwner = Pick<CodyWebConversationOwner,
  'start' | 'submitUntilStarted' | 'runEphemeral' | 'read' | 'interrupt' |
  'listSkills' | 'listCollaborationModes' | 'readConfig' | 'renameThread' | 'archiveThread' |
  'respondApproval' | 'respondQuestion' | 'subscribe'>

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
  private readonly requestThreadIds = new Map<string, string>()
  private readonly stopOwnerEvents: () => void

  constructor(private readonly dependencies: {
    owner: ConversationOwner
    readCatalog: () => Promise<CatalogSnapshot>
    refreshCatalog?: () => Promise<void>
  }) {
    this.stopOwnerEvents = dependencies.owner.subscribe((event) => this.captureRequestBinding(event))
  }

  /** Drafts a reusable scenario package from a short operator brief and the live workspace skill catalog. */
  async draftScenarioPackage(input: { cwd: string; brief: string; timeoutMs?: number }): Promise<ScenarioPackageDraft> {
    const cwd = input.cwd.trim()
    const brief = input.brief.trim()
    if (!cwd) throw new Error('A workspace is required to draft a scenario package')
    if (!brief) throw new Error('Describe the scenario package you want Codex to draft')

    const skills = (await this.dependencies.owner.listSkills([cwd]))
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        name: skill.name,
        path: skill.path,
        displayName: skill.displayName,
        description: skill.description.slice(0, 500),
      }))
    const uniqueSkills = Array.from(new Map(skills.map((skill) => [skill.path, skill])).values()).slice(0, 160)
    const outcome = await this.runEphemeral(cwd, {
        input: [{ type: 'text', text: [
          `用户描述：${brief.slice(0, 12_000)}`,
          '',
          '当前可用 Skill：',
          uniqueSkills.length
            ? uniqueSkills.map((skill) => `- ${skill.displayName} | ${skill.path} | ${skill.description || '无说明'}`).join('\n')
            : '无',
        ].join('\n'), text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
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
      }, [
        '你是 CodyWeb 的场景包设计器。',
        '把用户描述整理成可复用、证据优先、边界明确的任务指令。',
        '主要 Skill 是可选引导：只有目录中存在高度匹配的 Skill 时才选择，否则返回空字符串，让 Codex 自主发现能力。',
        '不要执行任务，不要修改文件，只生成场景包草稿，并严格遵守输出 Schema。',
      ], input.timeoutMs)
    return parseScenarioPackageDraft(outcome, uniqueSkills)
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
    const outcome = await this.runEphemeral(input.cwd.trim(), {
        input: [{ type: 'text', text: [
          `卡片标题：${input.cardTitle}`,
          `候选稳定字段：${input.candidateKeywords.join('、') || '无'}`,
          `用户希望的处理方式：${input.requestedInstruction || '分析异常，给出结论、原因与建议'}`,
          '',
          '卡片内容：',
          input.cardText.slice(0, 12_000),
        ].join('\n'), text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
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
      }, [
        '你是 CodyWeb 的飞书卡片路由规则分析器。',
        '分析卡片结构，选择能区分卡片类型、且不会随每次告警变化的字段标签。',
        '只能从 candidate_keywords 中选择，不得创建正则、脚本或新字段。',
        '严格按照输出 Schema 返回；不要添加解释文字。',
      ], input.timeoutMs)
    return parseAutoRouteAnalysis(outcome)
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
    const { threadId } = await this.dependencies.owner.start({ thread: { cwd: normalizedCwd } })
    return { id: threadId, title: 'New session', cwd: normalizedCwd }
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

    const input = buildTurnUserInput({ text: normalizedText, skills, localImages: localImagePaths.map(path => ({ path })) })
    const turnInput: TurnInput = {
      input,
      ...(permissionMode === 'yolo' ? { approvalPolicy: 'never' as const, sandboxPolicy: { type: 'dangerFullAccess' as const } } : {}),
      ...(collaborationMode === 'plan' ? { collaborationMode: await this.planCollaborationMode() } : {}),
    }
    const handle = await this.dependencies.owner.submitUntilStarted({
      threadId: normalizedThreadId,
      clientCommandId: `feishu:${randomUUID()}`,
      mode: 'queue',
      context: this.threadContext(),
      input: turnInput,
    })
    return { threadId: handle.threadId, turnId: handle.turnId }
  }

  private async planCollaborationMode() {
    const [modes, config] = await Promise.all([
      this.dependencies.owner.listCollaborationModes(),
      this.dependencies.owner.readConfig(),
    ])
    const plan = modes.find(mode => mode.mode === 'plan')
    return {
      mode: 'plan' as const,
      settings: {
        model: plan?.model || config.config.model || '',
        reasoning_effort: plan?.reasoningEffort || config.config.model_reasoning_effort || null,
        developer_instructions: config.config.developer_instructions || null,
      },
    }
  }

  async stopTurn(threadId: string, turnId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !turnId.trim()) throw new Error('threadId and turnId are required to stop a turn')
    await this.dependencies.owner.interrupt(normalizedThreadId, this.threadContext())
  }

  async isThreadBusy(threadId: string): Promise<boolean> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return false
    return Boolean(await this.findActiveTurnId(normalizedThreadId))
  }

  async findActiveTurnId(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return null
    const events = await this.dependencies.owner.read(normalizedThreadId, this.threadContext())
    return activeTurnId(events)
  }

  async readTurnState(threadId: string, turnId: string): Promise<{
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'missing'
    responseText?: string
    error?: string
  }> {
    const events = (await this.dependencies.owner.read(threadId.trim(), this.threadContext()))
      .filter((event) => event.turnId === turnId.trim())
    if (!events.length) return { status: 'missing' }
    const terminal = latestTerminalTurnEvent(events)
    const responseText = latestAssistantTextFromEvents(events) || undefined
    if (!terminal) return { status: 'running', responseText }
    if (terminal.type === 'turn.failed') return { status: 'failed', responseText, error: readString(terminal.data.error) }
    if (terminal.type === 'turn.interrupted') return { status: 'cancelled', responseText }
    return { status: 'completed', responseText }
  }

  async renameSession(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    const normalizedTitle = title.trim()
    if (!normalizedThreadId || !normalizedTitle) throw new Error('threadId and title are required to rename a session')
    await this.dependencies.owner.renameThread(normalizedThreadId, normalizedTitle)
  }

  async archiveSession(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) throw new Error('A thread id is required to archive a session')
    await this.dependencies.owner.archiveThread(normalizedThreadId)
  }

  async resolveApproval(requestId: number, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): Promise<void> {
    if (!Number.isInteger(requestId)) throw new Error('A numeric request id is required')
    const threadId = this.requestThreadIds.get(String(requestId))
    if (!threadId) throw new Error('Codex approval is no longer pending')
    await this.dependencies.owner.respondApproval(threadId, this.threadContext(), String(requestId), decision)
  }

  async resolveUserInput(requestId: number, answers: Record<string, string[]>): Promise<void> {
    if (!Number.isInteger(requestId)) throw new Error('A numeric request id is required')
    const threadId = this.requestThreadIds.get(String(requestId))
    if (!threadId) throw new Error('Codex question is no longer pending')
    await this.dependencies.owner.respondQuestion(threadId, this.threadContext(), String(requestId), {
      answers: Object.fromEntries(Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }])),
    })
  }

  dispose(): void { this.stopOwnerEvents(); this.requestThreadIds.clear() }

  private threadContext(): ExecutionContext { return { thread: {} } }

  private async runEphemeral(cwd: string, input: TurnInput, baseInstructions: string[], timeoutMs?: number): Promise<string> {
    const outcome = await this.dependencies.owner.runEphemeral({
      thread: { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: baseInstructions.join('\n') },
    }, input, `feishu-analysis:${randomUUID()}`, timeoutMs)
    if (outcome.terminalEvent.type !== 'turn.completed') {
      throw new Error(readString(outcome.terminalEvent.data.error) || 'Codex analysis failed')
    }
    return outcome.assistantText
  }

  private captureRequestBinding(event: CodexEvent): void {
    if (event.type !== 'approval.requested' && event.type !== 'question.requested') return
    const requestId = readString(event.data.requestId || event.data.approvalId)
    if (requestId && event.threadId) this.requestThreadIds.set(requestId, event.threadId)
  }
}

function activeTurnId(events: readonly CodexEvent[]): string | null {
  const state = new Map<string, 'active' | 'terminal'>()
  for (const event of events) {
    if (!event.turnId) continue
    if (event.type === 'turn.started') state.set(event.turnId, 'active')
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted') state.set(event.turnId, 'terminal')
  }
  for (const [turnId, status] of [...state.entries()].reverse()) if (status === 'active') return turnId
  return null
}
