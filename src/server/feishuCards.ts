import { buildFeishuMarkdownElements } from './feishuMarkdownCard'

export const FEISHU_CARD_ACTIONS = {
  selectProject: 'cody_feishu_select_project',
  selectSession: 'cody_feishu_select_session',
  newSession: 'cody_feishu_new_session',
  unbind: 'cody_feishu_unbind',
  approve: 'cody_feishu_approve',
  deny: 'cody_feishu_deny',
  grantAccess: 'cody_feishu_grant_access',
  denyAccess: 'cody_feishu_deny_access',
  userInputToggle: 'cody_feishu_user_input_toggle',
  userInputSubmit: 'cody_feishu_user_input_submit',
  setPermissionMode: 'cody_feishu_set_permission_mode',
} as const

export type FeishuCard = Record<string, unknown>

export type FeishuCardProject = {
  projectKey: string
  cwd: string
  label: string
  sessionCount: number
}

export type FeishuCardSession = {
  threadId: string
  title: string
  preview?: string
  updatedAtIso?: string
}

function plainText(content: string): Record<string, string> {
  return { tag: 'plain_text', content }
}

function markdown(content: string): Record<string, string> {
  return { tag: 'lark_md', content }
}

function truncate(value: string, max: number): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function truncateReplyMarkdown(value: string, max: number): string {
  const imagePattern = /!\[[^\]\r\n]*\]\(img_v\d+_[A-Za-z0-9_-]+\)/giu
  const images = [...new Set(value.match(imagePattern) ?? [])]
  const reserved = images.reduce((total, image) => total + image.length + 2, 0)
  let result = truncate(value, Math.max(1_000, max - reserved))
  const missing = images.filter((image) => !result.includes(image))
  if (missing.length > 0) result = `${result}\n\n${missing.join('\n\n')}`
  return result
}

function card(title: string, elements: unknown[], template = 'blue'): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: { template, title: plainText(title) },
    elements,
  }
}

/** First step of the binding flow: choose a CodyWeb workspace. */
export function buildProjectSelectionCard(input: {
  projects: FeishuCardProject[]
  bindingKey: string
  pendingMessageId?: string
  requesterOpenId?: string
}): FeishuCard {
  const projects = input.projects.slice(0, 100)
  const projectLabelCounts = new Map<string, number>()
  for (const project of projects) {
    const key = project.label.trim().toLocaleLowerCase()
    projectLabelCounts.set(key, (projectLabelCounts.get(key) ?? 0) + 1)
  }
  const elements: unknown[] = [
    { tag: 'div', text: markdown('请选择要连接的 **CodyWeb 项目**。绑定后，飞书和 Web 会继续同一个 Codex session。') },
  ]

  if (projects.length === 0) {
    elements.push({ tag: 'div', text: markdown('当前没有可见项目。请先在 CodyWeb 中打开一个项目并同步目录。') })
  } else {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: plainText('选择项目'),
        options: projects.map((project) => {
          const duplicateLabel = (projectLabelCounts.get(project.label.trim().toLocaleLowerCase()) ?? 0) > 1
          const label = duplicateLabel ? `${project.label} · ${project.cwd}` : project.label
          return {
            text: plainText(truncate(`${label} · ${project.sessionCount} 个 session`, 80)),
            value: project.projectKey,
          }
        }),
        value: {
          action: FEISHU_CARD_ACTIONS.selectProject,
          binding_key: input.bindingKey,
          pending_message_id: input.pendingMessageId ?? '',
          requester_open_id: input.requesterOpenId ?? '',
        },
      }],
    })
  }

  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '群聊按群/话题绑定，私聊按会话绑定。' }] })
  return card('连接 CodyWeb', elements)
}

