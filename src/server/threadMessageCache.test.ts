import { describe, expect, it, vi } from 'vitest'
import type { ThreadReadResponse } from '../api/appServerDtos'
import { ThreadMessageCache } from './threadMessageCache'

function threadReadResponse(threadId: string, messageCount: number, updatedAt = 100): ThreadReadResponse {
  return {
    thread: {
      id: threadId,
      extra: null,
      sessionId: 'session-1',
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      historyMode: 'paginated',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt,
      recencyAt: updatedAt,
      status: { type: 'idle' },
      path: null,
      cwd: '/repo',
      cliVersion: 'test',
      source: 'appServer',
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: Array.from({ length: messageCount }, (_, index) => ({
        id: `turn-${String(index + 1)}`,
        status: 'inProgress',
        error: null,
        itemsView: 'full',
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: 'agentMessage',
            id: `message-${String(index + 1)}`,
            text: `Message ${String(index + 1)}`,
          },
        ],
      })),
    },
  } as unknown as ThreadReadResponse
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('ThreadMessageCache', () => {
  it('renders native history through the shared Core transcript', async () => {
    const payload = threadReadResponse('thread-1', 1) as unknown as ThreadReadResponse
    payload.thread.turns = [{
      id: 'turn-1',
      status: 'completed',
      error: null,
      itemsView: 'full',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      items: [{
        type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo',
        processId: 'pty-1', status: 'completed', commandActions: [], aggregatedOutput: '2 passed',
        exitCode: 0, durationMs: 1_200,
      }, { type: 'agentMessage', id: 'answer-1', text: 'Done.' }],
    }] as unknown as ThreadReadResponse['thread']['turns']
    const cache = new ThreadMessageCache({ rpc: vi.fn(async () => payload) })

    const page = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10 })

    expect(page.messages).toEqual([
      expect.objectContaining({
        id: 'tool:cmd-1', messageType: 'tool.command',
        tool: expect.objectContaining({ summary: 'npm test', output: '2 passed', status: 'completed' }),
      }),
      expect.objectContaining({ id: 'agent:answer-1', role: 'assistant', text: 'Done.' }),
    ])
  })

  it('hydrates once on cache miss and pages newest messages by offset', async () => {
    const rpc = vi.fn(async () => threadReadResponse('thread-1', 25))
    const cache = new ThreadMessageCache({ rpc })

    const firstPage = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 0 })
    const secondPage = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 10 })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-1', includeTurns: true })
    expect(firstPage.messages.map((message) => message.id)).toEqual([
      'agent:message-16', 'agent:message-17', 'agent:message-18', 'agent:message-19', 'agent:message-20',
      'agent:message-21', 'agent:message-22', 'agent:message-23', 'agent:message-24', 'agent:message-25',
    ])
    expect(firstPage.total).toBe(25)
    expect(firstPage.nextOffset).toBe(10)
    expect(firstPage.hasMoreBefore).toBe(true)
    expect(secondPage.messages.map((message) => message.id)).toEqual([
      'agent:message-6', 'agent:message-7', 'agent:message-8', 'agent:message-9', 'agent:message-10',
      'agent:message-11', 'agent:message-12', 'agent:message-13', 'agent:message-14', 'agent:message-15',
    ])
    expect(secondPage.nextOffset).toBe(20)
    expect(secondPage.hasMoreBefore).toBe(true)
  })

  it('keeps the earlier-page boundary stable when newer messages arrive', async () => {
    let messageCount = 25
    const rpc = vi.fn(async () => threadReadResponse('thread-1', messageCount))
    const cache = new ThreadMessageCache({ rpc })

    const latestPage = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10 })
    expect(latestPage.nextBeforeMessageId).toBe('agent:message-16')

    messageCount = 27
    cache.markDirty('thread-1')
    const earlierPage = await cache.getMessagesPage({
      threadId: 'thread-1',
      limit: 10,
      offset: latestPage.nextOffset,
      beforeMessageId: latestPage.nextBeforeMessageId ?? '',
    })

    expect(earlierPage.messages.map((message) => message.id)).toEqual([
      'agent:message-6', 'agent:message-7', 'agent:message-8', 'agent:message-9', 'agent:message-10',
      'agent:message-11', 'agent:message-12', 'agent:message-13', 'agent:message-14', 'agent:message-15',
    ])
    expect(earlierPage.remainingBefore).toBe(5)
    expect(earlierPage.nextBeforeMessageId).toBe('agent:message-6')
  })

  it('shares one hydration promise for concurrent requests to the same thread', async () => {
    const hydration = deferred<ThreadReadResponse>()
    const rpc = vi.fn(async () => hydration.promise)
    const cache = new ThreadMessageCache({ rpc })

    const first = cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 0 })
    const second = cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 10 })
    await Promise.resolve()

    expect(rpc).toHaveBeenCalledTimes(1)

    hydration.resolve(threadReadResponse('thread-1', 12))

    await expect(first).resolves.toMatchObject({ offset: 0, total: 12 })
    await expect(second).resolves.toMatchObject({ offset: 10, total: 12 })
  })

  it('skips full refresh when the 10 minute metadata check sees the same updatedAt', async () => {
    let now = new Date('2026-08-20T00:00:00.000Z')
    const rpc = vi.fn()
      .mockResolvedValueOnce(threadReadResponse('thread-1', 10, 100))
      .mockResolvedValueOnce(threadReadResponse('thread-1', 0, 100))
    const cache = new ThreadMessageCache({
      rpc,
      now: () => now,
      refreshIntervalMs: 10 * 60_000,
    })

    await cache.getMessagesPage({ threadId: 'thread-1' })
    now = new Date('2026-08-20T00:10:01.000Z')
    await cache.refreshDueEntries()

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenNthCalledWith(2, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: false,
    })
  })

  it('full-refreshes when metadata updatedAt changes', async () => {
    let now = new Date('2026-08-20T00:00:00.000Z')
    const rpc = vi.fn()
      .mockResolvedValueOnce(threadReadResponse('thread-1', 10, 100))
      .mockResolvedValueOnce(threadReadResponse('thread-1', 0, 101))
      .mockResolvedValueOnce(threadReadResponse('thread-1', 11, 101))
    const cache = new ThreadMessageCache({
      rpc,
      now: () => now,
      refreshIntervalMs: 10 * 60_000,
    })

    await cache.getMessagesPage({ threadId: 'thread-1' })
    now = new Date('2026-08-20T00:10:01.000Z')
    await cache.refreshDueEntries()
    const page = await cache.getMessagesPage({ threadId: 'thread-1', limit: 20 })

    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc).toHaveBeenNthCalledWith(3, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    })
    expect(page.total).toBe(11)
    expect(page.messages.at(-1)?.id).toBe('agent:message-11')
  })

  it('refreshes a cached dirty thread on the next request', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(threadReadResponse('thread-1', 10, 100))
      .mockResolvedValueOnce(threadReadResponse('thread-1', 11, 101))
    const cache = new ThreadMessageCache({ rpc })

    await cache.getMessagesPage({ threadId: 'thread-1' })
    cache.markDirty('thread-1')
    const page = await cache.getMessagesPage({ threadId: 'thread-1', limit: 20 })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenNthCalledWith(2, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    })
    expect(page.total).toBe(11)
  })
})
