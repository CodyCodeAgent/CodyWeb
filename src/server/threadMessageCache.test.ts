import { describe, expect, it, vi } from 'vitest'
import type { ThreadReadResponse } from '../api/appServerDtos'
import { ThreadMessageCache } from './threadMessageCache'

function threadReadResponse(threadId: string, messageCount: number, updatedAt = 100): ThreadReadResponse {
  return {
    thread: {
      id: threadId,
      preview: '',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt,
      path: null,
      cwd: '/repo',
      cliVersion: 'test',
      source: 'appServer',
      gitInfo: null,
      turns: Array.from({ length: messageCount }, (_, index) => ({
        id: `turn-${String(index + 1)}`,
        status: 'inProgress',
        error: null,
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
  it('hydrates once on cache miss and pages newest messages by offset', async () => {
    const rpc = vi.fn(async () => threadReadResponse('thread-1', 25))
    const cache = new ThreadMessageCache({ rpc })

    const firstPage = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 0 })
    const secondPage = await cache.getMessagesPage({ threadId: 'thread-1', limit: 10, offset: 10 })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-1', includeTurns: true })
    expect(firstPage.messages.map((message) => message.id)).toEqual([
      'message-16', 'message-17', 'message-18', 'message-19', 'message-20',
      'message-21', 'message-22', 'message-23', 'message-24', 'message-25',
    ])
    expect(firstPage.total).toBe(25)
    expect(firstPage.nextOffset).toBe(10)
    expect(firstPage.hasMoreBefore).toBe(true)
    expect(secondPage.messages.map((message) => message.id)).toEqual([
      'message-6', 'message-7', 'message-8', 'message-9', 'message-10',
      'message-11', 'message-12', 'message-13', 'message-14', 'message-15',
    ])
    expect(secondPage.nextOffset).toBe(20)
    expect(secondPage.hasMoreBefore).toBe(true)
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
    expect(page.messages.at(-1)?.id).toBe('message-11')
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
