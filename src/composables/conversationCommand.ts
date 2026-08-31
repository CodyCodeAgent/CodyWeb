import type { ComposerSubmission } from '@codycodeagent/cody-web-core/composer'
import type { UiComposerContextKind } from '../types/codex'

export type PendingConversationCommand = {
  id: string
  threadId: string
  text: string
  images: ComposerSubmission<UiComposerContextKind>['images']
  skills: ComposerSubmission<UiComposerContextKind>['skills']
  contexts?: ComposerSubmission<UiComposerContextKind>['contexts']
}

/** Builds an ephemeral command for the current submit call. Core owns every
 * lifecycle state after this value is handed off; it is never persisted or
 * replayed by the browser. */
export function buildPendingConversationCommand(input: {
  threadId: string
  payload: ComposerSubmission<UiComposerContextKind>
}): PendingConversationCommand {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return {
    id: `command:${randomId}`,
    threadId: input.threadId,
    text: input.payload.text.trim(),
    images: input.payload.images.map((image) => ({ ...image })),
    skills: input.payload.skills.map((skill) => ({ ...skill })),
    contexts: input.payload.contexts?.map((context) => ({ ...context, metadata: { ...context.metadata } })),
  }
}
