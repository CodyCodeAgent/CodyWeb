import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTurnInput,
  getThreadGroups,
  getThreadMessages,
  startThread,
  startThreadTurn,
  startThreadTurnWithResumeRecovery,
} from './codexThreadClient'
import type { Thread } from '@codycodeagent/cody-web-core/protocol'

const rpcMock = vi.hoisted(() => ({
  rpcCall: vi.fn(),
}))
vi.mock('./codexRpcClient', () => rpcMock)

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

  it('loads the authoritative native Thread transcript directly through RPC', async () => {
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

    await expect(getThreadMessages(' thread-1 ')).resolves.toEqual([
      expect.objectContaining({
        id: 'tool:cmd-1', messageType: 'tool.command',
        tool: expect.objectContaining({ summary: 'npm test', output: '2 passed', status: 'completed' }),
      }),
      expect.objectContaining({ id: 'agent:answer-1', role: 'assistant', text: 'Done.' }),
    ])

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

  it('materializes a durable thread once when turn/start reports it missing', async () => {
    rpcMock.rpcCall
      .mockRejectedValueOnce(new Error('thread not found: thread-1'))
      .mockResolvedValueOnce({ thread: thread({ id: 'thread-1' }) })
      .mockResolvedValueOnce({ turn: { id: 'turn-recovered' } })

    await expect(startThreadTurnWithResumeRecovery('thread-1', 'continue', [], [])).resolves.toBe('turn-recovered')

    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(1, 'turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'continue', text_elements: [] }],
    })
    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(2, 'thread/resume', { threadId: 'thread-1' })
    expect(rpcMock.rpcCall).toHaveBeenNthCalledWith(3, 'turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'continue', text_elements: [] }],
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
