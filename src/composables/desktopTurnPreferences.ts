import type { ReasoningEffort, UiCollaborationModeOption } from '../types/codex'

export const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

export const DEFAULT_COLLABORATION_MODE: UiCollaborationModeOption = {
  name: 'default',
  mode: 'default',
  label: 'Default',
  model: '',
  reasoningEffort: '',
  developerInstructions: null,
}

export const FALLBACK_PLAN_COLLABORATION_MODE: UiCollaborationModeOption = {
  name: 'plan',
  mode: 'plan',
  label: 'Plan',
  model: '',
  reasoningEffort: '',
  developerInstructions: null,
}

export type CurrentModelPreference = {
  model: string
  reasoningEffort: ReasoningEffort | ''
}

export type TurnCollaborationModePayload = {
  mode: UiCollaborationModeOption['mode']
  settings: {
    model: string
    reasoning_effort: ReasoningEffort | null
    developer_instructions: string | null
  }
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.includes(value as ReasoningEffort)
}

export function normalizeSelectedReasoningEffort(effort: ReasoningEffort | ''): ReasoningEffort | '' | null {
  if (!effort) return ''
  return isReasoningEffort(effort) ? effort : null
}

export function mergeCollaborationModeOptions(
  remoteOptions: UiCollaborationModeOption[],
): UiCollaborationModeOption[] {
  const nextOptions: UiCollaborationModeOption[] = [DEFAULT_COLLABORATION_MODE]
  const seenModes = new Set<string>([DEFAULT_COLLABORATION_MODE.mode])
  const seenNames = new Set<string>([DEFAULT_COLLABORATION_MODE.name])

  for (const option of remoteOptions) {
    if (option.mode === 'default') continue
    if (seenNames.has(option.name)) continue
    seenNames.add(option.name)
    seenModes.add(option.mode)
    nextOptions.push(option)
  }

  if (!seenModes.has('plan')) {
    nextOptions.push(FALLBACK_PLAN_COLLABORATION_MODE)
  }

  return nextOptions
}

export function selectCollaborationModeName(
  requestedName: string,
  options: UiCollaborationModeOption[],
): string {
  const normalizedName = requestedName.trim()
  if (!normalizedName) return DEFAULT_COLLABORATION_MODE.name
  const option = options.find((candidate) =>
    candidate.name === normalizedName ||
    candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
  )
  return option?.name ?? ''
}

export function reconcileSelectedCollaborationModeName(
  selectedName: string,
  options: UiCollaborationModeOption[],
): string {
  const normalizedName = selectedName.trim()
  const option = options.find((candidate) =>
    candidate.name === normalizedName ||
    candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
  )
  if (option) return option.name

  const modeAlias = normalizedName.toLocaleLowerCase()
  if (modeAlias === 'plan' || modeAlias === 'default') {
    return options.find((candidate) => candidate.mode === modeAlias)?.name
      ?? DEFAULT_COLLABORATION_MODE.name
  }
  return DEFAULT_COLLABORATION_MODE.name
}

export function buildPendingTurnDetails(
  modelId: string,
  effort: ReasoningEffort | '',
  mode: UiCollaborationModeOption = DEFAULT_COLLABORATION_MODE,
): string[] {
  const modelLabel = modelId.trim() || 'default'
  const effortLabel = effort || 'default'
  const details = [`Model: ${modelLabel}`, `Thinking: ${effortLabel}`]
  if (mode.mode !== 'default') {
    details.unshift(`Mode: ${mode.label}`)
  }
  return details
}

export function buildTurnCollaborationMode(
  option: UiCollaborationModeOption,
  fallbackModel: string,
  fallbackEffort: ReasoningEffort | '',
): TurnCollaborationModePayload | null {
  if (option.mode !== 'default' && option.mode !== 'plan') return null

  return {
    mode: option.mode,
    settings: {
      model: option.model.trim() || fallbackModel.trim(),
      reasoning_effort: option.reasoningEffort || fallbackEffort || null,
      developer_instructions: option.developerInstructions,
    },
  }
}

export function mergeAvailableModelsWithCurrent(
  modelIds: string[],
  currentModel: string,
): string[] {
  const normalizedCurrent = currentModel.trim()
  if (!normalizedCurrent || modelIds.includes(normalizedCurrent)) return modelIds
  return [normalizedCurrent, ...modelIds]
}

export function selectModelId(
  currentSelectedModelId: string,
  modelIds: string[],
  currentModel: string,
): string {
  const normalizedSelected = currentSelectedModelId.trim()
  if (normalizedSelected && modelIds.includes(normalizedSelected)) {
    return normalizedSelected
  }
  const normalizedCurrent = currentModel.trim()
  if (normalizedCurrent) return normalizedCurrent
  return modelIds[0] ?? ''
}

export function selectReasoningEffortFromPreference(
  currentSelectedEffort: ReasoningEffort | '',
  currentConfig: CurrentModelPreference,
): ReasoningEffort | '' {
  return currentConfig.reasoningEffort && isReasoningEffort(currentConfig.reasoningEffort)
    ? currentConfig.reasoningEffort
    : currentSelectedEffort
}
