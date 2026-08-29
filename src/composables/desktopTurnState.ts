import {
  DEFAULT_COLLABORATION_MODE,
  composerHasContent,
  normalizeComposerSubmission,
  type ComposerCollaborationModeOption,
  type ComposerSubmission,
  type KnownReasoningEffort,
} from '@codycodeagent/cody-web-core/composer'
import type { UiComposerContextKind } from '../types/codex'
import type { TurnActivityState } from './desktopMessageState'

export type NormalizedComposerTurnInput = {
  text: string
  images: ComposerSubmission<UiComposerContextKind>['images']
  skills: ComposerSubmission<UiComposerContextKind>['skills']
  hasContent: boolean
}

export type NormalizedThreadTextTurnInput = NormalizedComposerTurnInput & {
  threadId: string
}

export type NormalizedNewThreadTurnInput = NormalizedComposerTurnInput & {
  targetCwd: string
}

export function normalizeComposerTurnInput(payload: ComposerSubmission<UiComposerContextKind>): NormalizedComposerTurnInput {
  const input = normalizeComposerSubmission(payload)
  return {
    text: input.text,
    images: input.images,
    skills: input.skills,
    hasContent: input.hasContent,
  }
}

export function normalizeThreadTextTurnInput(threadId: string, text: string): NormalizedThreadTextTurnInput {
  const input = {
    threadId: threadId.trim(),
    text: text.trim(),
    images: [],
    skills: [],
  }
  return {
    ...input,
    hasContent: composerHasContent(input),
  }
}

export function normalizeNewThreadTurnInput(
  payload: ComposerSubmission<UiComposerContextKind>,
  cwd: string,
): NormalizedNewThreadTurnInput {
  return {
    ...normalizeComposerTurnInput(payload),
    targetCwd: cwd.trim(),
  }
}

function buildPendingTurnDetails(
  modelId: string,
  effort: KnownReasoningEffort | '',
  mode: ComposerCollaborationModeOption = DEFAULT_COLLABORATION_MODE,
): string[] {
  const details = [
    `Model: ${modelId.trim() || 'default'}`,
    `Thinking: ${effort || 'default'}`,
  ]
  if (mode.mode !== 'default') details.unshift(`Mode: ${mode.label}`)
  return details
}

export function buildPendingTurnActivity(params: {
  modelId: string
  reasoningEffort: KnownReasoningEffort | ''
  mode: ComposerCollaborationModeOption
}): TurnActivityState {
  return {
    label: 'Thinking',
    details: buildPendingTurnDetails(params.modelId, params.reasoningEffort, params.mode),
  }
}

export function buildSteeringTurnActivity(params: {
  modelId: string
  reasoningEffort: KnownReasoningEffort | ''
}): TurnActivityState {
  return {
    label: 'Steering response',
    details: buildPendingTurnDetails(
      params.modelId,
      params.reasoningEffort,
      DEFAULT_COLLABORATION_MODE,
    ),
  }
}
