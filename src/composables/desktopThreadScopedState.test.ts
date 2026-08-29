import { describe, expect, it } from 'vitest'
import {
  markThreadMessagesLoaded,
  markThreadResumed,
  pruneDesktopThreadScopedState,
  setThreadLoadedVersion,
  shouldShowMessagesLoading,
  type DesktopThreadScopedState,
} from './desktopThreadScopedState'

function state(): DesktopThreadScopedState {
  return {
    readStateByThreadId: { keep: 'read', drop: 'read' },
    scrollStateByThreadId: {
      keep: { scrollTop: 10, isAtBottom: false },
      drop: { scrollTop: 20, isAtBottom: true },
    },
    loadedMessagesByThreadId: { keep: true, drop: true },
    loadedVersionByThreadId: { keep: 'v1', drop: 'v2' },
    resumedThreadById: { keep: true, drop: true },
    persistedMessagesByThreadId: { keep: [], drop: [] },
    turnActivityByThreadId: { keep: { label: 'Thinking', details: [] }, drop: { label: 'Writing', details: [] } },
    turnErrorByThreadId: { keep: { message: 'still here' }, drop: { message: 'stale' } },
    eventUnreadByThreadId: { keep: true, drop: true },
    inProgressById: { keep: true, drop: true },
    pendingServerRequestsByThreadId: {
      keep: [{ id: 1, method: 'server/request', threadId: 'keep', turnId: '', itemId: '', receivedAtIso: '', params: {} }],
      drop: [{ id: 2, method: 'server/request', threadId: 'drop', turnId: '', itemId: '', receivedAtIso: '', params: {} }],
    },
  }
}

describe('desktopThreadScopedState', () => {
  it('derives message loading state from loaded and silent flags', () => {
    expect(shouldShowMessagesLoading({
      loadedMessagesByThreadId: {},
      threadId: 'thread-1',
      silent: false,
    })).toBe(true)
    expect(shouldShowMessagesLoading({
      loadedMessagesByThreadId: { 'thread-1': true },
      threadId: 'thread-1',
      silent: false,
    })).toBe(false)
    expect(shouldShowMessagesLoading({
      loadedMessagesByThreadId: {},
      threadId: 'thread-1',
      silent: true,
    })).toBe(false)
    expect(shouldShowMessagesLoading({
      loadedMessagesByThreadId: {},
      threadId: '',
      silent: false,
    })).toBe(false)
  })

  it('updates thread scoped load markers without churn', () => {
    const loaded = { 'thread-1': true }
    const resumed = { 'thread-1': true }
    const versions = { 'thread-1': 'v1' }

    expect(markThreadMessagesLoaded(loaded, 'thread-1')).toBe(loaded)
    expect(markThreadMessagesLoaded(loaded, 'thread-2')).toEqual({
      'thread-1': true,
      'thread-2': true,
    })
    expect(markThreadMessagesLoaded(loaded, '')).toBe(loaded)

    expect(markThreadResumed(resumed, 'thread-1')).toBe(resumed)
    expect(markThreadResumed(resumed, 'thread-2')).toEqual({
      'thread-1': true,
      'thread-2': true,
    })
    expect(markThreadResumed(resumed, '')).toBe(resumed)

    expect(setThreadLoadedVersion(versions, 'thread-1', 'v1')).toBe(versions)
    expect(setThreadLoadedVersion(versions, 'thread-1', '')).toBe(versions)
    expect(setThreadLoadedVersion(versions, 'thread-1', 'v2')).toEqual({
      'thread-1': 'v2',
    })
  })

  it('prunes every thread-scoped state map consistently', () => {
    const pruned = pruneDesktopThreadScopedState(state(), new Set(['keep']))

    expect(Object.keys(pruned.readStateByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.scrollStateByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.loadedMessagesByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.loadedVersionByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.resumedThreadById)).toEqual(['keep'])
    expect(Object.keys(pruned.persistedMessagesByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.turnActivityByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.turnErrorByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.eventUnreadByThreadId)).toEqual(['keep'])
    expect(Object.keys(pruned.inProgressById)).toEqual(['keep'])
    expect(Object.keys(pruned.pendingServerRequestsByThreadId)).toEqual(['keep'])
  })
})
