import type { UiMessage, UiToolingRollbackFileResult } from '../types/codex'

/** CodyWeb-owned product audit card. Conversation ordering, message identity,
 * optimistic delivery, overlays and terminal receipts belong exclusively to
 * CodyWebCore and must not be reimplemented in this product layer. */
export function buildRollbackAuditMessage(result: UiToolingRollbackFileResult): UiMessage {
  const remainingStatus = result.remainingStatus.trim()
  const checkpoint = result.checkpoint
  return {
    id: `tooling.rollback:${checkpoint.id}:${result.relativePath}`,
    role: 'system',
    text: '',
    messageType: 'tool.rollback',
    tool: {
      kind: 'rollback',
      title: 'File rollback',
      status: result.rollbackApplied ? 'completed' : 'no changes',
      summary: result.rollbackApplied
        ? `Rolled back ${result.relativePath}`
        : `No local changes found for ${result.relativePath}`,
      details: [
        `file: ${result.relativePath}`,
        `checkpoint: ${checkpoint.id}`,
        `patch bytes: ${String(checkpoint.patchBytes)}`,
        `remaining status: ${remainingStatus || 'clean'}`,
      ],
      output: checkpoint.patchPath,
      outputLabel: 'Checkpoint patch',
    },
  }
}
