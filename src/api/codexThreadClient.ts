import type { ReasoningEffort } from '@codycodeagent/cody-web-core/protocol'
import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import { normalizeCatalogThreadGroups } from './normalizers/v2'
import { toLocalImagePreviewUrl } from './normalizers/userMessageContent'
import type { UiMessage, UiProjectGroup } from '../types/codex'
import type { TurnPermissionOverride } from '../composables/desktopTurnPermissions'
import { buildTurnUserInput, CodexSessionCatalog, CodexThreadCommands } from '@codycodeagent/cody-web-core/session'
import {
  conversationTranscriptFromState,
  createConversationState,
  reduceConversationEvents,
  type CodexEvent,
} from '@codycodeagent/cody-web-core/conversation'
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

const sessionCatalog = new CodexSessionCatalog({ call: callRpc })
const threadCommands = new CodexThreadCommands({ call: callRpc })

async function getThreadGroupsV2(archived = false): Promise<UiProjectGroup[]> {
  return normalizeCatalogThreadGroups(await sessionCatalog.listThreads({ archived }))
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return []
  const snapshot = await sessionCatalog.readThreadSnapshot(normalizedThreadId)
  return normalizeThreadMessages(normalizedThreadId, snapshot.events)
}

function normalizeThreadMessages(threadId: string, events: CodexEvent[]): UiMessage[] {
  const state = reduceConversationEvents(createConversationState(threadId), events)
  return conversationTranscriptFromState(state).map((message): UiMessage => ({
    ...message,
    ...(message.images?.length ? {
      images: message.images.map((image) => image.startsWith('/') ? toLocalImagePreviewUrl(image) : image),
    } : {}),
    ...(message.skills?.length ? {
      skills: message.skills.map((skill) => ({
        ...skill,
        displayName: skill.displayName ?? skill.name,
        description: '',
      })),
    } : {}),
  }))
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

/**
 * A persisted browser activity flag is only a hint. It can survive a server
 * restart or a dropped terminal notification, so queue admission must defer
 * to Codex's native thread status when no local turn id is known.
 */
export async function getThreadRuntimeStatus(threadId: string): Promise<'notLoaded' | 'idle' | 'systemError' | 'active'> {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return 'notLoaded'
  try {
    return (await sessionCatalog.readThreadSnapshot(normalizedThreadId, false)).summary.status
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to read runtime status for thread ${normalizedThreadId}`, 'thread/read')
  }
}

export async function resumeThread(threadId: string): Promise<void> {
  await threadCommands.resumeThread(threadId)
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
    const params = buildTurnStartParams(text, images, skills, model, effort, collaborationMode, permissionOverride)
    return await threadCommands.startTurn(threadId, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

/**
 * A browser can retain the prior App Server generation after the server has
 * restarted. The shared Core command retries only an explicit native
 * `thread not found` by materializing the durable thread once before retrying
 * the turn. Timeouts and generic RPC errors are deliberately never retried.
 */
export async function startThreadTurnWithResumeRecovery(
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
    const params = buildTurnStartParams(text, images, skills, model, effort, collaborationMode, permissionOverride)
    return await threadCommands.startTurnWithResumeRecovery(threadId, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

function buildTurnStartParams(
  text: string,
  images: ComposerImage[],
  skills: ComposerSkill[],
  model?: string,
  effort?: ReasoningEffort,
  collaborationMode?: TurnCollaborationMode | null,
  permissionOverride?: TurnPermissionOverride | null,
) {
  return {
    input: buildTurnInput(text, images, skills),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    ...(permissionOverride?.approvalPolicy ? { approvalPolicy: permissionOverride.approvalPolicy } : {}),
    ...(permissionOverride?.sandboxPolicy ? { sandboxPolicy: permissionOverride.sandboxPolicy } : {}),
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
    await threadCommands.steerTurn(normalizedThreadId, normalizedTurnId, buildTurnInput(text, images, skills))
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to steer turn for thread ${normalizedThreadId}`, 'turn/steer')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    await threadCommands.interruptTurn(normalizedThreadId, normalizedTurnId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}
