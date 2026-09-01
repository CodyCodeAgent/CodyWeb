import { normalizeCodexApiError } from './codexErrors'
import { normalizeCatalogThreadGroups } from './normalizers/v2'
import type { UiProjectGroup } from '../types/codex'
import { buildTurnUserInput } from '@codycodeagent/cody-web-core/session'
import type { CodexThreadSummary } from '@codycodeagent/cody-web-core/session'
import type { ExecutionContext, TurnInput } from '@codycodeagent/cody-web-core/session'
import { fetchCodexJson, jsonPostInit, queryPath, readRpcResult } from './codexHttpClient'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import type { ConversationAttachment, ConversationSnapshot } from '@codycodeagent/cody-web-core/client'
import type { ComposerImage, ComposerSkill } from '@codycodeagent/cody-web-core/composer'

async function getThreadGroupsV2(archived = false): Promise<UiProjectGroup[]> {
  const { payload, status } = await fetchCodexJson(queryPath('/codex-api/conversations/threads', { archived }), {
    init: { method: 'GET' },
    method: 'conversation/threads/list',
    networkErrorMessage: 'Conversation thread catalog request failed before it was sent',
    httpErrorMessage: 'Failed to load conversation thread catalog',
    timeoutMs: 25_000,
  })
  const result = readRpcResult(payload, status, 'conversation/threads/list', 'Conversation thread catalog returned malformed envelope')
  if (!Array.isArray(result)) throw new Error('Conversation thread catalog returned malformed rows')
  return normalizeCatalogThreadGroups(result as CodexThreadSummary[])
}

export async function getThreadEvents(threadId: string): Promise<CodexEvent[]> {
  return (await getThreadConversationSnapshot(threadId)).events
}

