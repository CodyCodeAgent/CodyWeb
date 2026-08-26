import { describe, expect, it } from 'vitest'
import { parseFeishuMessage } from './feishuMessageParser'
import { mergeFeishuCardText, resolveFeishuMessage } from './feishuMessageResolver'

function response(items: unknown[]) {
  return { data: { items } }
}

describe('feishuMessageResolver', () => {
  it('uses im.message.get to replace a nonsupport websocket shell', async () => {
    const resolved = await resolveFeishuMessage({
      messageId: 'om_unsupported', messageType: 'nonsupport', content: '{}', mentions: [],
    }, {
      getMessage: async (id, options) => {
        expect(id).toBe('om_unsupported')
        expect(options).toEqual({ userCardContent: true })
        return response([{ message_id: id, msg_type: 'post', mentions: [{ key: '@_user_1', name: 'Mia', id: 'ou_mia', id_type: 'open_id' }], body: { content: JSON.stringify({ zh_cn: { title: '需求', content: [[{ tag: 'text', text: '补齐内容' }]] } }) } }])
      },
      limits: { resolveQuote: false },
    })

    expect(resolved.messageType).toBe('post')
    expect(resolved.resolution.fetched).toBe(true)
    expect(parseFeishuMessage(resolved).text).toBe('需求\n补齐内容')
    expect(resolved.mentions).toEqual([expect.objectContaining({ name: 'Mia' })])
  })

  it('requests both interactive views concurrently and retains local user_dsl when REST is incomplete', async () => {
    const localCard = { user_dsl: JSON.stringify({ header: { title: { content: '本地标题' } }, body: { elements: [{ tag: 'markdown', content: '本地详情' }] } }) }
    const calls: Array<boolean | undefined> = []
    const resolved = await resolveFeishuMessage({
      messageId: 'om_card', messageType: 'interactive', content: JSON.stringify(localCard),
    }, {
      getMessage: async (_id, options) => {
        calls.push(options?.userCardContent)
        if (options?.userCardContent) return response([{ message_id: 'om_card', msg_type: 'interactive', body: { content: JSON.stringify({ header: { title: { content: 'REST 标题' } }, body: { elements: [{ tag: 'markdown', content: '完整字段' }, { tag: 'img', img_key: 'img_card' }] } }) } }])
        return response([{ message_id: 'om_card', msg_type: 'interactive', body: { content: JSON.stringify({ title: '简化标题', elements: [[{ tag: 'text', text: '服务端补充字段' }]] }) } }])
      },
      limits: { resolveQuote: false },
    })

    expect(calls.sort()).toEqual([false, true])
    const parsed = parseFeishuMessage(resolved)
    expect(parsed.text).toContain('完整字段')
    expect(parsed.text).toContain('服务端补充字段')
    expect(parsed.resources).toEqual([{ type: 'image', key: 'img_card', name: 'img_card.jpg' }])
    expect(resolved.resolution.interactiveViews).toEqual({ simplified: true, userCardContent: true })
  })

  it('does not discard user_dsl when both interactive REST views fail', async () => {
    const card = { user_dsl: JSON.stringify({ header: { title: { content: '保底卡片' } }, body: { elements: [{ tag: 'markdown', content: '这段不能丢' }] } }) }
    const resolved = await resolveFeishuMessage({ messageId: 'om_card', messageType: 'interactive', content: JSON.stringify(card) }, {
      getMessage: async () => { throw new Error('cross tenant') },
      limits: { resolveQuote: false },
    })
    expect(parseFeishuMessage(resolved).text).toContain('这段不能丢')
    expect(resolved.resolution.fetched).toBe(false)
  })

  it('builds a bounded depth-first merge-forward view and uses the outer message id for resources', async () => {
    const resolver = async (id: string, options?: { userCardContent?: boolean }) => {
      if (id === 'om_forward') {
        expect(options).toEqual({ userCardContent: false })
        return response([
          { message_id: 'om_forward', msg_type: 'merge_forward', body: { content: '{}' } },
          { message_id: 'om_a', upper_message_id: 'om_forward', msg_type: 'text', sender: { sender_name: 'Alice' }, body: { content: JSON.stringify({ text: '第一条' }) } },
          { message_id: 'om_nested', upper_message_id: 'om_forward', msg_type: 'merge_forward', body: { content: '{}' } },
          { message_id: 'om_img', upper_message_id: 'om_nested', msg_type: 'image', sender: { sender_name: 'Bob' }, body: { content: JSON.stringify({ image_key: 'img_forward' }) } },
          { message_id: 'om_card', upper_message_id: 'om_forward', msg_type: 'interactive', sender: { sender_name: 'Cathy' }, body: { content: JSON.stringify({ title: '卡片', elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]] }) } },
        ])
      }
      if (id === 'om_card' && options?.userCardContent) {
        return response([{ message_id: id, msg_type: 'interactive', body: { content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: '卡片真实内容' }] } }) } }])
      }
      if (id === 'om_card') throw new Error('simplified should not matter')
      throw new Error(`unexpected ${id}`)
    }
    const resolved = await resolveFeishuMessage({ messageId: 'om_forward', messageType: 'merge_forward', content: '{}' }, {
      getMessage: resolver,
      limits: { resolveQuote: false },
    })
    const parsed = parseFeishuMessage(resolved)
    expect(parsed.text).toContain('Alice: 第一条')
    expect(parsed.text).toContain('Bob: [图片 1]')
    expect(parsed.text).toContain('Cathy: 卡片真实内容')
    expect(parsed.resources).toEqual([{ type: 'image', key: 'img_forward', name: 'img_forward.jpg', messageId: 'om_forward' }])
    expect(resolved.resolution.mergeForward).toMatchObject({ nodeCount: 3, truncated: false })
  })

  it('preserves an honest cross-tenant fallback and enforces forward limits', async () => {
    const resolved = await resolveFeishuMessage({ messageId: 'om_forward', messageType: 'merge_forward', content: '{}' }, {
      getMessage: async (id, options) => {
        if (id === 'om_forward') return response([
          { message_id: 'om_card', upper_message_id: 'om_forward', msg_type: 'interactive', body: { content: JSON.stringify({ title: 'x', elements: [[{ tag: 'text', text: '请升级至最新版本客户端' }]] }) } },
          { message_id: 'om_2', upper_message_id: 'om_forward', msg_type: 'text', body: { content: JSON.stringify({ text: '第二条' }) } },
        ])
        if (options?.userCardContent) throw new Error('232010 cross tenant')
        throw new Error('no access')
      },
      limits: { resolveQuote: false, maxForwardNodes: 1 },
    })
    expect(parseFeishuMessage(resolved).text).toContain('可能来自外部租户或无权限')
    expect(resolved.resolution.mergeForward).toMatchObject({ nodeCount: 1, truncated: true })
  })

  it('resolves a bounded quoted parent and leaves an explicit id hint if it is inaccessible', async () => {
    const calls: string[] = []
    const base = { messageId: 'om_new', messageType: 'text', content: JSON.stringify({ text: '继续' }), parentId: 'om_quote', rootId: 'om_root' }
    const resolved = await resolveFeishuMessage(base, {
      getMessage: async (id) => {
        calls.push(id)
        return response([{ message_id: id, msg_type: 'file', body: { content: JSON.stringify({ file_key: 'file_quote', file_name: 'brief.md' }) } }])
      },
    })
    expect(calls).toEqual(['om_quote'])
    expect(resolved.quote).toMatchObject({ status: 'resolved', messageId: 'om_quote', text: '[文件 1: brief.md]' })

    const unavailable = await resolveFeishuMessage(base, { getMessage: async () => { throw new Error('deleted') } })
    expect(unavailable.quote).toMatchObject({ status: 'unavailable', messageId: 'om_quote' })
  })

  it('resolves both views of an interactive quoted parent', async () => {
    const resolved = await resolveFeishuMessage({
      messageId: 'om_new', messageType: 'text', content: JSON.stringify({ text: '继续' }), parentId: 'om_card',
    }, {
      getMessage: async (_id, options) => response([{
        message_id: 'om_card', msg_type: 'interactive',
        sender: { sender_type: 'app', sender_id: { open_id: 'ou_scoped_alert', union_id: 'on_alert_bot' }, sender_name: 'Alert Bot' },
        body: { content: options?.userCardContent
          ? JSON.stringify({ header: { title: { content: '发布审批' } }, elements: [{ tag: 'markdown', content: '状态：待确认' }] })
          : JSON.stringify({ title: '审批摘要', elements: [[{ tag: 'text', text: '审批卡片摘要' }]] }) },
      }]),
    })

    expect(resolved.quote).toMatchObject({
      status: 'resolved', messageType: 'interactive', senderId: 'on_alert_bot', senderType: 'app', senderName: 'Alert Bot',
    })
    expect(resolved.quote?.text).toContain('发布审批')
    expect(resolved.quote?.text).toContain('审批卡片摘要')
  })

  it('merges unique card lines without echoing duplicate content', () => {
    expect(mergeFeishuCardText('[卡片: 告警]\n负责人: Alice\n请升级至最新版本客户端', '[卡片: 告警]\n状态: 处理中'))
      .toContain('负责人: Alice')
    expect(mergeFeishuCardText('[卡片: 告警]\n负责人: Alice', '[卡片: 告警]\n负责人: Alice').split('\n'))
      .toHaveLength(2)
  })
})
