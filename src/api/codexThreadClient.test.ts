import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachThreadConversation,
  buildTurnInput,
  getThreadEvents,
  getThreadGroups,
  startThread,
  submitThreadCommand,
} from './codexThreadClient'
import type { Thread } from '@codycodeagent/cody-web-core/protocol'

const rpcMock = vi.hoisted(() => ({
  rpcCall: vi.fn(),
}))
const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
  jsonPostInit: vi.fn((body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })),
  readRpcResult: vi.fn((payload: unknown) => (payload as { result: unknown }).result),
}))
vi.mock('./codexRpcClient', () => rpcMock)
vi.mock('./codexHttpClient', () => httpMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex thread client', () => {
  function thread(overrides: Partial<Thread> = {}): Thread {
    return {
      id: 'thread-1',
      extra: null,
      sessionId: 'session-1',
      forkedFromId: null,
      parentThreadId: null,
      preview: 'Preview',
      name: 'Thread',
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      historyMode: 'paginated',
      modelProvider: 'openai',
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      recencyAt: 1_700_000_100,
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
      turns: [],
      ...overrides,
    } as Thread
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
      sortDirection: 'desc',
      sortKey: 'updated_at',
    })
    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(2, 'thread/list', {
      archived: false,
      limit: 100,
      sortDirection: 'desc',
      sortKey: 'updated_at',
      cursor: 'cursor-2',
    })
  })

  it('loads authoritative native Thread events for the Core controller', async () => {
    rpcMock.rpcCall.mockResolvedValue({
      thread: thread({
        turns: [{
          id: 'turn-1',
          status: 'completed',
          error: null,
          itemsView: 'full',
          startedAt: null,
          completedAt: null,
          durationMs: null,
          items: [
            {
              type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo',
              processId: 'pty-1', status: 'completed', commandActions: [], aggregatedOutput: '2 passed',
              exitCode: 0, durationMs: 1_200,
            },
            { type: 'agentMessage', id: 'answer-1', text: 'Done.' },
          ],
        }] as never,
      }),
    })

    await expect(getThreadEvents(' thread-1 ')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.completed', itemId: 'cmd-1' }),
      expect.objectContaining({ type: 'assistant.completed', itemId: 'answer-1' }),
      expect.objectContaining({ type: 'turn.completed', turnId: 'turn-1' }),
    ]))

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    })
  })

  it('starts threads with normalized optional params', async () => {
    rpcMock.rpcCall.mockResolvedValue({ thread: thread() })

    await expect(startThread(' /repo ', ' gpt-5 ')).resolves.toBe('thread-1')

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('thread/start', {
      cwd: '/repo',
      model: 'gpt-5',
    })
  })

  it('attaches and submits only through the process-wide conversation owner', async () => {
    httpMock.fetchCodexJson
      .mockResolvedValueOnce({ payload: { result: { attached: true } }, status: 200 })
      .mockResolvedValueOnce({ payload: { result: { clientCommandId: 'command-1' } }, status: 202 })

    await expect(attachThreadConversation(' thread-1 ')).resolves.toBeUndefined()
    await expect(submitThreadCommand({
      threadId: 'thread-1', clientCommandId: 'command-1', mode: 'queue',
      turnInput: { input: [{ type: 'text', text: 'hello', text_elements: [] }] },
    })).resolves.toEqual({ clientCommandId: 'command-1' })

    expect(httpMock.fetchCodexJson).toHaveBeenNthCalledWith(1, '/codex-api/conversations/attach', expect.objectContaining({
      method: 'conversation/attach',
    }))
    expect(httpMock.fetchCodexJson).toHaveBeenNthCalledWith(2, '/codex-api/conversations/submit', expect.objectContaining({
      method: 'conversation/submit',
    }))
    expect(rpcMock.rpcCall).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })
})
