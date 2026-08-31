import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import { normalizeCatalogThreadGroups } from './normalizers/v2'
import type { UiProjectGroup } from '../types/codex'
import { buildTurnUserInput, CodexSessionCatalog, CodexThreadCommands } from '@codycodeagent/cody-web-core/session'
import type { ExecutionContext, TurnInput } from '@codycodeagent/cody-web-core/session'
import { fetchCodexJson, jsonPostInit, readRpcResult } from './codexHttpClient'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import type { ConversationAttachment } from '@codycodeagent/cody-web-core/client'
import type { ComposerImage, ComposerSkill } from '@codycodeagent/cody-web-core/composer'

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

const sessionCatalog = new CodexSessionCatalog({ call: callRpc })
const threadCommands = new CodexThreadCommands({ call: callRpc })

async function getThreadGroupsV2(archived = false): Promise<UiProjectGroup[]> {
  return normalizeCatalogThreadGroups(await sessionCatalog.listThreads({ archived }))
}

export async function getThreadEvents(threadId: string): Promise<CodexEvent[]> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return []
  try {
    return (await sessionCatalog.readThreadSnapshot(normalizedThreadId)).events
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${normalizedThreadId}`, 'thread/read')
  }
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

  await threadCommands.renameThread(normalizedThreadId, normalizedName)
}

export async function forkThread(threadId: string): Promise<string> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return ''

  return threadCommands.forkThread(normalizedThreadId)
}

export async function compactThread(threadId: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return
  await threadCommands.compactThread(normalizedThreadId)
}

export async function startThread(cwd?: string, model?: string): Promise<string> {
  try {
    const params: { cwd?: string; model?: string } = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    return await threadCommands.startThread(params)
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
