import type {
  ConfigReadResponse,
} from './appServerDtos'
import {
  isKnownReasoningEffort,
  type ComposerCollaborationModeOption,
  type KnownReasoningEffort,
} from '@codycodeagent/cody-web-core/composer'
import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import { fetchCodexJson, readRpcResult } from './codexHttpClient'
import type { CodexCollaborationModeOption, CodexModelOption } from '@codycodeagent/cody-web-core/session'

export type CurrentModelConfig = {
  model: string
  reasoningEffort: KnownReasoningEffort | ''
  modelContextWindow: number | null
  autoCompactTokenLimit: number | null
}

type CollaborationModeRow = {
  name: string
  mode: string
  model?: string | null
  reasoning_effort?: unknown
  developer_instructions?: string | null
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

async function getOwnerResult<T>(path: string, method: string): Promise<T> {
  const { payload, status } = await fetchCodexJson(path, {
    init: { method: 'GET' },
    method,
    networkErrorMessage: `${method} request failed before it was sent`,
    httpErrorMessage: `${method} request failed`,
    timeoutMs: 25_000,
  })
  return readRpcResult(payload, status, method, `${method} returned malformed envelope`) as T
}

export function normalizeReasoningEffort(value: unknown): KnownReasoningEffort | '' {
  return typeof value === 'string' && isKnownReasoningEffort(value) ? value : ''
}

export function normalizeTokenLimit(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function normalizeCollaborationModeLabel(name: string, mode: ComposerCollaborationModeOption['mode']): string {
  const normalizedName = name.trim()
  if (normalizedName.length > 0) {
    return normalizedName
      .replace(/[-_]+/gu, ' ')
      .replace(/\b\w/gu, (letter) => letter.toUpperCase())
  }
  return mode === 'plan' ? 'Plan' : 'Default'
}

export function normalizeCollaborationModeOption(
  row: CollaborationModeRow,
): ComposerCollaborationModeOption | null {
  const mode = row.mode === 'plan' || row.mode === 'default' ? row.mode : null
  if (!mode) return null
  const name = row.name.trim() || mode
  return {
    name,
    mode,
    label: normalizeCollaborationModeLabel(name, mode),
    model: row.model?.trim() ?? '',
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    developerInstructions: typeof row.developer_instructions === 'string'
      ? row.developer_instructions
      : null,
  }
}

export async function getCollaborationModes(): Promise<ComposerCollaborationModeOption[]> {
  const rows = await getOwnerResult<CodexCollaborationModeOption[]>('/codex-api/conversations/collaboration-modes', 'conversation/collaboration-modes/list')
  const options: ComposerCollaborationModeOption[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const option = normalizeCollaborationModeOption({
      name: row.name,
      mode: row.mode as CollaborationModeRow['mode'],
      model: row.model || null,
      reasoning_effort: row.reasoningEffort || null,
      developer_instructions: null,
    })
    if (!option) continue
    if (seen.has(option.name)) continue
    seen.add(option.name)
    options.push(option)
  }

  return options
}

export async function setDefaultModel(model: string): Promise<void> {
  await callRpc('setDefaultModel', { model })
}

export async function getAvailableModelIds(): Promise<string[]> {
  const ids: string[] = []
  for (const row of await getOwnerResult<CodexModelOption[]>('/codex-api/conversations/models', 'conversation/models/list')) {
    const candidate = row.id || row.model
    if (!candidate || ids.includes(candidate)) continue
    ids.push(candidate)
  }
  return ids
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  return {
    model,
    reasoningEffort,
    modelContextWindow: normalizeTokenLimit(payload.config.model_context_window),
    autoCompactTokenLimit: normalizeTokenLimit(payload.config.model_auto_compact_token_limit),
  }
}
