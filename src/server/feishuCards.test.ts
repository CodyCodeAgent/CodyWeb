import { describe, expect, it } from 'vitest'
import {
  FEISHU_CARD_ACTIONS,
  buildAccessRequestCard,
  buildApprovalCard,
  buildAutoRouteCreatedCard,
  buildBotHelpCard,
  buildProjectSelectionCard,
  buildResolvedRequestCard,
  buildResolvedAccessRequestCard,
  buildSessionSelectionCard,
  buildSessionStatusCard,
  buildStreamingReplyCard,
  buildUserInputCard,
} from './feishuCards'

describe('Feishu cards', () => {
  it('documents explicit card routing in help', () => {
    expect(JSON.stringify(buildBotHelpCard({}))).toContain('/route [处理说明]')
  })

  it('builds the project to session binding flow with namespaced actions', () => {
    const projectCard = buildProjectSelectionCard({
      bindingKey: 'bot:group:chat:chat',
      projects: [{ projectKey: '/repo', cwd: '/repo', label: 'CodyWeb', sessionCount: 2 }],
    })
    expect(JSON.stringify(projectCard)).toContain(FEISHU_CARD_ACTIONS.selectProject)
    expect(JSON.stringify(projectCard)).toContain('CodyWeb')

    const sessionCard = buildSessionSelectionCard({
      bindingKey: 'bot:group:chat:chat',
      project: { projectKey: '/repo', cwd: '/repo', label: 'CodyWeb', sessionCount: 2 },
      sessions: [{ threadId: 'thread-1', title: 'Fix scrolling' }],
      autoRoute: { cardTitle: 'Alert', requiredKeywords: ['Task ID'] },
      scenarioPackages: [{
        id: 'scenario-alert', title: 'Alert triage', description: 'Investigate alerts', primarySkillName: 'Incident triage',
      }],
    })
    expect(JSON.stringify(sessionCard)).toContain(FEISHU_CARD_ACTIONS.selectSession)
    expect(JSON.stringify(sessionCard)).toContain(FEISHU_CARD_ACTIONS.newSession)
    expect(JSON.stringify(sessionCard)).toContain('thread-1')
    expect(JSON.stringify(sessionCard)).toContain('/repo')
    expect(JSON.stringify(sessionCard)).toContain(FEISHU_CARD_ACTIONS.selectScenarioPackage)
    expect(JSON.stringify(sessionCard)).toContain('Alert triage · Incident triage')
  })

  it('disambiguates duplicate project and Session labels', () => {
    const projectCard = JSON.stringify(buildProjectSelectionCard({
      bindingKey: 'bot:p2p:chat:chat',
      projects: [
        { projectKey: '/home/code/repo', cwd: '/home/code/repo', label: 'repo', sessionCount: 2 },
        { projectKey: '/data/code/repo', cwd: '/data/code/repo', label: 'repo', sessionCount: 1 },
      ],
    }))
    expect(projectCard).toContain('repo · /home/code/repo')
    expect(projectCard).toContain('repo · /data/code/repo')

    const sessionCard = JSON.stringify(buildSessionSelectionCard({
      bindingKey: 'bot:p2p:chat:chat',
      project: { projectKey: '/home/code/repo', cwd: '/home/code/repo', label: 'repo', sessionCount: 2 },
      sessions: [
        { threadId: 'thread-a123', title: 'Same title' },
        { threadId: 'thread-b456', title: 'Same title' },
      ],
    }))
    expect(sessionCard).toContain('Same title · thread-a')
    expect(sessionCard).toContain('Same title · thread-b')
  })

  it('describes card routes as matching content regardless of sender', () => {
    const projectCard = JSON.stringify(buildProjectSelectionCard({
      bindingKey: 'bot:group:chat:auto-route',
      projects: [{ projectKey: '/repo', cwd: '/repo', label: 'repo', sessionCount: 1 }],
      autoRoute: { cardTitle: 'Alert', requiredKeywords: ['Task ID'], sourceSenderId: '*' },
    }))
    expect(projectCard).toContain('不限制发送者')

    const createdCard = JSON.stringify(buildAutoRouteCreatedCard({
      routeName: 'Alert', projectLabel: 'repo', sessionTitle: 'Alerts', cardTitle: 'Alert',
      requiredKeywords: ['Task ID'], sourceSenderId: '*',
    }))
    expect(createdCard).toContain('无论由谁发送')
  })

  it('builds patchable stream states and approval actions', () => {
    expect(JSON.stringify(buildStreamingReplyCard({ state: 'running', content: 'partial answer' }))).toContain('partial answer')
    expect(JSON.stringify(buildStreamingReplyCard({ state: 'failed', error: 'network failed' }))).toContain('network failed')

    const approval = JSON.stringify(buildApprovalCard({
      bindingKey: 'binding-1', requestId: '42', title: 'Run command', summary: 'npm test', requesterOpenId: 'ou_user',
    }))
    expect(approval).toContain(FEISHU_CARD_ACTIONS.approve)
    expect(approval).toContain(FEISHU_CARD_ACTIONS.deny)
    expect(approval).toContain('42')
  })

  it('renders completed Markdown as a content-first card with a native paginated table', () => {
    const result = buildStreamingReplyCard({
      state: 'completed',
      content: '# Result\n\n| ID | Status |\n| --- | --- |\n| 42 | **done** |\n| 43 | queued |',
      projectLabel: 'Repo',
      sessionTitle: 'Table polish',
      webUrl: 'https://cody.example/thread/1',
    }) as Record<string, any>

    expect(result.schema).toBe('2.0')
    expect(result.header).toBeUndefined()
    expect(result.body.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'markdown', content: '**Result**' }),
      expect.objectContaining({
        tag: 'table',
        page_size: 2,
        columns: [
          expect.objectContaining({ display_name: 'ID', data_type: 'lark_md' }),
          expect.objectContaining({ display_name: 'Status', data_type: 'lark_md' }),
        ],
        rows: [{ c0: '42', c1: '**done**' }, { c0: '43', c1: 'queued' }],
      }),
    ]))
    expect(JSON.stringify(result)).toContain('Repo · Table polish')
    expect(JSON.stringify(result)).toContain('打开 Session')
  })

  it('keeps status chrome while a reply is running and preserves fenced code', () => {
    const result = buildStreamingReplyCard({
      state: 'running',
      content: 'Before\n\n```ts\nconst answer = 42\n```\n\nAfter',
    }) as Record<string, any>

    expect(result.schema).toBe('2.0')
    expect(result.header.title.content).toContain('Codex 正在处理')
    expect(JSON.stringify(result.body.elements)).toContain('```ts\\nconst answer = 42\\n```')
  })

  it('preserves uploaded images when a long reply is truncated', () => {
    const result = JSON.stringify(buildStreamingReplyCard({
      state: 'completed',
      content: `${'A'.repeat(25_000)}\n\n![Diagram](img_v2_keep_me)`,
    }))
    expect(result).toContain('…')
    expect(result).toContain('"tag":"img"')
    expect(result).toContain('"img_key":"img_v2_keep_me"')
  })

  it('builds a narrow user-access request and freezes the result', () => {
    const request = JSON.stringify(buildAccessRequestCard({
      requesterOpenId: 'ou_guest', chatId: 'oc_team', chatType: 'group',
      requestToken: 'signed-request-token',
    }))
    expect(request).toContain(FEISHU_CARD_ACTIONS.grantAccess)
    expect(request).toContain(FEISHU_CARD_ACTIONS.denyAccess)
    expect(request).toContain('ou_guest')
    expect(request).toContain('signed-request-token')
    expect(request).toContain('不会开启全员访问')

    const resolved = JSON.stringify(buildResolvedAccessRequestCard({
      requesterOpenId: 'ou_guest', granted: true, operatorOpenId: 'ou_owner',
      resolvedAtIso: '2026-07-19T00:00:00.000Z',
    }))
    expect(resolved).toContain('已允许访问')
    expect(resolved).not.toContain('cody_feishu_')
  })

  it('builds a stateful user-input card and a frozen resolved state', () => {
    const inputCard = JSON.stringify(buildUserInputCard({
      bindingKey: 'binding-1',
      requestId: '77',
      requesterOpenId: 'ou_user',
      questions: [{
        id: 'size', header: 'Size', question: 'Choose a size', isOther: false, isSecret: false,
        options: [{ label: 'Small', description: 'Fast' }, { label: 'Large', description: 'Thorough' }],
      }],
      selections: { size: 'Large' },
    }))
    expect(inputCard).toContain(FEISHU_CARD_ACTIONS.userInputToggle)
    expect(inputCard).toContain(FEISHU_CARD_ACTIONS.userInputSubmit)
    expect(inputCard).toContain('● Large')

    const customCard = JSON.stringify(buildUserInputCard({
      bindingKey: 'binding-1', requestId: '78', requesterOpenId: 'ou_user',
      questions: [{ id: 'note', header: 'Note', question: 'Add context', isOther: true, isSecret: false, options: [] }],
      selections: { note: 'Keep the migration reversible' },
    }))
    expect(customCard).toContain('/answer 78 note')
    expect(customCard).toContain('Keep the migration reversible')

    const resolved = JSON.stringify(buildResolvedRequestCard({
      title: 'Size', summary: 'Choose a size', outcome: 'answered', operatorOpenId: 'ou_user',
      resolvedAtIso: '2026-07-18T00:00:00.000Z', answers: { Size: 'Large' },
    }))
    expect(resolved).toContain('已提交答案')
    expect(resolved).not.toContain('cody_feishu_')
  })

  it('builds a compact session status card', () => {
    const status = JSON.stringify(buildSessionStatusCard({
      projectLabel: 'Repo', sessionTitle: 'Current', threadId: 'thread-1', state: 'running', queuedCount: 2,
      bindingKey: 'binding-1', requesterOpenId: 'ou_user',
    }))
    expect(status).toContain('运行中')
    expect(status).toContain('排队消息')
    expect(status).toContain('2')
    expect(status).toContain('YOLO')
    expect(status).toContain('cody_feishu_set_permission_mode')
  })
})
