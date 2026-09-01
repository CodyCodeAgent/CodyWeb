import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachThreadConversation,
  buildTurnInput,
  getThreadEvents,
  getThreadGroups,
  renameThread,
  startThread,
  submitThreadCommand,
} from './codexThreadClient'
const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
  jsonPostInit: vi.fn((body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })),
  queryPath: vi.fn((path: string, params: Record<string, unknown>) => `${path}?archived=${String(params.archived)}`),
  readRpcResult: vi.fn((payload: unknown) => (payload as { result: unknown }).result),
}))
vi.mock('./codexHttpClient', () => httpMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex thread client', () => {
  function thread(overrides: Record<string, unknown> = {}) {
    return {
      threadId: 'thread-1',
      sessionId: 'session-1',
      forkedFromThreadId: '',
      parentThreadId: '',
      preview: 'Preview',
      name: 'Thread',
      ephemeral: false,
      createdAtIso: '2026-09-01T00:00:00.000Z',
      updatedAtIso: '2026-09-01T00:00:01.000Z',
      source: 'appServer',
      status: 'idle',
      activeFlags: [],
      cwd: '/repo',
      canAcceptDirectInput: true,
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

  it('loads the catalog through the Core conversation owner', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({
      payload: { result: [
        thread({ threadId: 'first', cwd: '/repo/one', updatedAtIso: '2026-09-01T00:00:10.000Z' }),
        thread({ threadId: 'second', cwd: '/repo/two', updatedAtIso: '2026-09-01T00:00:20.000Z' }),
      ] },
      status: 200,
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

    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/threads?archived=false', expect.objectContaining({
      method: 'conversation/threads/list',
    }))
  })

  it('loads an owner-atomic snapshot for the Core controller', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({
      payload: { result: { watermark: 8, events: [
        { id: 'answer-1', type: 'assistant.completed', threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', atIso: '2026-09-01T00:00:00.000Z', data: { text: 'Done.' } },
      ] } },
      status: 200,
    })

    await expect(getThreadEvents(' thread-1 ')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant.completed', itemId: 'answer-1' }),
    ]))

    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/snapshot', expect.objectContaining({
      method: 'conversation/snapshot',
    }))
  })

  it('starts threads with normalized optional params', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: { threadId: 'thread-1' } }, status: 201 })

    await expect(startThread(' /repo ', ' gpt-5 ')).resolves.toBe('thread-1')

    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/threads/start', expect.objectContaining({
      method: 'conversation/threads/start',
    }))
    expect(httpMock.jsonPostInit).toHaveBeenCalledWith({ context: { thread: { cwd: '/repo', model: 'gpt-5' } } })
  })

  it('renames through the Core owner rather than generic RPC', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: { ok: true } }, status: 200 })
    await renameThread(' thread-1 ', ' Renamed ')
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/threads/rename', expect.objectContaining({
      method: 'conversation/threads/rename',
    }))
    expect(httpMock.jsonPostInit).toHaveBeenCalledWith({ threadId: 'thread-1', name: 'Renamed' })
  })

  it('attaches and submits only through the process-wide conversation owner', async () => {
    httpMock.fetchCodexJson
      .mockResolvedValueOnce({ payload: { result: { attached: true, events: [{ id: 'active', type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1', atIso: '2026-09-01T00:00:00.000Z', data: {} }] } }, status: 200 })
      .mockResolvedValueOnce({ payload: { result: { clientCommandId: 'command-1' } }, status: 202 })

    await expect(attachThreadConversation(' thread-1 ')).resolves.toEqual({
      events: [expect.objectContaining({ type: 'turn.started', turnId: 'turn-1' })],
    })
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
  })
})
