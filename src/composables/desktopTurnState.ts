import {
  composerHasContent,
  normalizeComposerSubmission,
  type ComposerSubmission,
} from '@codycodeagent/cody-web-core/composer'
import type { UiComposerContextKind } from '../types/codex'

export type NormalizedComposerTurnInput = {
  text: string
  images: ComposerSubmission<UiComposerContextKind>['images']
  skills: ComposerSubmission<UiComposerContextKind>['skills']
  hasContent: boolean
}

export type NormalizedThreadTextTurnInput = NormalizedComposerTurnInput & { threadId: string }
export type NormalizedNewThreadTurnInput = NormalizedComposerTurnInput & { targetCwd: string }

export function normalizeComposerTurnInput(payload: ComposerSubmission<UiComposerContextKind>): NormalizedComposerTurnInput {
  const input = normalizeComposerSubmission(payload)
  return { text: input.text, images: input.images, skills: input.skills, hasContent: input.hasContent }
}

export function normalizeThreadTextTurnInput(threadId: string, text: string): NormalizedThreadTextTurnInput {
  const input = { threadId: threadId.trim(), text: text.trim(), images: [], skills: [] }
  return { ...input, hasContent: composerHasContent(input) }
}

export function normalizeNewThreadTurnInput(
  payload: ComposerSubmission<UiComposerContextKind>,
  cwd: string,
): NormalizedNewThreadTurnInput {
  return { ...normalizeComposerTurnInput(payload), targetCwd: cwd.trim() }
}
