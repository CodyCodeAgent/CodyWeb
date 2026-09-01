import { describe, expect, it } from 'vitest'
import { buildRollbackAuditMessage } from './desktopMessageState'
import { buildThreadActivityEntries } from './useThreadActivity'
import type { UiToolingRollbackFileResult } from '../types/codex'

function buildRollbackResult(overrides: Partial<UiToolingRollbackFileResult> = {}): UiToolingRollbackFileResult {
  return {
    cwd: '/workspace/app',
    repoRoot: '/workspace/app',
    filePath: 'src/app.ts',
    relativePath: 'src/app.ts',
    rollbackApplied: true,
    remainingStatus: '',
    checkpoint: {
      id: 'checkpoint-1',
      label: 'Before rollback',
      cwd: '/workspace/app',
      repoRoot: '/workspace/app',
      createdAtIso: '2026-07-05T00:00:00.000Z',
      paths: ['src/app.ts'],
      patchPath: '/tmp/checkpoint-1.patch',
      patchBytes: 42,
      hasPatch: true,
    },
    ...overrides,
  }
}

describe('buildRollbackAuditMessage', () => {
  it('creates an auditable tool message for successful file rollbacks', () => {
    const message = buildRollbackAuditMessage(buildRollbackResult())

    expect(message).toMatchObject({
      id: 'tooling.rollback:checkpoint-1:src/app.ts',
      role: 'system',
      messageType: 'tool.rollback',
      tool: {
        kind: 'rollback',
        title: 'File rollback',
        status: 'completed',
        summary: 'Rolled back src/app.ts',
        outputLabel: 'Checkpoint patch',
      },
    })
    expect(message.tool?.details).toContain('checkpoint: checkpoint-1')
    expect(message.tool?.details).toContain('remaining status: clean')
    expect(buildThreadActivityEntries([message])[0]).toMatchObject({
      kind: 'rollback',
      messageId: message.id,
    })
  })

  it('records no-op rollback attempts without marking them as failures', () => {
    const message = buildRollbackAuditMessage(buildRollbackResult({ rollbackApplied: false }))
    expect(message.tool?.status).toBe('no changes')
    expect(message.tool?.summary).toBe('No local changes found for src/app.ts')
  })
})
