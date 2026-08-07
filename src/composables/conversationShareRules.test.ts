import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { buildConversationShareMessages, buildConversationShareTurns } from './conversationShareRules'

function message(input: Partial<UiMessage> & Pick<UiMessage, 'id' | 'role'>): UiMessage {
  return { text: '', ...input }
}

describe('conversation share rules', () => {
  it('groups complete turns and omits receipts and context compaction', () => {
    const turns = buildConversationShareTurns([
      message({ id: 'u1', turnId: 'turn-1', role: 'user', text: 'Why is this failing?' }),
      message({ id: 'tool-1', turnId: 'turn-1', role: 'system', tool: { kind: 'command', title: 'Test', status: 'completed', summary: 'Passed', details: [] } }),
      message({ id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'The input is invalid.' }),
      message({ id: 'done-1', turnId: 'turn-1', role: 'system', text: 'Answered', messageType: 'worked' }),
      message({ id: 'compact', turnId: 'turn-2', role: 'system', tool: { kind: 'context', title: 'Context', status: 'completed', summary: '', details: [] } }),
      message({ id: 'u2', turnId: 'turn-2', role: 'user', text: 'Fix it.' }),
      message({ id: 'a2', turnId: 'turn-2', role: 'assistant', text: 'Fixed.' }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ id: 'turn-1', userPreview: 'Why is this failing?', assistantPreview: 'The input is invalid.', hasToolDetails: true })
    expect(turns[0]?.messages.map((row) => row.id)).toEqual(['u1', 'tool-1', 'a1'])
    expect(turns[1]?.messages.map((row) => row.id)).toEqual(['u2', 'a2'])
  })

  it('builds a snapshot from non-contiguous selected turns and keeps tools optional', () => {
    const turns = buildConversationShareTurns([
      message({ id: 'u1', turnId: 'turn-1', role: 'user', text: 'One' }),
      message({ id: 'tool-1', turnId: 'turn-1', role: 'system', tool: { kind: 'command', title: 'pwd', status: 'completed', summary: '/repo', details: ['/repo'] } }),
      message({ id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'First answer' }),
      message({ id: 'u2', turnId: 'turn-2', role: 'user', text: 'Two' }),
      message({ id: 'a2', turnId: 'turn-2', role: 'assistant', text: 'Second answer' }),
      message({ id: 'u3', turnId: 'turn-3', role: 'user', text: 'Three' }),
      message({ id: 'a3', turnId: 'turn-3', role: 'assistant', text: 'Third answer' }),
    ])

    expect(buildConversationShareMessages(turns, new Set(['turn-1', 'turn-3']), false).map((row) => row.id))
      .toEqual(['u1', 'a1', 'u3', 'a3'])
    expect(buildConversationShareMessages(turns, new Set(['turn-1']), true).map((row) => row.id))
      .toEqual(['u1', 'tool-1', 'a1'])
  })
})
