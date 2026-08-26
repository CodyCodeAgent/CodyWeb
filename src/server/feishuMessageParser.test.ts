import { describe, expect, it } from 'vitest'
import {
  extractFeishuCardText,
  normalizeFeishuMention,
  parseFeishuMessage,
  unwrapFeishuUserDsl,
} from './feishuMessageParser'

describe('feishuMessageParser', () => {
  it('normalizes websocket and REST mention shapes and removes only the bot mention', () => {
    expect(normalizeFeishuMention({ id: 'ou_rest', id_type: 'open_id' })).toMatchObject({ openId: 'ou_rest' })
    const parsed = parseFeishuMessage({
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我和 @_user_2 看一下' }),
      mentions: [
        { key: '@_user_1', name: 'Cody', id: { open_id: 'ou_bot', union_id: 'on_bot' } },
        { key: '@_user_2', name: '小明', id: 'ou_user', id_type: 'open_id' },
      ],
    }, { botOpenId: 'ou_bot' })

    expect(parsed.text).toBe('帮我和 @小明 看一下')
    expect(parsed.explicitlyMentioned).toBe(true)
    expect(parsed.mentions).toEqual([
      expect.objectContaining({ name: 'Cody', openId: 'ou_bot', unionId: 'on_bot' }),
      expect.objectContaining({ name: '小明', openId: 'ou_user' }),
    ])
  })

  it('recognizes and removes the current bot when Feishu sends an app_id mention', () => {
    const parsed = parseFeishuMessage({
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我排查' }),
      mentions: [{ key: '@_user_1', name: 'Cody', id: 'cli_cody', id_type: 'app_id' }],
    }, { botAppId: 'cli_cody' })

    expect(parsed.explicitlyMentioned).toBe(true)
    expect(parsed.text).toBe('帮我排查')
    expect(parsed.mentions).toEqual([expect.objectContaining({ appId: 'cli_cody' })])
  })

  it('renders localized post/rich-text nodes, code blocks, links and resources', () => {
    const parsed = parseFeishuMessage({
      messageType: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '排查请求',
          content: [
            [
              { tag: 'at', user_id: 'ou_bot', user_name: 'Cody' },
              { tag: 'text', text: ' 请看 ' },
              { tag: 'a', text: '日志', href: 'https://example.com/log' },
            ],
            [{ tag: 'code_block', language: 'ts', text: 'const a = 1\n' }],
            [
              { tag: 'img', image_key: 'img_1' },
              { tag: 'file', file_key: 'file_1', file_name: 'report.txt' },
            ],
          ],
        },
      }),
    }, { botOpenId: 'ou_bot' })

    expect(parsed.explicitlyMentioned).toBe(true)
    expect(parsed.text).toContain('排查请求\n请看 日志')
    expect(parsed.text).toContain('```ts\nconst a = 1\n```')
    expect(parsed.text).toContain('[图片 1]')
    expect(parsed.text).toContain('[文件 1: report.txt]')
    expect(parsed.resources).toEqual([
      { type: 'image', key: 'img_1', name: 'img_1.jpg' },
      { type: 'file', key: 'file_1', name: 'report.txt' },
    ])
  })

  it.each([
    ['image', { image_key: 'img_a' }, '[图片 1]', { type: 'image', key: 'img_a', name: 'img_a.jpg' }],
    ['file', { file_key: 'file_a', file_name: 'a.zip' }, '[文件 1: a.zip]', { type: 'file', key: 'file_a', name: 'a.zip' }],
    ['audio', { file_key: 'audio_a' }, '[音频 1]', { type: 'audio', key: 'audio_a', name: 'audio_a.opus' }],
    ['sticker', { file_key: 'sticker_a' }, '[表情 1]', { type: 'sticker', key: 'sticker_a', name: 'sticker_a' }],
  ])('parses %s resource messages', (messageType, content, text, resource) => {
    const parsed = parseFeishuMessage({ messageType, content })
    expect(parsed.text).toBe(text)
    expect(parsed.resources).toEqual([resource])
  })

  it('extracts both the video and its preview from a media message', () => {
    const parsed = parseFeishuMessage({
      messageType: 'media',
      content: { file_key: 'video_1', file_name: 'demo.mp4', image_key: 'cover_1' },
    })
    expect(parsed.text).toBe('[视频 1: demo.mp4] [图片 1]')
    expect(parsed.resources).toEqual([
      { type: 'media', key: 'video_1', name: 'demo.mp4' },
      { type: 'image', key: 'cover_1', name: 'cover_1.jpg' },
    ])
  })

  it('unwraps user_dsl and recursively traverses v2 cards', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '审批提醒' } },
      body: {
        elements: [
          { tag: 'markdown', content: '**需要确认**' },
          { tag: 'div', fields: [{ is_short: true, text: { tag: 'lark_md', content: '项目: Cody' } }] },
          {
            tag: 'column_set',
            columns: [{ elements: [{ tag: 'img', img_key: 'card_img', alt: { content: '运行截图' } }] }],
          },
          {
            tag: 'action',
            actions: [
              { tag: 'button', text: { content: '打开详情' }, behaviors: [{ type: 'open_url', pc_url: 'https://example.com' }] },
              { tag: 'select_static', placeholder: { content: '请选择' }, options: [{ text: { content: '同意' } }, { text: { content: '拒绝' } }] },
            ],
          },
        ],
      },
    }
    const raw = JSON.stringify({ user_dsl: JSON.stringify(card) })
    expect(unwrapFeishuUserDsl(raw)).not.toBeNull()
    const parsed = parseFeishuMessage({ messageType: 'interactive', content: raw })

    expect(parsed.userDslUnwrapped).toBe(true)
    expect(parsed.text).toContain('[卡片: 审批提醒]')
    expect(parsed.text).toContain('**需要确认**')
    expect(parsed.text).toContain('项目: Cody')
    expect(parsed.text).toContain('[图片 1: 运行截图]')
    expect(parsed.text).toContain('[打开详情](https://example.com)')
    expect(parsed.text).toContain('[下拉: 请选择 | 选项: 同意 / 拒绝]')
    expect(parsed.resources).toEqual([{ type: 'image', key: 'card_img', name: 'card_img.jpg' }])
  })

  it('handles server-simplified interactive card paragraphs', () => {
    const text = extractFeishuCardText(JSON.stringify({
      title: '告警',
      elements: [[
        { tag: 'text', text: 'CPU 过高 ' },
        { tag: 'a', text: '详情', href: 'https://example.com/alarm' },
        { tag: 'img', image_key: 'img_alarm' },
      ]],
    }))
    expect(text).toContain('[卡片: 告警]')
    expect(text).toContain('CPU 过高')
    expect(text).toContain('详情(https://example.com/alarm)')
    expect(text).toContain('[图片 1]')
  })

  it('renders expanded merge-forward items and carries child resource message ids', () => {
    const parsed = parseFeishuMessage({
      messageType: 'merge_forward',
      content: {
        items: [
          { message_id: 'om_text', msg_type: 'text', sender: { sender_name: 'Alice' }, body: { content: JSON.stringify({ text: 'hello' }) } },
          { message_id: 'om_image', msg_type: 'image', sender: { sender_name: 'Bob' }, body: { content: JSON.stringify({ image_key: 'img_forward' }) } },
        ],
      },
    })
    expect(parsed.text).toBe('[合并转发消息]\nAlice: hello\nBob: [图片 1]')
    expect(parsed.resources).toEqual([{ type: 'image', key: 'img_forward', name: 'img_forward.jpg', messageId: 'om_image' }])
  })

  it('parses share-chat and preserves a safe fallback for unknown types', () => {
    expect(parseFeishuMessage({ messageType: 'share_chat', content: { chat_id: 'oc_1', name: '研发群' } }).text)
      .toBe('[群聊分享: 研发群 (oc_1)]')
    expect(parseFeishuMessage({ messageType: 'location', content: { text: '北京' } }).text).toBe('北京')
  })

  it('adds a quote hint but ignores parent ids used only as thread plumbing', () => {
    expect(parseFeishuMessage({
      messageType: 'text', messageId: 'om_new', parentId: 'om_quote', rootId: 'om_root',
      content: { text: '继续修改' },
    })).toMatchObject({
      text: '[用户引用了飞书消息 om_quote]\n继续修改',
      quotedMessageId: 'om_quote',
    })
    expect(parseFeishuMessage({
      messageType: 'text', messageId: 'om_new', parentId: 'om_root', rootId: 'om_root', threadId: 'omt_thread',
      content: { text: '普通话题回复' },
    }).text).toBe('普通话题回复')
    expect(parseFeishuMessage({
      messageType: 'text', messageId: 'om_new', parentId: 'om_quote', rootId: 'om_quote',
      content: { text: '普通群引用回复' },
    })).toMatchObject({
      text: '[用户引用了飞书消息 om_quote]\n普通群引用回复',
      quotedMessageId: 'om_quote',
    })
  })
})
