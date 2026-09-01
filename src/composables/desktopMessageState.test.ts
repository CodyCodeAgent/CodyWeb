import { describe, expect, it } from 'vitest'
import { buildRollbackAuditMessage } from './desktopMessageState'
import type { UiToolingRollbackFileResult } from '../types/codex'

function rollbackResult(overrides: Partial<UiToolingRollbackFileResult> = {}): UiToolingRollbackFileResult {
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
      createdAtIso: '2026-07-07T00:00:00.000Z',
      paths: ['src/app.ts'],
      patchPath: '/workspace/app/.git/cody-web-ui-checkpoints/checkpoint-1/workspace.patch',
      patchBytes: 128,
      hasPatch: true,
    },
    ...overrides,
  }
}

describe('desktopMessageState product audit cards', () => {
  it('builds a completed rollback card', () => {
    expect(buildRollbackAuditMessage(rollbackResult())).toMatchObject({
      messageType: 'tool.rollback',
      tool: { status: 'completed', summary: 'Rolled back src/app.ts' },
    })
  })

  it('builds a no-change rollback card without owning conversation state', () => {
    expect(buildRollbackAuditMessage(rollbackResult({ rollbackApplied: false }))).toMatchObject({
      messageType: 'tool.rollback',
      tool: { status: 'no changes', summary: 'No local changes found for src/app.ts' },
    })
  })
})
