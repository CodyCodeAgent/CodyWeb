import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTurnInput,
  getThreadGroups,
  getThreadMessagesPage,
  startThread,
  startThreadTurn,
} from './codexThreadClient'
import type { ThreadListResponse } from './appServerDtos'

const rpcMock = vi.hoisted(() => ({
  rpcCall: vi.fn(),
}))
const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
}))

vi.mock('./codexRpcClient', () => rpcMock)
vi.mock('./codexHttpClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codexHttpClient')>()
  return {
    ...actual,
    fetchCodexJson: httpMock.fetchCodexJson,
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex thread client', () => {
  function thread(overrides: Partial<ThreadListResponse['data'][number]> = {}): ThreadListResponse['data'][number] {
    return {
      id: 'thread-1',
      preview: 'Preview',
      modelProvider: 'openai',
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      path: null,
      cwd: '/repo',
      cliVersion: 'test',
      source: 'appServer',
      gitInfo: null,
      turns: [],
      ...overrides,
    }
  }

  it('builds turn input from skills, text, and local images', () => {
    expect(buildTurnInput(
      '  explain this  ',
      [
        { id: 'img-1', name: 'screen.png', path: ' /tmp/screen.png ', url: '/image', mimeType: 'image/png' },
        { id: 'img-empty', name: 'empty.png', path: ' ', url: '/empty', mimeType: 'image/png' },
      ],
      [
        { name: ' docs ', path: ' /skills/docs ', displayName: 'Docs', description: '' },
        { name: 'missing-path', path: ' ', displayName: 'Missing', description: '' },
      ],
    )).toEqual([
      { type: 'skill', name: 'docs', path: '/skills/docs' },
      { type: 'text', text: 'explain this', text_elements: [] },
      { type: 'localImage', path: '/tmp/screen.png' },
    ])
  })

  it('loads all thread list pages before grouping', async () => {
    rpcMock.rpcCall
      .mockResolvedValueOnce({
        data: [thread({ id: 'first', cwd: '/repo/one', updatedAt: 10 })],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        data: [thread({ id: 'second', cwd: '/repo/two', updatedAt: 20 })],
        nextCursor: null,
      })

    await expect(getThreadGroups(false)).resolves.toEqual([
      {
        projectName: '/repo/two',
        cwd: '/repo/two',
        threads: [
          expect.objectContaining({ id: 'second' }),
        ],
      },
      {
        projectName: '/repo/one',
        cwd: '/repo/one',
        threads: [
          expect.objectContaining({ id: 'first' }),
        ],
      },
    ])

    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(1, 'thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'updated_at',
    })
    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(2, 'thread/list', {
      archived: false,
      limit: 100,
      sortKey: 'updated_at',
      cursor: 'cursor-2',
    })
  })

  it('loads thread messages from the paged server cache endpoint', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({
      status: 200,
      payload: {
        result: {
          threadId: 'thread-1',
          messages: [{ id: 'message-1', role: 'assistant', text: 'cached' }],
          total: 1,
          limit: 10,
          offset: 0,
          nextOffset: 1,
          nextBeforeMessageId: null,
          remainingBefore: 0,
          hasMoreBefore: false,
          cache: {
            status: 'ready',
            hydratedAtIso: '2026-08-20T00:00:00.000Z',
            refreshedAtIso: '2026-08-20T00:00:00.000Z',
            checkedAtIso: '2026-08-20T00:00:00.000Z',
          },
        },
      },
    })

    await expect(getThreadMessagesPage(' thread-1 ')).resolves.toMatchObject({
      threadId: 'thread-1',
      messages: [{ id: 'message-1', role: 'assistant', text: 'cached' }],
      total: 1,
    })

    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith(
      '/codex-api/thread-cache/messages?threadId=thread-1&limit=10&offset=0',
      expect.objectContaining({ method: 'thread-cache/messages' }),
    )
  })

  it('starts threads with normalized optional params', async () => {
    rpcMock.rpcCall.mockResolvedValue({ thread: { id: 'thread-1' } })

    await expect(startThread(' /repo ', ' gpt-5 ')).resolves.toBe('thread-1')

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('thread/start', {
      cwd: '/repo',
      model: 'gpt-5',
    })
  })

  it('starts turns with plan collaboration settings when selected', async () => {
    rpcMock.rpcCall.mockResolvedValue({ turn: { id: ' turn-1 ' } })

    await expect(startThreadTurn(
      'thread-1',
      'hello',
      [],
      [],
      'gpt-5',
      'medium',
      {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    )).resolves.toBe('turn-1')

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      model: 'gpt-5',
      effort: 'medium',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    })
  })

  it('starts turns with explicit default collaboration mode when selected', async () => {
    rpcMock.rpcCall.mockResolvedValue({ turn: { id: ' turn-1 ' } })

    await expect(startThreadTurn(
      'thread-1',
      'hello',
      [],
      [],
      'gpt-5',
      'medium',
      {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    )).resolves.toBe('turn-1')

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      model: 'gpt-5',
      effort: 'medium',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    })
  })

  it('starts turns with explicit permission overrides', async () => {
    rpcMock.rpcCall.mockResolvedValue({ turn: { id: ' turn-1 ' } })

    await expect(startThreadTurn(
      'thread-1',
      'hello',
      [],
      [],
      undefined,
      undefined,
      null,
      {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    )).resolves.toBe('turn-1')

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })
})