/** Second step: reuse an existing Codex thread or start a new one. */
export function buildSessionSelectionCard(input: {
  project: FeishuCardProject
  sessions: FeishuCardSession[]
  bindingKey: string
  pendingMessageId?: string
  requesterOpenId?: string
}): FeishuCard {
  const sessions = input.sessions.slice(0, 90)
  const sessionLabelCounts = new Map<string, number>()
  for (const session of sessions) {
    const label = (session.title || session.preview || session.threadId).trim().toLocaleLowerCase()
    sessionLabelCounts.set(label, (sessionLabelCounts.get(label) ?? 0) + 1)
  }
  const sharedValue = {
    binding_key: input.bindingKey,
    project_key: input.project.projectKey,
    cwd: input.project.cwd,
    pending_message_id: input.pendingMessageId ?? '',
    requester_open_id: input.requesterOpenId ?? '',
  }
  const actions: unknown[] = []
  if (sessions.length > 0) {
    actions.push({
      tag: 'select_static',
      placeholder: plainText('选择已有 session'),
      options: sessions.map((session) => {
        const label = session.title || session.preview || session.threadId
        const duplicateLabel = (sessionLabelCounts.get(label.trim().toLocaleLowerCase()) ?? 0) > 1
        return {
          text: plainText(truncate(duplicateLabel ? `${label} · ${session.threadId.slice(0, 8)}` : label, 80)),
          value: session.threadId,
        }
      }),
      value: { action: FEISHU_CARD_ACTIONS.selectSession, ...sharedValue },
    })
  }
  actions.push({
    tag: 'button',
    type: 'primary',
    text: plainText('新建 session'),
    value: { action: FEISHU_CARD_ACTIONS.newSession, ...sharedValue },
  })

  return card('选择 Session', [
    { tag: 'div', text: markdown(`项目：**${truncate(input.project.label, 80)}**\n\n路径：\`${truncate(input.project.cwd, 160)}\`\n\n选择已有 session 会继续其完整上下文；也可以新建。`) },
    { tag: 'action', actions },
  ])
}

export type FeishuStreamState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped'

/** A patchable card used for the entire Codex turn. */
export function buildStreamingReplyCard(input: {
  state: FeishuStreamState
  content?: string
  projectLabel?: string
  sessionTitle?: string
  threadId?: string
  error?: string
  webUrl?: string
}): FeishuCard {
  const presentation = {
    queued: { icon: '⏳', label: '已接收', template: 'blue' },
    running: { icon: '🟢', label: 'Codex 正在处理', template: 'turquoise' },
    completed: { icon: '✅', label: '已完成', template: 'green' },
    failed: { icon: '⚠️', label: '执行失败', template: 'red' },
    stopped: { icon: '⏹️', label: '已停止', template: 'grey' },
  }[input.state]
  const body = input.error
    ? `**错误**\n${truncate(input.error, 8_000)}`
    : input.content?.trim() || (input.state === 'queued' ? '正在排队…' : '正在思考…')
  const meta = [input.projectLabel, input.sessionTitle].filter(Boolean).map((value) => truncate(value ?? '', 80)).join(' · ')
  const elements: Record<string, unknown>[] = buildFeishuMarkdownElements(truncateReplyMarkdown(body, 20_000))
  const footer = ['[CodyWeb](https://github.com/CodyCodeAgent/CodyWebUI)', meta]
  if (input.webUrl) footer.push(`[打开 Session](${input.webUrl})`)
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    text_size: 'notation_small_v2',
    content: `<font color='grey'>${footer.filter(Boolean).join(' · ')}</font>`,
  })

  return {
    schema: '2.0',
    config: { update_multi: true },
    ...(input.state === 'completed'
      ? {}
      : { header: { template: presentation.template, title: plainText(`${presentation.icon} ${presentation.label}`) } }),
    body: { direction: 'vertical', elements },
  }
}

