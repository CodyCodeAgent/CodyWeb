import type {
  ReasoningEffort,
  ThreadCompactStartResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadSetNameResponse,
  TurnStartResponse,
} from './appServerDtos'
import { normalizeCodexApiError } from './codexErrors'
import { fetchCodexJson, queryPath, readRpcResult } from './codexHttpClient'
import { rpcCall } from './codexRpcClient'
import { normalizeThreadGroupsV2 } from './normalizers/v2'
import type { UiMessage, UiProjectGroup, UiThreadMessagePage } from '../types/codex'
import type { TurnPermissionOverride } from '../composables/desktopTurnPermissions'
import { buildTurnUserInput } from '@codycodeagent/cody-web-core/session'
import type {
  ComposerCollaborationModeOption,
  ComposerImage,
  ComposerSkill,
} from '@codycodeagent/cody-web-core/composer'

export type TurnCollaborationMode = {
  mode: ComposerCollaborationModeOption['mode']
  settings: {
    model: string
    reasoning_effort: ReasoningEffort | null
    developer_instructions: string | null
  }
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

async function getThreadGroupsV2(archived = false): Promise<UiProjectGroup[]> {
  const data: ThreadListResponse['data'] = []
  let cursor: string | null | undefined = null

  do {
    const params: Record<string, unknown> = {
      archived,
      limit: 100,
      sortKey: 'updated_at',
    }
    if (cursor) {
      params.cursor = cursor
    }

    const payload = await callRpc<ThreadListResponse>('thread/list', params)
    data.push(...payload.data)
    cursor = payload.nextCursor
  } while (cursor)

  return normalizeThreadGroupsV2({ data, nextCursor: null })
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  return (await getThreadMessagesPage(threadId)).messages
}

export async function getThreadGroups(archived = false): Promise<UiProjectGroup[]> {
  try {
    return await getThreadGroupsV2(archived)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function getThreadMessages(threadId: string): Promise<UiMessage[]> {
  try {
    return await getThreadMessagesV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getThreadMessagesPage(
  threadId: string,
  options: { limit?: number; offset?: number; beforeMessageId?: string } = {},
): Promise<UiThreadMessagePage> {
  const normalizedThreadId = threadId.trim()
  try {
    const { payload, status } = await fetchCodexJson(queryPath('/codex-api/thread-cache/messages', {
      threadId: normalizedThreadId,
      limit: options.limit ?? 10,
      offset: options.offset ?? 0,
      beforeMessageId: options.beforeMessageId,
    }), {
      method: 'thread-cache/messages',
      networkErrorMessage: `Thread cache failed before request was sent`,
      httpErrorMessage: `Thread cache failed`,
    })
    return readRpcResult<UiThreadMessagePage>(
      payload,
      status,
      'thread-cache/messages',
      'Thread cache returned malformed envelope',
    )
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${normalizedThreadId}`, 'thread-cache/messages')
  }
}

export async function resumeThread(threadId: string): Promise<void> {
  await callRpc('thread/resume', { threadId })
}

export async function renameThread(threadId: string, name: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedName = name.trim()
  if (!normalizedThreadId || !normalizedName) return

  await callRpc<ThreadSetNameResponse>('thread/name/set', {
    threadId: normalizedThreadId,
    name: normalizedName,
  })
}

export async function forkThread(threadId: string): Promise<string> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return ''

  const payload = await callRpc<ThreadForkResponse>('thread/fork', {
    threadId: normalizedThreadId,
  })
  return payload.thread.id
}

export async function compactThread(threadId: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return
  await callRpc<ThreadCompactStartResponse>('thread/compact/start', {
    threadId: normalizedThreadId,
  })
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

export async function startThread(cwd?: string, model?: string): Promise<string> {
  try {
    const params: Record<string, unknown> = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<{ thread?: { id?: string } }>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return threadId
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  images: ComposerImage[],
  skills: ComposerSkill[],
  model?: string,
  effort?: ReasoningEffort,
  collaborationMode?: TurnCollaborationMode | null,
  permissionOverride?: TurnPermissionOverride | null,
): Promise<string> {
  try {
    const params: Record<string, unknown> = {
      threadId,
      input: buildTurnInput(text, images, skills),
    }
    if (typeof model === 'string' && model.length > 0) {
      params.model = model
    }
    if (typeof effort === 'string' && effort.length > 0) {
      params.effort = effort
    }
    if (collaborationMode) {
      params.collaborationMode = collaborationMode
    }
    if (permissionOverride?.approvalPolicy) {
      params.approvalPolicy = permissionOverride.approvalPolicy
    }
    if (permissionOverride?.sandboxPolicy) {
      params.sandboxPolicy = permissionOverride.sandboxPolicy
    }
    const payload = await callRpc<TurnStartResponse>('turn/start', params)
    const turnId = payload.turn.id.trim()
    if (!turnId) {
      throw new Error('turn/start did not return a turn id')
    }
    return turnId
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export function buildTurnInput(
  text: string,
  images: ComposerImage[],
  skills: ComposerSkill[] = [],
): Array<Record<string, unknown>> {
  return buildTurnUserInput({
    text,
    skills,
    localImages: images.map(image => ({ path: image.path })),
  })
}

export async function steerThreadTurn(
  threadId: string,
  expectedTurnId: string,
  text: string,
  images: ComposerImage[],
  skills: ComposerSkill[],
): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = expectedTurnId.trim()
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/steer requires an active turn id')
    }
    await callRpc('turn/steer', {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedTurnId,
      input: buildTurnInput(text, images, skills),
    })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to steer turn for thread ${normalizedThreadId}`, 'turn/steer')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}
