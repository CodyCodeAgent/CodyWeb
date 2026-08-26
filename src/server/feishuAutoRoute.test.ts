import { describe, expect, it } from 'vitest'
import {
  buildFeishuAutoRoutePrompt,
  createFeishuAutoRouteDraft,
  matchesFeishuAutoRoute,
} from './feishuAutoRoute'

describe('Feishu card auto routes', () => {
  const text = `[卡片: 【激励实时对账平台】差异播报]
任务名称：【营销预算】大额发放金额账户重保观测
任务ID：T286478
校验时间：2026-08-26 21:00:39 +08
校验结果：不一致
校验详情：用户自定义函数判定差异`

  it('derives stable labels while excluding dynamic values', () => {
    const draft = createFeishuAutoRouteDraft({
      sourceSenderId: 'ou_alert_bot', sourceSenderType: 'app', messageType: 'interactive', text,
    })
    expect(draft).toMatchObject({
      sourceSenderId: 'ou_alert_bot',
      cardTitle: '【激励实时对账平台】差异播报',
      requiredKeywords: ['任务名称', '任务ID', '校验时间', '校验结果', '校验详情'],
    })
    expect(draft?.fingerprintKey).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('normalizes markdown labels and rejects value-shaped pseudo labels', () => {
    const draft = createFeishuAutoRouteDraft({
      sourceSenderId: 'on_human', sourceSenderType: 'user', messageType: 'interactive',
      text: `[卡片: 【平台】差异播报]\n**任务名称**：示例\n**任务ID**：T1\n(异常1) goeval [不一致]：详情\n数据源sponsor_v2(账本)：延迟`,
    })!
    expect(draft.requiredKeywords).toEqual(['任务名称', '任务ID'])
  })

  it('matches changed card values but rejects another source, title, or schema', () => {
    const draft = createFeishuAutoRouteDraft({
      sourceSenderId: 'ou_alert_bot', sourceSenderType: 'bot', messageType: 'interactive', text,
    })!
    const changed = text.replace('T286478', 'T999999').replace('2026-08-26', '2026-08-27')
    expect(matchesFeishuAutoRoute(draft, {
      sourceSenderId: 'ou_alert_bot', sourceSenderType: 'bot', messageType: 'interactive', text: changed,
    })).toBe(true)
    expect(matchesFeishuAutoRoute(draft, {
      sourceSenderId: 'ou_other_bot', sourceSenderType: 'bot', messageType: 'interactive', text: changed,
    })).toBe(false)
    expect(matchesFeishuAutoRoute(draft, {
      sourceSenderId: 'ou_alert_bot', sourceSenderType: 'bot', messageType: 'interactive', text: changed.replace('校验详情：', '异常详情：'),
    })).toBe(false)
  })

  it('turns a human-forwarded card into a group-scoped any-bot rule', () => {
    const draft = createFeishuAutoRouteDraft({
      sourceSenderId: 'on_human', sourceSenderType: 'user', messageType: 'interactive', text,
    })!
    expect(draft).toMatchObject({ sourceSenderId: '*', sourceSenderType: 'app' })
    expect(matchesFeishuAutoRoute(draft, {
      sourceSenderId: 'on_actual_alert_bot', sourceSenderType: 'bot', messageType: 'interactive', text,
    })).toBe(true)
    expect(matchesFeishuAutoRoute(draft, {
      sourceSenderId: 'on_human', sourceSenderType: 'user', messageType: 'interactive', text,
    })).toBe(false)
  })

  it('builds a bounded, explicit instruction envelope', () => {
    expect(buildFeishuAutoRoutePrompt({ routeName: '差异播报', instruction: '分析根因', cardText: text }))
      .toContain('固定处理指令：分析根因')
  })
})
