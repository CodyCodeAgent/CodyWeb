import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import type { LocalMessageOutboxItem } from './localMessageOutbox'
import { recoverOutboxItemAfterReload, selectReconciledOutboxItems, UNKNOWN_OUTBOX_DELIVERY_ERROR } from './outboxReconciliation'

function item(id: string, turnId = 'turn-1'): LocalMessageOutboxItem {
  return {
    id, threadId: 'thread-1', turnId, text: 'same prompt', images: [], skills: [],
    status: 'sending', attempts: 1,
    createdAtIso: `2026-09-01T00:00:0${id.endsWith('2') ? '2' : '1'}.000Z`,
    updatedAtIso: '2026-09-01T00:00:03.000Z',
  }
}

describe('selectReconciledOutboxItems', () => {
  it('never auto-requeues an unfinished command after reload', () => {
    const queued = { ...item('queued'), status: 'queued' as const, turnId: undefined }
    const unknownSending = { ...item('sending'), turnId: undefined }
    const boundSending = item('bound', 'turn-9')
    const updatedAtIso = '2026-09-01T00:01:00.000Z'

    expect(recoverOutboxItemAfterReload(queued, updatedAtIso)).toMatchObject({
      status: 'failed', lastError: UNKNOWN_OUTBOX_DELIVERY_ERROR, updatedAtIso,
    })
    expect(recoverOutboxItemAfterReload(unknownSending, updatedAtIso)).toMatchObject({
      status: 'failed', lastError: UNKNOWN_OUTBOX_DELIVERY_ERROR, updatedAtIso,
    })
    expect(recoverOutboxItemAfterReload(boundSending, updatedAtIso)).toBe(boundSending)
  })

  it('never lets an optimistic row acknowledge its own durable outbox item', () => {
    const optimistic: UiMessage = {
      id: 'user:command-1', role: 'user', text: 'same prompt',
      messageType: 'userMessage.optimistic', turnId: 'turn-1',
    }
    expect(selectReconciledOutboxItems([item('command-1')], [optimistic])).toEqual([])
  })

  it('consumes identical queued prompts one occurrence at a time', () => {
    const native: UiMessage = { id: 'user:native-1', role: 'user', text: 'same prompt', turnId: 'turn-1' }
    expect(selectReconciledOutboxItems([item('command-1'), item('command-2')], [native]).map(row => row.id)).toEqual(['command-1'])
  })

  it('uses the client command identity before text or shared steer Turn identity', () => {
    const native: UiMessage = { id: 'user:command-2', role: 'user', text: 'same prompt', turnId: 'turn-1' }
    expect(selectReconciledOutboxItems([item('command-1'), item('command-2')], [native]).map(row => row.id)).toEqual(['command-2'])
  })
})