export function buildBoundSessionCard(input: {
  projectLabel: string
  sessionTitle: string
  threadId: string
  bindingKey: string
  webUrl?: string
  requesterOpenId?: string
  permissionMode?: 'normal' | 'yolo'
}): FeishuCard {
  const actions: unknown[] = []
  if (input.webUrl) actions.push({ tag: 'button', text: plainText('打开 Session'), type: 'primary', url: input.webUrl })
  actions.push({
    tag: 'button',
    text: plainText(input.permissionMode === 'normal' ? '切换为 YOLO' : '切换为 Normal'),
    type: 'default',
    value: {
      action: FEISHU_CARD_ACTIONS.setPermissionMode,
      binding_key: input.bindingKey,
      permission_mode: input.permissionMode === 'normal' ? 'yolo' : 'normal',
      requester_open_id: input.requesterOpenId ?? '',
    },
  })
  actions.push({
    tag: 'button',
    text: plainText('解除绑定'),
    type: 'danger',
    value: {
      action: FEISHU_CARD_ACTIONS.unbind,
      binding_key: input.bindingKey,
      requester_open_id: input.requesterOpenId ?? '',
    },
  })
  return card('Session 已连接', [
    { tag: 'div', text: markdown(`项目：**${truncate(input.projectLabel, 80)}**\n\nSession：**${truncate(input.sessionTitle, 100)}**\n\n权限：**${(input.permissionMode ?? 'yolo').toUpperCase()}**`) },
    { tag: 'action', actions },
  ], 'green')
}

export function buildApprovalCard(input: {
  bindingKey: string
  requestId: string
  title: string
  summary: string
  requesterOpenId: string
}): FeishuCard {
  const base = {
    binding_key: input.bindingKey,
    request_id: input.requestId,
    requester_open_id: input.requesterOpenId,
  }
  return card(`🔐 ${truncate(input.title, 80)}`, [
    { tag: 'div', text: markdown(truncate(input.summary, 12_000)) },
    {
      tag: 'action',
      actions: [
        { tag: 'button', type: 'primary', text: plainText('允许一次'), value: { action: FEISHU_CARD_ACTIONS.approve, decision: 'accept', scope: 'single', ...base } },
        { tag: 'button', type: 'default', text: plainText('本 Session 允许'), value: { action: FEISHU_CARD_ACTIONS.approve, decision: 'acceptForSession', scope: 'session', ...base } },
        { tag: 'button', type: 'danger', text: plainText('拒绝'), value: { action: FEISHU_CARD_ACTIONS.deny, decision: 'decline', scope: 'turn', ...base } },
      ],
    },
  ], 'orange')
}

/** Sent privately to an existing allow-list member when another user asks to use the bot. */
export function buildAccessRequestCard(input: {
  requesterOpenId: string
  chatId: string
  chatType: 'p2p' | 'group'
  requestToken: string
}): FeishuCard {
  const base = {
    access_request_token: input.requestToken,
  }
  const source = input.chatType === 'p2p' ? '私聊' : `群聊 \`${truncate(input.chatId, 80)}\``
  return card('飞书机器人访问申请', [
    {
      tag: 'div',
      text: markdown(`用户 \`${truncate(input.requesterOpenId, 100)}\` 在${source}中请求使用 CodyWeb。\n\n批准只会把这个 Open ID 精确加入白名单，不会开启全员访问。`),
    },
    {
      tag: 'action',
      actions: [
        { tag: 'button', type: 'primary', text: plainText('允许访问'), value: { action: FEISHU_CARD_ACTIONS.grantAccess, ...base } },
        { tag: 'button', type: 'danger', text: plainText('拒绝'), value: { action: FEISHU_CARD_ACTIONS.denyAccess, ...base } },
      ],
    },
  ], 'orange')
}

export function buildResolvedAccessRequestCard(input: {
  requesterOpenId: string
  granted: boolean
  operatorOpenId: string
  resolvedAtIso: string
}): FeishuCard {
  return card(input.granted ? '已允许访问' : '已拒绝访问', [
    {
      tag: 'div',
      text: markdown(input.granted
        ? `已将 \`${truncate(input.requesterOpenId, 100)}\` 精确加入机器人白名单。对方现在可以回到原会话重试。`
        : `未向 \`${truncate(input.requesterOpenId, 100)}\` 开放机器人访问。`),
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `操作人：${truncate(input.operatorOpenId, 100)} · ${input.resolvedAtIso}` }],
    },
  ], input.granted ? 'green' : 'grey')
}

export type FeishuUserInputQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }>
}

