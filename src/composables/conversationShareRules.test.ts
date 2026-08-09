import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { buildConversationShareItems, buildConversationShareMessages } from './conversationShareRules'

function message(input: Partial<UiMessage> & Pick<UiMessage, 'id' | 'role'>): UiMessage {
  return { text: '', ...input }
}

describe('conversation share rules', () => {
  it('builds individually selectable messages and omits receipts and context compaction', () => {
    const items = buildConversationShareItems([
      message({ id: 'u1', turnId: 'turn-1', role: 'user', text: 'Why is this failing?' }),
      message({ id: 'tool-1', turnId: 'turn-1', role: 'system', tool: { kind: 'command', title: 'Test', status: 'completed', summary: 'Passed', details: [] } }),
      message({ id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'The input is invalid.' }),
      message({ id: 'done-1', turnId: 'turn-1', role: 'system', text: 'Answered', messageType: 'worked' }),
      message({ id: 'compact', turnId: 'turn-2', role: 'system', tool: { kind: 'context', title: 'Context', status: 'completed', summary: '', details: [] } }),
      message({ id: 'u2', turnId: 'turn-2', role: 'user', text: 'Fix it.' }),
      message({ id: 'a2', turnId: 'turn-2', role: 'assistant', text: 'Fixed.' }),
    ])

    expect(items.map((item) => item.id)).toEqual(['u1', 'tool-1', 'a1', 'u2', 'a2'])
    expect(items[0]).toMatchObject({ id: 'u1', turnId: 'turn-1', preview: 'Why is this failing?', hasToolDetails: false })
    expect(items[1]).toMatchObject({ id: 'tool-1', turnId: 'turn-1', hasToolDetails: true })
  })

  it('builds a snapshot from non-contiguous selected messages and keeps tools optional', () => {
    const items = buildConversationShareItems([
      message({ id: 'u1', turnId: 'turn-1', role: 'user', text: 'One' }),
      message({ id: 'tool-1', turnId: 'turn-1', role: 'system', tool: { kind: 'command', title: 'pwd', status: 'completed', summary: '/repo', details: ['/repo'] } }),
      message({ id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'First answer' }),
      message({ id: 'u2', turnId: 'turn-2', role: 'user', text: 'Two' }),
      message({ id: 'a2', turnId: 'turn-2', role: 'assistant', text: 'Second answer' }),
      message({ id: 'u3', turnId: 'turn-3', role: 'user', text: 'Three' }),
      message({ id: 'a3', turnId: 'turn-3', role: 'assistant', text: 'Third answer' }),
    ])

    expect(buildConversationShareMessages(items, new Set(['u1', 'a2', 'u3']), false).map((row) => row.id))
      .toEqual(['u1', 'a2', 'u3'])
    expect(buildConversationShareMessages(items, new Set(['tool-1']), true).map((row) => row.id))
      .toEqual(['tool-1'])
  })
})
