import { describe, expect, it } from 'vitest'
import type { RpcNotification } from '../api/codexRealtimeClient'
import {
  extractThreadIdFromNotification,
  isAgentContentEvent,
  normalizeRealtimeNotification,
  readRateLimitSnapshotPayload,
  readStartedThread,
  readThreadContextUsageUpdate,
  readTurnCompletedInfo,
  readTurnDurationHints,
  readTurnStartedInfo,
  readUserMessageCompleted,
} from './realtimeNotificationReaders'

function notification(method: string, params: unknown, atIso = '2026-07-07T00:00:00.000Z'): RpcNotification {
  return { method, params, atIso }
}

describe('realtime notification readers', () => {
  it('normalizes each transport notification once', () => {
    const source = notification('item/agentMessage/delta', {
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      delta: 'hello',
    })

    expect(normalizeRealtimeNotification(source)).toBe(normalizeRealtimeNotification(source))
  })

  it('extracts thread ids from common notification shapes', () => {
    expect(extractThreadIdFromNotification(notification('item/agentMessage/delta', { threadId: 'thread-a' }))).toBe('thread-a')
    expect(extractThreadIdFromNotification(notification('turn/started', { thread_id: 'thread-b' }))).toBe('thread-b')
    expect(extractThreadIdFromNotification(notification('turn/started', { thread: { id: 'thread-c' } }))).toBe('thread-c')
    expect(extractThreadIdFromNotification(notification('turn/started', { turn: { threadId: 'thread-d' } }))).toBe('thread-d')
    expect(extractThreadIdFromNotification(notification('turn/started', { conversationId: 'thread-e' }))).toBe('thread-e')
  })

  it('reads turn lifecycle and failure state', () => {
    const started = readTurnStartedInfo(notification('turn/started', {
      turn: {
        id: 'turn-1',
        threadId: 'thread-1',
        startedAt: '2026-07-07T01:00:00.000Z',
      },
    }))

    expect(started).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: new Date('2026-07-07T01:00:00.000Z').getTime(),
    })
    expect(readTurnStartedInfo(notification('turn/started', {
      thread_id: 'thread-raw',
      turn_id: 'turn-raw',
    }))).toMatchObject({
      threadId: 'thread-raw',
      turnId: 'turn-raw',
    })

    const completed = readTurnCompletedInfo(notification('turn/completed', {
      turn: {
        id: 'turn-1',
        threadId: 'thread-1',
        startedAt: '2026-07-07T01:00:00.000Z',
        completedAt: '2026-07-07T01:00:05.000Z',
      },
    }))

    expect(completed).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: new Date('2026-07-07T01:00:05.000Z').getTime(),
      startedAtMs: new Date('2026-07-07T01:00:00.000Z').getTime(),
    })

    expect(readTurnDurationHints(notification('turn/completed', {
      durationMs: 1200,
      turn: { durationMs: 1000 },
    }))).toEqual({
      explicitDurationMs: 1200,
      turnDurationMs: 1000,
    })
  })

  it('reads rate limit update payloads without leaking protocol parsing into state', () => {
    const rateLimits = { limitId: 'codex', primary: { usedPercent: 10 } }

    expect(readRateLimitSnapshotPayload(notification('account/rateLimits/updated', {
      rateLimits,
    }))).toBe(rateLimits)
    expect(readRateLimitSnapshotPayload(notification('turn/started', {}))).toBeNull()
  })

  it('reads current thread context usage and model window from token notifications', () => {
    expect(readThreadContextUsageUpdate(notification('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        last: {
          inputTokens: 118_000,
          totalTokens: 120_000,
        },
        modelContextWindow: 200_000,
      },
    }))).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      inputTokens: 118_000,
      usedTokens: 120_000,
      contextWindow: 200_000,
      compactionState: 'idle',
    })

    expect(readThreadContextUsageUpdate(notification('thread/tokenUsage/updated', {
      thread_id: 'thread-2',
      token_usage: {
        last: { input_tokens: '99000', total_tokens: '100000' },
        model_context_window: '128000',
      },
    }))).toMatchObject({
      threadId: 'thread-2',
      usedTokens: 100_000,
      contextWindow: 128_000,
    })
  })

  it('reads started thread notifications for immediate sidebar updates', () => {
    expect(readStartedThread(notification('thread/started', {
      thread: {
        id: 'thread-1',
        title: 'Fresh task',
        projectName: 'CodyWeb',
        cwd: '/workspace/CodyWeb',
        createdAt: 1783414904,
        updatedAt: '2026-07-07T09:02:00.000Z',
        preview: 'first prompt',
      },
    }))).toMatchObject({
      id: 'thread-1',
      title: 'Fresh task',
      projectName: 'CodyWeb',
      cwd: '/workspace/CodyWeb',
      createdAtIso: '2026-07-07T09:01:44.000Z',
      updatedAtIso: '2026-07-07T09:02:00.000Z',
      preview: 'first prompt',
      unread: false,
      inProgress: false,
    })

    expect(readStartedThread(notification('thread/started', {
      threadId: 'thread-2',
      cwd: '/workspace/other',
    }))).toMatchObject({
      id: 'thread-2',
      title: 'Untitled thread',
      projectName: '/workspace/other',
      cwd: '/workspace/other',
      preview: 'Untitled thread',
    })
  })

  it('reads completed user messages for immediate conversation rendering', () => {
    const messages = readUserMessageCompleted(notification('item/completed', {
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'user-1',
        content: [
          { type: 'skill', name: 'browser', path: '/skills/browser' },
          { type: 'text', text: 'Run this check', text_elements: [] },
          { type: 'localImage', path: '/tmp/screenshot.png' },
          { type: 'unknownBlock', value: 42 },
        ],
      },
    }))

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user',
      text: 'Run this check',
      images: ['/codex-api/local-image?path=%2Ftmp%2Fscreenshot.png'],
      skills: [
        {
          name: 'browser',
          path: '/skills/browser',
          displayName: 'browser',
          description: '',
        },
      ],
      messageType: 'userMessage',
    })
    expect(messages[1]).toMatchObject({
      id: 'user-1:user-content:3',
      turnId: 'turn-1',
      role: 'user',
      messageType: 'userContent.unknownBlock',
      isUnhandled: true,
    })
  })

  it('identifies agent content events', () => {
    expect(isAgentContentEvent(notification('turn/plan/updated', { turnId: 'turn-1' }))).toBe(true)
    expect(isAgentContentEvent(notification('account/rateLimits/updated', {}))).toBe(false)
  })
})