function appendActionRows(elements: unknown[], actions: unknown[]): void {
  for (let index = 0; index < actions.length; index += 4) {
    elements.push({ tag: 'action', actions: actions.slice(index, index + 4) })
  }
}

/**
 * RequestUserInput uses stable buttons instead of form/select controls. Feishu
 * silently drops some select controls nested in forms, while button state can
 * be rebuilt after every click and works consistently on desktop and mobile.
 */
export function buildUserInputCard(input: {
  bindingKey: string
  requestId: string
  requesterOpenId: string
  questions: FeishuUserInputQuestion[]
  selections?: Record<string, string>
}): FeishuCard {
  const selections = input.selections ?? {}
  const elements: unknown[] = [
    { tag: 'div', text: markdown('Codex 需要补充信息。逐题选择后点击“提交答案”。') },
    { tag: 'hr' },
  ]
  for (const [index, question] of input.questions.entries()) {
    const title = question.header || `问题 ${index + 1}`
    const detail = question.question && question.question !== question.header ? `\n${truncate(question.question, 800)}` : ''
    elements.push({ tag: 'div', text: markdown(`**${truncate(title, 80)}**${detail}`) })
    const buttons = question.options.map((option) => {
      const selected = selections[question.id] === option.label
      const description = option.description ? ` · ${option.description}` : ''
      return {
        tag: 'button',
        type: selected ? 'primary' : 'default',
        text: plainText(truncate(`${selected ? '●' : '○'} ${option.label}${description}`, 80)),
        value: {
          action: FEISHU_CARD_ACTIONS.userInputToggle,
          binding_key: input.bindingKey,
          request_id: input.requestId,
          requester_open_id: input.requesterOpenId,
          question_id: question.id,
          answer: option.label,
        },
      }
    })
    appendActionRows(elements, buttons)
    const selected = selections[question.id]
    if (selected && !question.options.some((option) => option.label === selected)) {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: question.isSecret ? '已记录敏感答案（内容不显示）' : `已记录自定义答案：${truncate(selected, 300)}` }],
      })
    }
    if (question.isOther || question.options.length === 0) {
      elements.push({
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: question.isSecret
            ? `请先完成其他问题，再在与机器人私聊中发送：/answer ${input.requestId} ${question.id} 你的答案`
            : `需要自定义答案时发送：/answer ${input.requestId} ${question.id} 你的答案`,
        }],
      })
    }
  }
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      type: 'primary',
      text: plainText('提交答案'),
      value: {
        action: FEISHU_CARD_ACTIONS.userInputSubmit,
        binding_key: input.bindingKey,
        request_id: input.requestId,
        requester_open_id: input.requesterOpenId,
      },
    }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `可答复人：${input.requesterOpenId}` }] })
  return card('Codex 需要你的选择', elements, 'blue')
}

/** Frozen terminal state: no actionable controls remain after settlement. */
export function buildResolvedRequestCard(input: {
  title: string
  summary: string
  outcome: 'approved' | 'denied' | 'answered' | 'resolved'
  operatorOpenId: string
  resolvedAtIso: string
  answers?: Record<string, string>
}): FeishuCard {
  const outcome = {
    approved: { label: '已批准', template: 'green' },
    denied: { label: '已拒绝', template: 'red' },
    answered: { label: '已提交答案', template: 'green' },
    resolved: { label: '已在其他入口处理', template: 'grey' },
  }[input.outcome]
  const elements: unknown[] = [
    { tag: 'div', text: markdown(truncate(input.summary, 12_000)) },
  ]
  const answerRows = Object.entries(input.answers ?? {})
  if (answerRows.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: markdown(answerRows.map(([questionId, answer]) => `**${truncate(questionId, 80)}**：${truncate(answer, 500)}`).join('\n')),
    })
  }
  elements.push({
    tag: 'note',
    elements: [{
      tag: 'plain_text',
      content: `操作人：${input.operatorOpenId || '其他入口'} · ${input.resolvedAtIso}`,
    }],
  })
  return card(`${outcome.label} · ${truncate(input.title, 60)}`, elements, outcome.template)
}