export async function getThreadGroups(archived = false): Promise<UiProjectGroup[]> {
  try {
    return await getThreadGroupsV2(archived)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function renameThread(threadId: string, name: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedName = name.trim()
  if (!normalizedThreadId || !normalizedName) return

  const { payload, status } = await fetchCodexJson('/codex-api/conversations/threads/rename', {
    init: jsonPostInit({ threadId: normalizedThreadId, name: normalizedName }),
    method: 'conversation/threads/rename',
    networkErrorMessage: 'Conversation thread rename failed before request was sent',
    httpErrorMessage: 'Conversation thread rename failed',
    timeoutMs: 25_000,
  })
  readRpcResult(payload, status, 'conversation/threads/rename', 'Conversation thread rename returned malformed envelope')
}

export async function forkThread(threadId: string): Promise<string> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return ''

  const { payload, status } = await fetchCodexJson('/codex-api/conversations/threads/fork', {
    init: jsonPostInit({ threadId: normalizedThreadId }),
    method: 'conversation/threads/fork',
    networkErrorMessage: 'Conversation thread fork failed before request was sent',
    httpErrorMessage: 'Conversation thread fork failed',
    timeoutMs: 25_000,
  })
  const result = readRpcResult(payload, status, 'conversation/threads/fork', 'Conversation thread fork returned malformed envelope') as { threadId?: unknown }
  if (typeof result.threadId !== 'string' || !result.threadId.trim()) throw new Error('Conversation thread fork returned no thread id')
  return result.threadId.trim()
}

export async function compactThread(threadId: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return
  const { payload, status } = await fetchCodexJson('/codex-api/conversations/threads/compact', {
    init: jsonPostInit({ threadId: normalizedThreadId }),
    method: 'conversation/threads/compact',
    networkErrorMessage: 'Conversation thread compact failed before request was sent',
    httpErrorMessage: 'Conversation thread compact failed',
    timeoutMs: 25_000,
  })
  readRpcResult(payload, status, 'conversation/threads/compact', 'Conversation thread compact returned malformed envelope')
}

export async function startThread(cwd?: string, model?: string): Promise<string> {
  try {
    const thread: { cwd?: string; model?: string } = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      thread.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      thread.model = model.trim()
    }
    const { payload, status } = await fetchCodexJson('/codex-api/conversations/threads/start', {
      init: jsonPostInit({ context: { thread } }),
      method: 'conversation/threads/start',
      networkErrorMessage: 'Conversation thread start failed before request was sent',
      httpErrorMessage: 'Conversation thread start failed',
      timeoutMs: 25_000,
    })
    const result = readRpcResult(payload, status, 'conversation/threads/start', 'Conversation thread start returned malformed envelope') as { threadId?: unknown }
    if (typeof result.threadId !== 'string' || !result.threadId.trim()) throw new Error('Conversation thread start returned no thread id')
    return result.threadId.trim()
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

/** Submit through the one process-wide Core SessionManager owner. */
export async function submitThreadCommand(input: {
  threadId: string
  clientCommandId: string
  mode: 'queue' | 'steer'
  turnInput: TurnInput
  context?: ExecutionContext
}): Promise<{ clientCommandId: string }> {
  const { payload, status } = await fetchCodexJson('/codex-api/conversations/submit', {
    init: jsonPostInit({
      threadId: input.threadId,
      clientCommandId: input.clientCommandId,
      mode: input.mode,
      context: input.context ?? { thread: {} },
      input: input.turnInput,
    }),
    method: 'conversation/submit',
    networkErrorMessage: 'Conversation command failed before request was sent',
    httpErrorMessage: 'Conversation command failed',
    timeoutMs: 25_000,
  })
  return readRpcResult(payload, status, 'conversation/submit', 'Conversation submit returned malformed envelope')
}

export async function attachThreadConversation(threadId: string): Promise<ConversationAttachment> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return { events: [] }
  const { payload, status } = await fetchCodexJson('/codex-api/conversations/attach', {
    init: jsonPostInit({ threadId: normalizedThreadId, context: { thread: {} } }),
    method: 'conversation/attach',
    networkErrorMessage: 'Conversation owner attach failed before request was sent',
    httpErrorMessage: 'Conversation owner attach failed',
    timeoutMs: 25_000,
  })
  const result = readRpcResult(payload, status, 'conversation/attach', 'Conversation attach returned malformed envelope') as { events?: unknown }
  const events = Array.isArray(result.events)
    ? result.events.filter((event: unknown): event is CodexEvent => Boolean(event && typeof event === 'object'))
    : []
  return { events }
}

/** The server-side Core owner supplies the atomic history/realtime cut. */
export async function getThreadConversationSnapshot(threadId: string): Promise<ConversationSnapshot> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return { events: [], watermark: 0 }
  const { payload, status } = await fetchCodexJson('/codex-api/conversations/snapshot', {
    init: jsonPostInit({ threadId: normalizedThreadId, context: { thread: {} } }),
    method: 'conversation/snapshot',
    networkErrorMessage: 'Conversation snapshot failed before request was sent',
    httpErrorMessage: 'Conversation snapshot failed',
    timeoutMs: 25_000,
  })
  const result = readRpcResult(payload, status, 'conversation/snapshot', 'Conversation snapshot returned malformed envelope') as { events?: unknown; watermark?: unknown }
  return {
    events: Array.isArray(result.events)
      ? result.events.filter((event: unknown): event is CodexEvent => Boolean(event && typeof event === 'object'))
      : [],
    watermark: typeof result.watermark === 'number' && Number.isFinite(result.watermark) ? result.watermark : 0,
  }
}

export function buildTurnInput(
  text: string,
  images: ComposerImage[],
  skills: ComposerSkill[] = [],
) {
  return buildTurnUserInput({
    text,
    skills,
    localImages: images.map(image => ({ path: image.path })),
  })
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return

  try {
    const { payload, status } = await fetchCodexJson('/codex-api/conversations/interrupt', {
      init: jsonPostInit({ threadId: normalizedThreadId, context: { thread: {} } }),
      method: 'conversation/interrupt',
      networkErrorMessage: 'Conversation interrupt failed before request was sent',
      httpErrorMessage: 'Conversation interrupt failed',
      timeoutMs: 25_000,
    })
    readRpcResult(payload, status, 'conversation/interrupt', 'Conversation interrupt returned malformed envelope')
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}
