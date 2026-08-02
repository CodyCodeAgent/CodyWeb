import type {
  CollaborationModeListResponse,
  ConfigReadResponse,
  ModelListResponse,
  ReasoningEffort,
} from './appServerDtos'
import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import type { UiCollaborationModeOption } from '../types/codex'

export type CurrentModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort | ''
  modelContextWindow: number | null
  autoCompactTokenLimit: number | null
}

type CollaborationModeRow = Omit<
  CollaborationModeListResponse['data'][number],
  'developer_instructions'
> & {
  // Codex 0.144 no longer returns this field from collaborationMode/list.
  // Keep accepting it for compatibility with older app-server versions.
  developer_instructions?: string | null
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  const allowed: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  return typeof value === 'string' && allowed.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
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

function normalizeCollaborationModeLabel(name: string, mode: UiCollaborationModeOption['mode']): string {
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
): UiCollaborationModeOption | null {
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

export async function getCollaborationModes(): Promise<UiCollaborationModeOption[]> {
  const payload = await callRpc<CollaborationModeListResponse>('collaborationMode/list', {})
  const options: UiCollaborationModeOption[] = []
  const seen = new Set<string>()

  for (const row of payload.data) {
    const option = normalizeCollaborationModeOption(row)
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
  const payload = await callRpc<ModelListResponse>('model/list', {})
  const ids: string[] = []
  for (const row of payload.data) {
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