export function buildSessionStatusCard(input: {
  projectLabel: string
  sessionTitle: string
  threadId: string
  state: 'idle' | 'running' | 'queued' | 'external'
  queuedCount: number
  collaborationMode?: 'default' | 'plan'
  permissionMode?: 'normal' | 'yolo'
  bindingKey?: string
  requesterOpenId?: string
  webUrl?: string
}): FeishuCard {
  const stateLabel = input.state === 'running'
    ? '运行中'
    : input.state === 'external'
      ? '其他入口运行中'
      : input.state === 'queued' ? '等待中' : '空闲'
  const elements: unknown[] = [{
    tag: 'div',
    fields: [
      { is_short: true, text: markdown(`**项目**\n${truncate(input.projectLabel, 80)}`) },
      { is_short: true, text: markdown(`**状态**\n${stateLabel}`) },
      { is_short: false, text: markdown(`**Session**\n${truncate(input.sessionTitle, 120)}`) },
      { is_short: true, text: markdown(`**排队消息**\n${input.queuedCount}`) },
      { is_short: true, text: markdown(`**模式**\n${input.collaborationMode ?? 'default'}`) },
      { is_short: true, text: markdown(`**权限**\n${(input.permissionMode ?? 'yolo').toUpperCase()}`) },
    ],
  }]
  if (input.webUrl) {
    elements.push({ tag: 'action', actions: [{ tag: 'button', type: 'primary', text: plainText('打开 Session'), url: input.webUrl }] })
  }
  if (input.bindingKey) {
    elements.push({ tag: 'action', actions: [{
      tag: 'button', type: 'default',
      text: plainText(input.permissionMode === 'normal' ? '切换为 YOLO' : '切换为 Normal'),
      value: {
        action: FEISHU_CARD_ACTIONS.setPermissionMode,
        binding_key: input.bindingKey,
        permission_mode: input.permissionMode === 'normal' ? 'yolo' : 'normal',
        requester_open_id: input.requesterOpenId ?? '',
      },
    }] })
  }
  return card('Session 状态', elements, input.state === 'running' || input.state === 'external' ? 'turquoise' : 'blue')
}

export function buildActionProcessingCard(message = '请求已接收，正在处理…'): FeishuCard {
  return card('处理中', [
    { tag: 'div', text: markdown(truncate(message, 1_000)) },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '处理完成后本卡片会自动更新，请勿重复点击。' }] },
  ], 'blue')
}

export function buildActionResultCard(input: {
  title: string
  message: string
  success: boolean
}): FeishuCard {
  return card(input.title, [
    { tag: 'div', text: markdown(truncate(input.message, 12_000)) },
  ], input.success ? 'green' : 'red')
}

export function buildBotHelpCard(input: {
  projectLabel?: string
  sessionTitle?: string
  collaborationMode?: 'default' | 'plan'
  permissionMode?: 'normal' | 'yolo'
}): FeishuCard {
  const status = input.sessionTitle
    ? `当前绑定：**${truncate(input.projectLabel || '未知项目', 80)} / ${truncate(input.sessionTitle, 100)}**`
    : '当前状态：**尚未绑定 Session**'
  return card('CodyWeb 机器人帮助', [
    { tag: 'div', text: markdown(`${status}\n当前模式：**${input.collaborationMode ?? 'default'}**\n当前权限：**${(input.permissionMode ?? 'yolo').toUpperCase()}**`) },
    { tag: 'div', text: markdown([
      '`/project` 选择项目',
      '`/sessions` 查看 Session',
      '`/switch` 切换 Session',
      '`/new` 新建 Session',
      '`/status` 查看状态',
      '`/mode plan|default` 切换对话模式',
      '`/permission yolo|normal` 切换执行权限',
      '`/stop` 停止当前回复',
      '`/answer 请求ID 问题ID 答案` 回答自定义问题',
      '`/rename 新名称` 重命名',
      '`/archive` 归档 Session',
      '`/unbind` 解除绑定',
    ].join('\n')) },
  ], 'blue')
}
