import { describe, expect, it } from 'vitest'
import { markThreadMessagesLoaded, setThreadLoadedVersion, shouldShowMessagesLoading } from './desktopThreadScopedState'

describe('desktop thread loading projection', () => {
  it('shows loading only before a visible thread has loaded', () => {
    expect(shouldShowMessagesLoading({ loadedMessagesByThreadId: {}, threadId: 'thread-1', silent: false })).toBe(true)
    expect(shouldShowMessagesLoading({ loadedMessagesByThreadId: { 'thread-1': true }, threadId: 'thread-1', silent: false })).toBe(false)
    expect(shouldShowMessagesLoading({ loadedMessagesByThreadId: {}, threadId: 'thread-1', silent: true })).toBe(false)
  })

  it('keeps loaded flags and versions stable', () => {
    const loaded = markThreadMessagesLoaded({}, 'thread-1')
    expect(loaded).toEqual({ 'thread-1': true })
    expect(markThreadMessagesLoaded(loaded, 'thread-1')).toBe(loaded)
    const versions = setThreadLoadedVersion({}, 'thread-1', 'v1')
    expect(versions).toEqual({ 'thread-1': 'v1' })
    expect(setThreadLoadedVersion(versions, 'thread-1', 'v1')).toBe(versions)
  })
})
