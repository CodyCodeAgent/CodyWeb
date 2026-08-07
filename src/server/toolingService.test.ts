import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceDiffSnapshot,
  getWorkspaceGitStatus,
  getWorkspaceGitDeliveryDraft,
  getWorkspaceReviewDraft,
  getWorkspacePullRequestDraft,
  commitStagedWorkspaceChanges,
  createWorkspacePullRequest,
  getWorkspaceSnapshot,
  getWorkspaceSecuritySnapshot,
  getWorkspacePorts,
  probeWorkspacePreview,
  captureWorkspacePreviewScreenshot,
  createWorkspaceReviewComment,
  createWorkspaceReviewFollowUp,
  listWorkspaceReviewComments,
  updateWorkspaceReviewCommentStatus,
  listWorkspaceFiles,
  searchWorkspace,
  readWorkspaceFile,
  readWorkspaceAsset,
  writeWorkspaceFile,
  createToolingCheckpoint,
  getToolingCheckpointHealth,
  listToolingCheckpoints,
  readToolingCheckpointPatch,
  rollbackWorkspaceFile,
  rollbackWorkspaceHunk,
  rollbackWorkspaceChanges,
  stageWorkspaceHunk,
  runWorkspaceScript,
  runWorkspaceGitPathAction,
  parseLsofListeningPorts,
  parseGitWorktreePorcelain,
  parseWorkspaceProblems,
  listWorkspaceAuditEvents,
  listWorkspaceValidationRuns,
  listWorkspaceTerminalSessions,
  startWorkspaceTerminalSession,
  listWorkspaceWorktrees,
  createWorkspaceWorktree,
  removeWorkspaceWorktree,
  applyWorkspacePatchToWorktree,
  evaluatePortPolicy,
  evaluateWorkspaceFileChangePolicy,
  evaluateWorkspaceCommandPolicy,
  listWorkspaceWorkflows,
  createWorkspaceWorkflowRun,
  updateWorkspaceWorkflowAgentStatus,
  provisionWorkspaceWorkflowAgentWorktree,
  applyWorkspaceWorkflowImplementation,
  discardWorkspaceWorkflowImplementation,
  getWorkspaceWorkflowReplay,
  getWorkspaceWorkflowDeliveryDraft,
  markWorkspaceWorkflowReadyToMerge,
  markWorkspaceWorkflowMerged,
  runWorkspaceWorkflowValidation,
  buildApprovalGrantKey,
  createPersistentApprovalGrant,
  findMatchingApprovalGrant,
  listApprovalGrants,
  revokeApprovalGrant,
  recordApprovalDecisionAuditEvent,
} from './toolingService'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

// This suite provisions real Git worktrees and can cross 15 seconds on a busy
// CI host even though the underlying operations complete successfully.
vi.setConfig({ testTimeout: 30_000 })

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-tooling-'))
  tempDirs.push(dir)
  await git(dir, ['init'])
  await git(dir, ['config', 'user.email', 'cody-web-ui@example.test'])
  await git(dir, ['config', 'user.name', 'CodyWeb'])
  await writeFile(join(dir, 'example.txt'), 'one\n', 'utf8')
  await git(dir, ['add', 'example.txt'])
  await git(dir, ['commit', '-m', 'initial'])
  return dir
}

async function createPreviewServer(body: string, statusCode = 200): Promise<{
  server: Server
  url: string
}> {
  const server = createServer((_req, res) => {
    res.statusCode = statusCode
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/`,
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })))
})

describe('toolingService', () => {
  it('parses listening ports from lsof field output', () => {
    const ports = parseLsofListeningPorts([
      'p100',
      'cnode',
      'f11',
      'PTCP',
      'n127.0.0.1:5173',
      'f12',
      'PTCP',
      'n127.0.0.1:5173',
      'p200',
      'cPreview',
      'f8',
      'PTCP',
      'n*:4173',
      'p300',
      'cApi',
      'f9',
      'PTCP',
      'n[::1]:3000',
    ].join('\n'))

    expect(ports).toEqual([
      expect.objectContaining({
        host: '::1',
        port: 3000,
        processName: 'Api',
        exposure: 'loopback',
        url: 'http://[::1]:3000/',
      }),
      expect.objectContaining({
        host: '*',
        port: 4173,
        processName: 'Preview',
        exposure: 'wildcard',
        url: 'http://127.0.0.1:4173/',
      }),
      expect.objectContaining({
        host: '127.0.0.1',
        port: 5173,
        processName: 'node',
        exposure: 'loopback',
        url: 'http://127.0.0.1:5173/',
      }),
    ])
  })

  it('evaluates workspace port exposure policy', () => {
    const config = {
      allow: ['3000-3999', '5173'],
      deny: ['0-1023', '6666'],
      allowExternal: false,
      allowWildcard: false,
    }

    expect(evaluatePortPolicy({
      config,
      port: 5173,
      exposure: 'loopback',
    })).toMatchObject({
      status: 'allowed',
      matchedRule: 'allow:5173',
    })
    expect(evaluatePortPolicy({
      config,
      port: 3001,
      exposure: 'loopback',
    })).toMatchObject({
      status: 'allowed',
      matchedRule: 'allow:3000-3999',
    })
    expect(evaluatePortPolicy({
      config,
      port: 6666,
      exposure: 'loopback',
    })).toMatchObject({
      status: 'denied',
      matchedRule: 'deny:6666',
    })
    expect(evaluatePortPolicy({
      config,
      port: 8080,
      exposure: 'loopback',
    })).toMatchObject({
      status: 'denied',
      matchedRule: 'allowlist',
    })
    expect(evaluatePortPolicy({
      config: {
        allow: ['4173'],
        deny: [],
        allowExternal: false,
        allowWildcard: false,
      },
      port: 4173,
      exposure: 'wildcard',
    })).toMatchObject({
      status: 'denied',
      matchedRule: 'allowWildcard=false',
    })
    expect(evaluatePortPolicy({
      config: {
        allow: [],
        deny: [],
        allowExternal: false,
        allowWildcard: false,
      },
      port: 9000,
      exposure: 'external',
    })).toMatchObject({
      status: 'denied',
      matchedRule: 'allowExternal=false',
    })
  })

  it('probes localhost previews and records audit evidence', async () => {
    const repo = await createRepo()
    const resolvedRepo = await realpath(repo)
    const { server, url } = await createPreviewServer('<!doctype html><title>Preview OK</title><main>Hello preview</main>')
    try {
      const result = await probeWorkspacePreview({ cwd: repo, url })

      expect(result).toMatchObject({
        cwd: resolvedRepo,
        root: resolvedRepo,
        url,
        status: 'passed',
        statusCode: 200,
        title: 'Preview OK',
        errorMessage: '',
      })
      expect(result.bodyPreview).toContain('Hello preview')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      const audit = await listWorkspaceAuditEvents({ cwd: repo, limit: 5 })
      expect(audit.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'preview.probed',
          severity: 'success',
          metadata: expect.objectContaining({
            url,
            status: 'passed',
            statusCode: 200,
          }),
        }),
      ]))
    } finally {
      await closeServer(server)
    }
  })

  it('limits preview probes to loopback URLs', async () => {
    await expect(probeWorkspacePreview({
      cwd: await createRepo(),
      url: 'https://example.com/',
    })).rejects.toThrow('Preview probes are limited to localhost and loopback URLs')
  })

  it('captures localhost preview screenshot evidence and records audit evidence', async () => {
    const repo = await createRepo()
    const resolvedRepo = await realpath(repo)
    const { server, url } = await createPreviewServer([
      '<!doctype html>',
      '<title>Screenshot OK</title>',
      '<main style="font-family: system-ui; padding: 32px;">',
      '<h1>Screenshot preview</h1>',
      '<p>Evidence body from local preview.</p>',
      '</main>',
    ].join(''))
    try {
      const result = await captureWorkspacePreviewScreenshot({
        cwd: repo,
        url,
        width: 640,
        height: 480,
      })

      expect(result).toMatchObject({
        cwd: resolvedRepo,
        root: resolvedRepo,
        url,
        status: 'captured',
        width: 640,
        height: 480,
        title: 'Screenshot OK',
      })
      expect(result.dataUrl).toMatch(/^data:image\/(png|svg\+xml);base64,/u)
      expect(result.bytes).toBeGreaterThan(0)
      expect(result.bodyPreview).toContain('Evidence body')
      expect(['browser', 'evidence-card']).toContain(result.source)

      const audit = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
      expect(audit.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'preview.screenshot_captured',
          severity: 'success',
          metadata: expect.objectContaining({
            url,
            width: 640,
            height: 480,
            title: 'Screenshot OK',
          }),
        }),
      ]))
    } finally {
      await closeServer(server)
    }
  }, 35_000)

  it('limits preview screenshots to loopback URLs', async () => {
    await expect(captureWorkspacePreviewScreenshot({
      cwd: await createRepo(),
      url: 'https://example.com/',
    })).rejects.toThrow('Preview probes are limited to localhost and loopback URLs')
  })

  it('persists review comments and creates follow-up workflow tasks', async () => {
    const repo = await createRepo()
    const comment = await createWorkspaceReviewComment({
      cwd: repo,
      body: 'Please add a regression test for this branch.',
      anchor: {
        filePath: 'example.txt',
        hunkHeader: '@@ -1 +1 @@',
        lineKind: 'add',
        oldLineNumber: null,
        newLineNumber: 1,
        lineContent: 'two',
      },
    })

    expect(comment).toMatchObject({
      status: 'open',
      body: 'Please add a regression test for this branch.',
      followUpRunId: null,
      anchor: expect.objectContaining({
        filePath: 'example.txt',
        newLineNumber: 1,
      }),
    })

    const listed = await listWorkspaceReviewComments(repo)
    expect(listed.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: comment.id }),
    ]))

    const followUp = await createWorkspaceReviewFollowUp({
      cwd: repo,
      commentId: comment.id,
    })
    expect(followUp.comment).toMatchObject({
      id: comment.id,
      status: 'follow_up_created',
      followUpRunId: followUp.workflowRun.id,
    })
    expect(followUp.workflowRun).toMatchObject({
      templateId: 'review-diff',
      goal: expect.stringContaining('Please add a regression test'),
    })

    const resolved = await updateWorkspaceReviewCommentStatus({
      cwd: repo,
      commentId: comment.id,
      status: 'resolved',
    })
    expect(resolved.status).toBe('resolved')
    expect(resolved.followUpRunId).toBe(followUp.workflowRun.id)

    const audit = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(audit.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'review.comment_created',
      'review.follow_up_created',
      'review.comment_status_updated',
    ]))
  })

  it('parses git worktree porcelain output', () => {
    const worktrees = parseGitWorktreePorcelain([
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo.worktrees/codex-task',
      'HEAD def456',
      'branch refs/heads/codex/task',
      '',
      'worktree /repo.worktrees/stale',
      'HEAD 000000',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'), '/repo/main', '/repo.worktrees')

    expect(worktrees).toEqual([
      expect.objectContaining({
        path: '/repo/main',
        branch: 'main',
        head: 'abc123',
        isCurrent: true,
        isManaged: false,
      }),
      expect.objectContaining({
        path: '/repo.worktrees/codex-task',
        branch: 'codex/task',
        head: 'def456',
        isCurrent: false,
        isManaged: true,
      }),
      expect.objectContaining({
        path: '/repo.worktrees/stale',
        branch: '',
        detached: true,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      }),
    ])
  })

  it('parses validation output into workspace problems', () => {
    const problems = parseWorkspaceProblems([
      'src/example.ts(4,8): error TS2322: Type number is not assignable to string.',
      'src/lint.ts',
      '  10:5  warning  Unexpected console statement  no-console',
      'Command failed with exit code 1',
    ].join('\n'), 'npm run typecheck')

    expect(problems).toEqual([
      expect.objectContaining({
        severity: 'error',
        source: 'TS2322',
        filePath: 'src/example.ts',
        line: 4,
        column: 8,
        message: 'Type number is not assignable to string.',
      }),
      expect.objectContaining({
        severity: 'warning',
        source: 'no-console',
        filePath: 'src/lint.ts',
        line: 10,
        column: 5,
        message: 'Unexpected console statement',
      }),
      expect.objectContaining({
        severity: 'error',
        source: 'command',
        filePath: '',
        message: 'Command failed with exit code 1',
      }),
    ])
  })

  it('captures a checkpoint before rolling back a tracked file', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')

    const before = await getWorkspaceDiffSnapshot(repo)
    expect(before.patch).toContain('-one')
    expect(before.patch).toContain('+two')

    const result = await rollbackWorkspaceFile({
      cwd: repo,
      filePath: 'example.txt',
    })

    expect(result.rollbackApplied).toBe(true)
    expect(result.relativePath).toBe('example.txt')
    expect(result.remainingStatus).toBe('')
    expect(result.checkpoint.hasPatch).toBe(true)
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('one\n')

    const checkpointPatch = await readToolingCheckpointPatch({
      cwd: repo,
      checkpointId: result.checkpoint.id,
    })
    expect(checkpointPatch.checkpoint.id).toBe(result.checkpoint.id)
    expect(checkpointPatch.patch).toContain('-one')
    expect(checkpointPatch.patch).toContain('+two')
  })

  it('backs up and removes untracked files during rollback', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'new-file.txt'), 'draft\n', 'utf8')

    const result = await rollbackWorkspaceFile({
      cwd: repo,
      filePath: 'new-file.txt',
    })

    expect(result.rollbackApplied).toBe(true)
    expect(result.remainingStatus).toBe('')
    await expect(readFile(join(repo, 'new-file.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(repo, '.git/cody-web-ui-checkpoints', result.checkpoint.id, 'untracked/new-file.txt'), 'utf8')).resolves.toBe('draft\n')
  })

  it('rolls back one modified hunk while preserving another hunk', async () => {
    const repo = await createRepo()
    const original = Array.from({ length: 24 }, (_, index) => `line ${String(index + 1)}`).join('\n') + '\n'
    await writeFile(join(repo, 'example.txt'), original, 'utf8')
    await git(repo, ['add', 'example.txt'])
    await git(repo, ['commit', '-m', 'expand example'])

    const changedLines = original.split('\n')
    changedLines[1] = 'line 2 changed'
    changedLines[19] = 'line 20 changed'
    await writeFile(join(repo, 'example.txt'), changedLines.join('\n'), 'utf8')

    const result = await rollbackWorkspaceHunk({
      cwd: repo,
      filePath: 'example.txt',
      hunkIndex: 0,
    })
    const content = await readFile(join(repo, 'example.txt'), 'utf8')

    expect(result).toMatchObject({
      relativePath: 'example.txt',
      hunkIndex: 0,
      rollbackApplied: true,
    })
    expect(result.checkpoint.hasPatch).toBe(true)
    expect(content).toContain('line 2\n')
    expect(content).toContain('line 20 changed\n')
    expect(content).not.toContain('line 2 changed')
  })

  it('rejects hunk rollback for newly added files', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'newer-file.txt'), 'new\n', 'utf8')
    await git(repo, ['add', '-N', 'newer-file.txt'])

    await expect(rollbackWorkspaceHunk({
      cwd: repo,
      filePath: 'newer-file.txt',
      hunkIndex: 0,
    })).rejects.toThrow('Hunk rollback only supports ordinary modified text files')
  })

  it('rolls back all tracked and untracked workspace changes after saving a checkpoint', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')
    await writeFile(join(repo, 'staged.txt'), 'staged\n', 'utf8')
    await git(repo, ['add', 'staged.txt'])
    await writeFile(join(repo, 'untracked.txt'), 'draft\n', 'utf8')

    const result = await rollbackWorkspaceChanges({ cwd: repo })
    const status = await git(repo, ['status', '--porcelain=v1'])
    const checkpointPatch = await readToolingCheckpointPatch({
      cwd: repo,
      checkpointId: result.checkpoint.id,
    })

    expect(result).toMatchObject({
      rollbackApplied: true,
      restoredFileCount: 2,
      removedUntrackedCount: 1,
      remainingStatus: expect.objectContaining({
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
      }),
    })
    expect(status).toBe('')
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('one\n')
    await expect(readFile(join(repo, 'staged.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(repo, 'untracked.txt'), 'utf8')).rejects.toThrow()
    expect(checkpointPatch.patch).toContain('+two')
    expect(checkpointPatch.patch).toContain('+staged')
    await expect(readFile(join(repo, '.git/cody-web-ui-checkpoints', result.checkpoint.id, 'untracked/untracked.txt'), 'utf8')).resolves.toBe('draft\n')
  })

  it('records auditable rollback and checkpoint events', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')

    const rollback = await rollbackWorkspaceChanges({ cwd: repo })
    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })

    expect(auditTrail.events.map((event) => event.kind)).toEqual([
      'rollback.workspace',
      'checkpoint.created',
    ])
    expect(auditTrail.events[0]).toMatchObject({
      title: 'Workspace changes rolled back',
      severity: 'warning',
      metadata: expect.objectContaining({
        checkpointId: rollback.checkpoint.id,
        rollbackApplied: true,
        restoredFileCount: 1,
      }),
    })
    expect(auditTrail.events[1]).toMatchObject({
      title: 'Checkpoint created',
      metadata: expect.objectContaining({
        checkpointId: rollback.checkpoint.id,
        hasPatch: true,
      }),
    })
  })

  it('records approval decisions as workspace audit events', async () => {
    const repo = await createRepo()

    await recordApprovalDecisionAuditEvent({
      cwd: repo,
      requestId: 42,
      method: 'item/commandExecution/requestApproval',
      subject: 'npm test',
      receivedAtIso: '2026-07-05T10:00:00.000Z',
      resolvedAtIso: '2026-07-05T10:00:03.000Z',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      decision: 'acceptForSession',
      scope: 'session',
      mode: 'manual',
      errorMessage: '',
    })

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 5 })

    expect(auditTrail.events[0]).toMatchObject({
      kind: 'approval.decision',
      severity: 'success',
      title: 'Approval granted',
      summary: 'item/commandExecution/requestApproval approved for session scope.',
      metadata: expect.objectContaining({
        requestId: 42,
        method: 'item/commandExecution/requestApproval',
        subject: 'npm test',
        decision: 'acceptForSession',
        scope: 'session',
        threadId: 'thread-1',
      }),
    })
  })

  it('creates, matches, lists, and revokes workspace approval grants', async () => {
    const repo = await createRepo()
    const command = 'npm test -- --runInBand'
    const method = 'item/commandExecution/requestApproval'

    const grant = await createPersistentApprovalGrant({
      cwd: repo,
      requestId: 77,
      method,
      subject: command,
      receivedAtIso: '2026-07-05T10:00:00.000Z',
      resolvedAtIso: '2026-07-05T10:00:03.000Z',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      decision: 'accept',
      scope: 'workspace',
      mode: 'manual',
      errorMessage: '',
    })

    expect(grant).toMatchObject({
      method,
      subject: command,
      key: buildApprovalGrantKey(method, command),
      scope: 'workspace',
    })
    await expect(findMatchingApprovalGrant({ cwd: repo, method, subject: command })).resolves.toMatchObject({
      id: grant?.id,
      scope: 'workspace',
    })

    const listed = await listApprovalGrants(repo)
    expect(listed.grants).toEqual([expect.objectContaining({ id: grant?.id })])

    const revoked = await revokeApprovalGrant({ cwd: repo, grantId: grant?.id ?? '' })
    expect(revoked.grants).toEqual([])
    await expect(findMatchingApprovalGrant({ cwd: repo, method, subject: command })).resolves.toBeNull()

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'approval.grant_created',
      'approval.grant_revoked',
    ]))
  })

  it('stages one modified hunk while leaving the other hunk unstaged', async () => {
    const repo = await createRepo()
    const original = Array.from({ length: 24 }, (_, index) => `line ${String(index + 1)}`).join('\n') + '\n'
    await writeFile(join(repo, 'example.txt'), original, 'utf8')
    await git(repo, ['add', 'example.txt'])
    await git(repo, ['commit', '-m', 'expand example for staging'])

    const changedLines = original.split('\n')
    changedLines[1] = 'line 2 changed'
    changedLines[19] = 'line 20 changed'
    await writeFile(join(repo, 'example.txt'), changedLines.join('\n'), 'utf8')

    const result = await stageWorkspaceHunk({
      cwd: repo,
      filePath: 'example.txt',
      hunkIndex: 0,
    })
    const cachedDiff = await git(repo, ['diff', '--cached', '--', 'example.txt'])
    const unstagedDiff = await git(repo, ['diff', '--', 'example.txt'])

    expect(result).toMatchObject({
      relativePath: 'example.txt',
      hunkIndex: 0,
      status: expect.objectContaining({
        stagedFileCount: 1,
        unstagedFileCount: 1,
      }),
    })
    expect(cachedDiff).toContain('+line 2 changed')
    expect(cachedDiff).not.toContain('+line 20 changed')
    expect(unstagedDiff).not.toContain('+line 2 changed')
    expect(unstagedDiff).toContain('+line 20 changed')
  })

  it('lists recent checkpoints newest first', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')
    const first = await rollbackWorkspaceFile({ cwd: repo, filePath: 'example.txt' })

    await writeFile(join(repo, 'example.txt'), 'three\n', 'utf8')
    const second = await rollbackWorkspaceFile({ cwd: repo, filePath: 'example.txt' })

    const checkpoints = await listToolingCheckpoints({ cwd: repo, limit: 10 })
    const repoRoot = await realpath(repo)

    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([second.checkpoint.id, first.checkpoint.id])
    expect(checkpoints[0]).toMatchObject({
      repoRoot,
      paths: ['example.txt'],
      hasPatch: true,
    })
  })

  it.skipIf(process.platform === 'win32')('keeps creating checkpoints when a stale checkpoint cannot be pruned', async () => {
    const repo = await createRepo()
    const legacyId = 'legacy-permission-checkpoint'
    const legacyRoot = join(repo, '.git/cody-web-ui-checkpoints', legacyId)
    const lockedDirectory = join(legacyRoot, 'untracked', '.tmp-go-mod')
    await mkdir(lockedDirectory, { recursive: true })
    await writeFile(join(lockedDirectory, '.travis.yml'), 'legacy\n', 'utf8')
    const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(legacyRoot, oldTimestamp, oldTimestamp)
    await chmod(lockedDirectory, 0o000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')
      const checkpoint = await createToolingCheckpoint({ cwd: repo, label: 'After legacy failure' })
      const nextCheckpoint = await createToolingCheckpoint({ cwd: repo, label: 'During prune backoff' })
      const health = await getToolingCheckpointHealth(repo)

      expect(checkpoint.hasPatch).toBe(true)
      expect(checkpoint.pruneFailedCheckpointIds).toContain(legacyId)
      expect(nextCheckpoint.pruneFailedCheckpointIds).toContain(legacyId)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to prune tooling checkpoint ${legacyId}`))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(health).toMatchObject({
        status: 'degraded',
        rootWritable: true,
        unknownSizeCheckpointIds: [legacyId],
        blockedCheckpointIds: [legacyId],
      })
    } finally {
      await chmod(lockedDirectory, 0o700).catch(() => undefined)
      warn.mockRestore()
    }
  })

  it('rejects unsafe checkpoint patch ids', async () => {
    const repo = await createRepo()

    await expect(readToolingCheckpointPatch({
      cwd: repo,
      checkpointId: '../metadata',
    })).rejects.toThrow('checkpointId is invalid')
  })

  it('summarizes workspace git health, scripts, and policy files', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')
    await writeFile(join(repo, 'new-file.txt'), 'draft\n', 'utf8')
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        build: 'vite build',
        test: 'vitest run',
        start: 'vite',
      },
    }, null, 2), 'utf8')
    await writeFile(join(repo, '.aiignore'), 'secrets/**\n', 'utf8')

    const snapshot = await getWorkspaceSnapshot(repo)
    const repoRoot = await realpath(repo)

    expect(snapshot).toMatchObject({
      cwd: repoRoot,
      repoRoot,
      isGitRepo: true,
      branch: expect.any(String),
      packageManager: '',
      configFiles: {
        aiIgnore: true,
        codyWebUi: false,
      },
    })
    expect(snapshot.gitStatus.dirtyFileCount).toBe(4)
    expect(snapshot.gitStatus.untrackedFileCount).toBe(3)
    expect(snapshot.gitStatus.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'example.txt',
      'new-file.txt',
      'package.json',
    ]))
    expect(snapshot.scripts).toEqual([
      { name: 'build', command: 'vite build' },
      { name: 'start', command: 'vite' },
      { name: 'test', command: 'vitest run' },
    ])
    expect(snapshot.projectContext.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'ai_ignore',
        path: '.aiignore',
        present: true,
        excerpt: expect.stringContaining('secrets/**'),
      }),
      expect.objectContaining({
        kind: 'agents',
        path: 'AGENTS.md',
        present: false,
      }),
    ]))
    expect(snapshot.projectContext.presentCount).toBe(1)
    expect(snapshot.projectContext.warnings).toEqual(expect.arrayContaining([
      'No AGENTS.md project instruction file found.',
      'No workspace-local skills found.',
    ]))
    expect(snapshot.validationPlan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'test',
        source: 'package_script',
        command: 'npm run test',
        status: 'ready',
      }),
      expect.objectContaining({
        kind: 'build',
        source: 'package_script',
        command: 'npm run build',
        status: 'ready',
      }),
      expect.objectContaining({
        kind: 'lint',
        source: 'inferred',
        status: 'blocked',
      }),
    ]))
    expect(snapshot.validationPlan.missingEvidenceCount).toBeGreaterThanOrEqual(2)
    expect(snapshot.warnings).toContain('No .cody-web-ui.yml found for workspace-specific policy and validation defaults.')
  })

  it('loads workspace policy from .cody-web-ui.yml', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'AGENTS.md'), [
      '# Project instructions',
      'Prefer small, verified changes.',
      '',
    ].join('\n'), 'utf8')
    await mkdir(join(repo, '.codex'), { recursive: true })
    await writeFile(join(repo, '.codex/config.toml'), [
      'model = "gpt-5"',
      'api_key = "should-not-leak"',
      '',
    ].join('\n'), 'utf8')
    await mkdir(join(repo, '.codex/skills/reviewer'), { recursive: true })
    await writeFile(join(repo, '.codex/skills/reviewer/SKILL.md'), [
      '# Reviewer',
      'Check risk and validation evidence.',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({
      servers: {
        local: {
          command: 'node',
          token: 'super-secret-token',
        },
      },
    }, null, 2), 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'workspace:',
      '  trust: trusted',
      '  sandboxMode: workspace-write',
      '  approvalPolicy: on-request',
      '  defaultModel: gpt-5',
      '  reasoningEffort: high',
      '  collaborationMode: plan',
      'commands:',
      '  allow:',
      '    - test',
      '    - build:*',
      '  deny:',
      '    - deploy*',
      'validation:',
      '  commands:',
      '    - name: unit',
      '      command: npm test',
      'ports:',
      '  policy:',
      '    allow:',
      '      - 5173',
      '      - 3000-3999',
      '    deny:',
      '      - 0-1023',
      '    allowExternal: false',
      '    allowWildcard: false',
      '  known:',
      '    - name: app',
      '      port: 5173',
      '      url: http://127.0.0.1:5173/',
      '      required: true',
      'security:',
      '  sensitivePaths:',
      '    - .env*',
      '  ignorePatterns:',
      '    - tmp/**',
      '',
    ].join('\n'), 'utf8')

    const snapshot = await getWorkspaceSnapshot(repo)

    expect(snapshot.configFiles.codyWebUi).toBe(true)
    expect(snapshot.workspaceConfig).toMatchObject({
      loaded: true,
      trust: 'trusted',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      defaultModel: 'gpt-5',
      reasoningEffort: 'high',
      collaborationMode: 'plan',
      commandPolicy: {
        allow: ['test', 'build:*'],
        deny: ['deploy*'],
      },
      validationCommands: [
        { name: 'unit', command: 'npm test' },
      ],
      knownPorts: [
        {
          name: 'app',
          port: 5173,
          url: 'http://127.0.0.1:5173/',
          required: true,
        },
      ],
      portPolicy: {
        allow: ['5173', '3000-3999'],
        deny: ['0-1023'],
        allowExternal: false,
        allowWildcard: false,
      },
      sensitivePaths: ['.env*'],
      ignorePatterns: ['tmp/**'],
    })
    expect(snapshot.projectContext.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agents',
        path: 'AGENTS.md',
        present: true,
        excerpt: expect.stringContaining('Prefer small, verified changes.'),
      }),
      expect.objectContaining({
        kind: 'codex_config',
        path: '.codex/config.toml',
        present: true,
        excerpt: expect.stringContaining('api_key = <redacted>'),
      }),
      expect.objectContaining({
        kind: 'local_skill',
        path: '.codex/skills/reviewer/SKILL.md',
        present: true,
        summary: expect.stringContaining('Check risk and validation evidence.'),
      }),
      expect.objectContaining({
        kind: 'mcp_config',
        path: '.mcp.json',
        present: true,
        excerpt: expect.stringContaining('"token": <redacted>'),
      }),
    ]))
    expect(JSON.stringify(snapshot.projectContext.sources)).not.toContain('should-not-leak')
    expect(JSON.stringify(snapshot.projectContext.sources)).not.toContain('super-secret-token')
    expect(snapshot.projectContext.presentCount).toBeGreaterThanOrEqual(5)
    expect(snapshot.validationPlan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'test',
        priority: 'required',
        source: 'workspace_config',
        command: 'npm test',
      }),
      expect.objectContaining({
        kind: 'preview',
        priority: 'required',
        source: 'workspace_port',
        targetUrl: 'http://127.0.0.1:5173/',
        status: 'manual',
      }),
      expect.objectContaining({
        kind: 'browser_smoke',
        source: 'inferred',
        targetUrl: 'http://127.0.0.1:5173/',
        status: 'manual',
      }),
    ]))
    expect(snapshot.validationPlan.requiredCount).toBeGreaterThanOrEqual(2)
    expect(snapshot.warnings).not.toContain('No .cody-web-ui.yml found for workspace-specific policy and validation defaults.')
  })

  it('detects secrets, sensitive paths, and high-risk files in workspace changes', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'security:',
      '  sensitivePaths:',
      '    - .env*',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(repo, 'example.txt'), [
      'one',
      'api_key = "super-secret-token-value"',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(repo, '.env.local'), 'TOKEN=super-secret-token-value\n', 'utf8')
    await mkdir(join(repo, 'src', 'auth'), { recursive: true })
    await writeFile(join(repo, 'src', 'auth', 'permissions.ts'), 'export const roles = []\n', 'utf8')

    const snapshot = await getWorkspaceSecuritySnapshot(repo)

    expect(snapshot.secretFindingCount).toBeGreaterThanOrEqual(2)
    expect(snapshot.sensitivePathFindingCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.highRiskFileCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('possible secret'),
      expect.stringContaining('sensitive path'),
      expect.stringContaining('high-risk file'),
    ]))
    expect(snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'secret',
        severity: 'danger',
        path: 'example.txt',
        evidence: expect.stringContaining('[redacted]'),
      }),
      expect.objectContaining({
        category: 'sensitive_path',
        severity: 'danger',
        path: '.env.local',
      }),
      expect.objectContaining({
        category: 'high_risk_file',
        severity: 'warning',
        path: 'src/auth/permissions.ts',
      }),
    ]))
    expect(JSON.stringify(snapshot.findings)).not.toContain('super-secret-token-value')
  })

  it('creates and persists a supervised workflow run with agent briefings and audit evidence', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'vitest run',
        build: 'vite build',
      },
    }, null, 2), 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'workspace:',
      '  trust: trusted',
      '  sandboxMode: workspace-write',
      '  defaultModel: gpt-5',
      '  reasoningEffort: high',
      'validation:',
      '  commands:',
      '    - name: unit',
      '      command: npm test',
      '',
    ].join('\n'), 'utf8')
    await writeFile(join(repo, 'example.txt'), 'changed\n', 'utf8')

    const emptyDashboard = await listWorkspaceWorkflows({ cwd: repo })
    expect(emptyDashboard.templates.map((template) => template.id)).toEqual(expect.arrayContaining([
      'feature-build',
      'bug-fix',
      'parallel-implementation',
      'review-diff',
      'address-pr-comments',
      'run-tests-and-fix',
      'security-scan',
      'release-notes',
    ]))
    expect(emptyDashboard.runs).toEqual([])

    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'feature-build',
      goal: 'Build a workflow orchestration panel and verify it.',
    })

    expect(run).toMatchObject({
      templateId: 'feature-build',
      templateName: 'Feature Build',
      status: 'ready_for_execution',
      riskLabels: expect.arrayContaining(['dirty-worktree']),
    })
    expect(run.dirtyFileCount).toBeGreaterThan(0)
    expect(run.agents.map((agent) => agent.role)).toEqual([
      'research',
      'implementation',
      'test',
      'review',
      'docs',
    ])
    expect(run.agents[0]).toMatchObject({
      status: 'ready',
      model: 'gpt-5',
      reasoningEffort: 'high',
      permissionProfile: 'workspace-write',
    })
    expect(run.agents[1]?.worktreePolicy).toBe('required')
    expect(run.agents[1]?.branchName).toMatch(/^codex\/feature-build\//u)
    expect(run.validationPlan).toEqual(expect.arrayContaining([
      'unit: npm test',
      'test: vitest run',
      'build: vite build',
    ]))
    expect(run.agents[0]?.briefing).toContain('Workflow: Feature Build')
    expect(run.agents[0]?.briefing).toContain('Build a workflow orchestration panel and verify it.')
    expect(run.implementationOptions).toHaveLength(1)
    expect(run.implementationOptions?.[0]).toMatchObject({
      agentId: 'implementation',
      comparisonStatus: 'pending_worktree',
    })
    expect(run.acceptance).toMatchObject({
      status: 'pending_worktree',
      validationStatus: 'missing',
      completedAgentCount: 0,
      totalAgentCount: 5,
      totalImplementationOptionCount: 1,
    })
    expect(run.acceptance?.risks.join('\n')).toContain('implementation worktree')

    const dashboard = await listWorkspaceWorkflows({ cwd: repo })
    expect(dashboard.runs).toHaveLength(1)
    expect(dashboard.runs[0]?.id).toBe(run.id)

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events[0]).toMatchObject({
      kind: 'workflow.created',
      title: 'Workflow run created',
      metadata: expect.objectContaining({
        workflowRunId: run.id,
        templateId: 'feature-build',
        agentCount: 5,
      }),
    })
  })

  it('creates an address-pr-comments workflow for review feedback follow-up', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'address-pr-comments',
      goal: 'Address unresolved PR feedback from review.',
    })

    expect(run).toMatchObject({
      templateId: 'address-pr-comments',
      templateName: 'Address PR Comments',
      status: 'ready_for_execution',
      riskLabels: expect.arrayContaining(['external-review', 'comment-triage', 'merge-readiness']),
    })
    expect(run.agents.map((agent) => agent.id)).toEqual([
      'triage-comments',
      'fix-comments',
      'verify',
      'review',
      'reply',
    ])
    expect(run.agents.map((agent) => agent.role)).toEqual([
      'research',
      'implementation',
      'test',
      'review',
      'docs',
    ])
    expect(run.agents[1]).toMatchObject({
      worktreePolicy: 'required',
      worktreeStatus: 'pending',
    })
    expect(run.agents[1]?.branchName).toMatch(/^codex\/address-pr-comments\//u)
    expect(run.validationPlan).toEqual(expect.arrayContaining([
      'Collect unresolved PR comments',
      'Run targeted validation',
      'Update PR summary',
    ]))
    expect(run.agents[0]?.briefing).toContain('PR Comment Triage Agent')
    expect(run.agents[1]?.briefing).toContain('Apply the requested changes')
    expect(run.implementationOptions).toEqual([
      expect.objectContaining({
        agentId: 'fix-comments',
        comparisonStatus: 'pending_worktree',
      }),
    ])
  })

  it('summarizes parallel implementation options from isolated worktrees', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'parallel-implementation',
      goal: 'Try two implementation strategies.',
    })

    const implementationBranches = run.agents
      .filter((agent) => agent.role === 'implementation')
      .map((agent) => agent.branchName)
    expect(implementationBranches).toHaveLength(2)
    expect(new Set(implementationBranches).size).toBe(2)
    expect(run.implementationOptions).toEqual([
      expect.objectContaining({
        agentId: 'implementation-a',
        comparisonStatus: 'pending_worktree',
      }),
      expect.objectContaining({
        agentId: 'implementation-b',
        comparisonStatus: 'pending_worktree',
      }),
    ])

    const provisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'implementation-a',
    })
    const optionA = provisioned.implementationOptions?.find((option) => option.agentId === 'implementation-a')
    const optionB = provisioned.implementationOptions?.find((option) => option.agentId === 'implementation-b')
    expect(optionA).toMatchObject({
      worktreeStatus: 'ready',
      comparisonStatus: 'no_changes',
      changedFileCount: 0,
    })
    expect(optionB).toMatchObject({
      worktreeStatus: 'pending',
      comparisonStatus: 'pending_worktree',
    })

    const agentA = provisioned.agents.find((agent) => agent.id === 'implementation-a')
    await writeFile(join(agentA?.worktreePath ?? '', 'example.txt'), 'one\ntwo\n', 'utf8')

    const dashboard = await listWorkspaceWorkflows({ cwd: repo })
    const refreshed = dashboard.runs.find((candidate) => candidate.id === run.id)
    const changedOption = refreshed?.implementationOptions?.find((option) => option.agentId === 'implementation-a')
    expect(changedOption).toMatchObject({
      comparisonStatus: 'validation_missing',
      changedFileCount: 1,
      uncommittedFileCount: 1,
      validationStatus: 'missing',
    })
    expect(changedOption?.insertions).toBeGreaterThanOrEqual(1)
    expect(changedOption?.risks.join('\n')).toContain('No workflow validation evidence')
  })

  it('updates workflow agent status, unlocks dependencies, and records audit events', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'bug-fix',
      goal: 'Reproduce and fix a startup crash.',
    })

    expect(run.status).toBe('ready_for_execution')
    expect(run.agents.find((agent) => agent.id === 'repro')?.status).toBe('ready')
    expect(run.agents.find((agent) => agent.id === 'fix')?.status).toBe('queued')

    const running = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'repro',
      status: 'running',
    })
    expect(running.status).toBe('running')
    expect(running.agents.find((agent) => agent.id === 'repro')?.status).toBe('running')

    const afterRepro = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'repro',
      status: 'completed',
    })
    expect(afterRepro.status).toBe('ready_for_execution')
    expect(afterRepro.agents.find((agent) => agent.id === 'fix')?.status).toBe('ready')

    const blocked = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
      status: 'blocked',
      note: 'Need clarification on expected startup behavior.',
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.summary).toContain('blocked')

    const afterFix = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
      status: 'completed',
    })
    expect(afterFix.status).toBe('ready_for_execution')
    expect(afterFix.agents.find((agent) => agent.id === 'verify')?.status).toBe('ready')

    const afterVerify = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'verify',
      status: 'completed',
    })
    expect(afterVerify.status).toBe('ready_for_review')
    expect(afterVerify.agents.find((agent) => agent.id === 'review')?.status).toBe('ready')

    const completed = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'review',
      status: 'completed',
    })
    expect(completed.status).toBe('completed')
    expect(completed.summary).toContain('completed 4 agent steps')

    const dashboard = await listWorkspaceWorkflows({ cwd: repo })
    expect(dashboard.runs[0]).toMatchObject({
      id: run.id,
      status: 'completed',
    })

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events.map((event) => event.kind)).toContain('workflow.agent_status_changed')
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.agent_status_changed',
        severity: 'warning',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          agentId: 'fix',
          nextStatus: 'blocked',
          note: 'Need clarification on expected startup behavior.',
        }),
      }),
    ]))
  })

  it('provisions a managed worktree for workflow implementation agents', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'bug-fix',
      goal: 'Fix a worktree isolated bug.',
    })

    const fixAgent = run.agents.find((agent) => agent.id === 'fix')
    expect(fixAgent).toMatchObject({
      worktreePolicy: 'required',
      worktreeStatus: 'pending',
      worktreePath: null,
    })

    const provisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
    })
    const provisionedAgent = provisioned.agents.find((agent) => agent.id === 'fix')

    expect(provisionedAgent).toMatchObject({
      worktreeStatus: 'ready',
      worktreePolicy: 'required',
    })
    expect(provisionedAgent?.worktreePath).toContain('.worktrees')
    expect(provisionedAgent?.worktreeReadyAtIso).toBeTruthy()

    const worktrees = await listWorkspaceWorktrees(repo)
    expect(worktrees.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: provisionedAgent?.worktreePath,
        branch: provisionedAgent?.branchName,
        isManaged: true,
      }),
    ]))

    const reprovisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
    })
    expect(reprovisioned.agents.find((agent) => agent.id === 'fix')?.worktreePath).toBe(provisionedAgent?.worktreePath)

    const dashboard = await listWorkspaceWorkflows({ cwd: repo })
    expect(dashboard.runs[0]?.agents.find((agent) => agent.id === 'fix')).toMatchObject({
      worktreeStatus: 'ready',
      worktreePath: provisionedAgent?.worktreePath,
    })

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.agent_worktree_provisioned',
        severity: 'success',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          agentId: 'fix',
          worktreePath: provisionedAgent?.worktreePath,
        }),
      }),
      expect.objectContaining({
        kind: 'worktree.created',
        severity: 'success',
      }),
    ]))
  })

  it('builds an auditable replay for a workflow run', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'bug-fix',
      goal: 'Replay a supervised workflow.',
    })

    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'repro',
      status: 'completed',
    })
    const provisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
    })
    const fixAgent = provisioned.agents.find((agent) => agent.id === 'fix')

    const replay = await getWorkspaceWorkflowReplay({ cwd: repo, runId: run.id })
    expect(replay.run.id).toBe(run.id)
    expect(replay.events.map((event) => event.kind)).toEqual([
      'workflow.created',
      'workflow.agent_status_changed',
      'workflow.agent_worktree_provisioned',
    ])
    expect(replay.events.map((event) => event.createdAtIso)).toEqual(
      [...replay.events.map((event) => event.createdAtIso)].sort(),
    )
    expect(replay.agentSnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'fix',
        status: 'ready',
        worktreeStatus: 'ready',
        worktreePath: fixAgent?.worktreePath,
      }),
    ]))
    expect(replay.evidenceSummary).toEqual(expect.arrayContaining([
      expect.stringContaining('audited workflow event'),
      expect.stringContaining('isolated worktree'),
    ]))
    expect(replay.validationEvidence).toMatchObject({
      totalRuns: 0,
      matchedRuns: 0,
      latestStatus: null,
    })

    await removeWorkspaceWorktree({
      cwd: repo,
      path: fixAgent?.worktreePath ?? '',
    })
  })

  it('runs workflow validation scripts and links the evidence to replay', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "console.log(\'workflow validation ok\')"',
      },
    }, null, 2), 'utf8')
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'bug-fix',
      goal: 'Validate workflow evidence.',
    })

    expect(run.validationPlan).toEqual(expect.arrayContaining(['test: node -e "console.log(\'workflow validation ok\')"']))

    const result = await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })

    expect(result.validationRun).toMatchObject({
      scriptName: 'test',
      command: 'npm run test',
      status: 'passed',
      exitCode: 0,
    })
    expect(result.validationRun.output).toContain('workflow validation ok')
    expect(result.run.summary).toBe('Bug Fix validation test passed.')
    expect(result.run.acceptance).toMatchObject({
      status: 'pending_worktree',
      validationStatus: 'passed',
      validationCommand: 'npm run test',
    })
    expect(result.replay.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'workflow.created',
      'workflow.validation_ran',
    ]))
    expect(result.replay.validationEvidence).toMatchObject({
      matchedRuns: 1,
      latestStatus: 'passed',
      latestCommand: 'npm run test',
    })

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.validation_ran',
        severity: 'success',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          scriptName: 'test',
          status: 'passed',
        }),
      }),
    ]))

    await expect(runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'dev',
    })).rejects.toThrow('scriptName is not part of this workflow validation plan')
  })

  it('keeps completed workflows behind the acceptance gate until automated validation passes', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "console.log(\'acceptance ok\')"',
      },
    }, null, 2), 'utf8')
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'review-diff',
      goal: 'Review the diff and require validation evidence.',
    })

    const afterReview = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'diff-review',
      status: 'completed',
    })
    expect(afterReview.acceptance).toMatchObject({
      status: 'waiting_for_agents',
      completedAgentCount: 1,
      totalAgentCount: 2,
    })

    const completed = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'validation-review',
      status: 'completed',
    })
    expect(completed.status).toBe('completed')
    expect(completed.acceptance).toMatchObject({
      status: 'waiting_for_validation',
      validationStatus: 'missing',
      completedAgentCount: 2,
      totalAgentCount: 2,
    })
    expect(completed.acceptance?.summary).toContain('automated validation evidence')

    const result = await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })
    expect(result.run.acceptance).toMatchObject({
      status: 'accepted',
      validationStatus: 'passed',
      validationCommand: 'npm run test',
      completedAgentCount: 2,
      totalAgentCount: 2,
    })
  })

  it('marks the acceptance gate failed when linked workflow validation fails', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "process.exit(1)"',
      },
    }, null, 2), 'utf8')
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'review-diff',
      goal: 'Review the diff and surface failed validation.',
    })
    const afterReview = await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'diff-review',
      status: 'completed',
    })
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: afterReview.id,
      agentId: 'validation-review',
      status: 'completed',
    })

    const result = await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })

    expect(result.validationRun.status).toBe('failed')
    expect(result.run.status).toBe('failed')
    expect(result.run.acceptance).toMatchObject({
      status: 'validation_failed',
      validationStatus: 'failed',
      validationCommand: 'npm run test',
    })
    expect(result.run.acceptance?.risks.join('\n')).toContain('Latest linked workflow validation failed')
  })

  it('applies a validated implementation option back to a clean workspace with a checkpoint', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -p 1',
      },
    }, null, 2), 'utf8')
    await git(repo, ['add', 'package.json'])
    await git(repo, ['commit', '-m', 'add validation script'])
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'bug-fix',
      goal: 'Apply a validated fix option.',
    })
    const provisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
    })
    const fixAgent = provisioned.agents.find((agent) => agent.id === 'fix')
    expect(fixAgent?.worktreePath).toBeTruthy()

    await writeFile(join(fixAgent?.worktreePath ?? '', 'example.txt'), 'fixed\n', 'utf8')
    await git(fixAgent?.worktreePath ?? '', ['add', 'example.txt'])
    await git(fixAgent?.worktreePath ?? '', ['commit', '-m', 'fix example'])
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'repro',
      status: 'completed',
    })
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
      status: 'completed',
    })
    const validated = await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })
    expect(validated.run.implementationOptions?.find((option) => option.agentId === 'fix')).toMatchObject({
      comparisonStatus: 'ready_to_merge',
      validationStatus: 'passed',
    })

    const result = await applyWorkspaceWorkflowImplementation({
      cwd: repo,
      runId: run.id,
      agentId: 'fix',
    })

    await expect(readFile(join(repo, 'example.txt'), 'utf8')).resolves.toBe('fixed\n')
    expect(result.appliedImplementation).toMatchObject({
      agentId: 'fix',
      agentName: 'Fix Agent',
      changedFileCount: 1,
      checkpointId: result.checkpoint.id,
    })
    expect(result.run).toMatchObject({
      status: 'ready_for_review',
      appliedImplementation: expect.objectContaining({
        agentId: 'fix',
        checkpointId: result.checkpoint.id,
      }),
    })
    expect(result.targetStatus.files.map((file) => file.path)).toContain('example.txt')

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.implementation_applied',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          agentId: 'fix',
          checkpointId: result.checkpoint.id,
        }),
      }),
    ]))
  })

  it('discards a workflow implementation option and removes its managed worktree', async () => {
    const repo = await createRepo()
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'parallel-implementation',
      goal: 'Discard one implementation branch.',
    })
    const provisioned = await provisionWorkspaceWorkflowAgentWorktree({
      cwd: repo,
      runId: run.id,
      agentId: 'implementation-a',
    })
    const agentA = provisioned.agents.find((agent) => agent.id === 'implementation-a')
    const worktreePath = agentA?.worktreePath ?? ''
    expect(worktreePath).toBeTruthy()
    await writeFile(join(worktreePath, 'example.txt'), 'discard me\n', 'utf8')

    const result = await discardWorkspaceWorkflowImplementation({
      cwd: repo,
      runId: run.id,
      agentId: 'implementation-a',
      reason: 'Prefer implementation B.',
    })

    expect(result.removedWorktreePath).toBe(worktreePath)
    expect(result.discardedImplementation).toMatchObject({
      agentId: 'implementation-a',
      agentName: 'Implementation Agent A',
      worktreePath,
      reason: 'Prefer implementation B.',
    })
    expect(result.run.discardedImplementations).toEqual([
      expect.objectContaining({
        agentId: 'implementation-a',
        reason: 'Prefer implementation B.',
      }),
    ])
    expect(result.run.agents.find((agent) => agent.id === 'implementation-a')).toMatchObject({
      status: 'skipped',
      worktreeStatus: 'discarded',
      worktreePath: null,
    })
    expect(result.run.implementationOptions?.find((option) => option.agentId === 'implementation-a')).toMatchObject({
      comparisonStatus: 'discarded',
      worktreeStatus: 'discarded',
    })
    const worktrees = await listWorkspaceWorktrees(repo)
    expect(worktrees.worktrees.some((worktree) => worktree.path === worktreePath)).toBe(false)

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.implementation_discarded',
        severity: 'warning',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          agentId: 'implementation-a',
          removedWorktreePath: worktreePath,
          reason: 'Prefer implementation B.',
        }),
      }),
    ]))
  })

  it('builds a workflow delivery draft with acceptance, validation, and workspace diff evidence', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -p 1',
      },
    }, null, 2), 'utf8')
    await git(repo, ['add', 'package.json'])
    await git(repo, ['commit', '-m', 'add validation script'])
    await writeFile(join(repo, 'example.txt'), 'delivery draft\n', 'utf8')
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'review-diff',
      goal: 'Prepare a workflow PR draft.',
    })
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'diff-review',
      status: 'completed',
    })
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'validation-review',
      status: 'completed',
    })
    await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })

    const draft = await getWorkspaceWorkflowDeliveryDraft({
      cwd: repo,
      runId: run.id,
    })

    expect(draft).toMatchObject({
      runId: run.id,
      templateName: 'Review Diff',
      status: 'completed',
      acceptance: expect.objectContaining({
        status: 'accepted',
        validationStatus: 'passed',
      }),
      validationEvidence: expect.objectContaining({
        matchedRuns: 1,
        latestStatus: 'passed',
      }),
    })
    expect(draft.title).toContain('Review Diff')
    expect(draft.reviewDraft.files.map((file) => file.path)).toContain('example.txt')
    expect(draft.body).toContain('## Acceptance')
    expect(draft.body).toContain('## Workspace Diff')
    expect(draft.body).toContain('npm run test -> passed')
    expect(draft.body).toContain('example.txt')
    expect(draft.commitMessage).toContain(`Workflow: ${run.id}`)
  })

  it('marks accepted workflows ready to merge and merged with delivery audit state', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -p 1',
      },
    }, null, 2), 'utf8')
    await git(repo, ['add', 'package.json'])
    await git(repo, ['commit', '-m', 'add validation script'])
    const run = await createWorkspaceWorkflowRun({
      cwd: repo,
      templateId: 'review-diff',
      goal: 'Close out a workflow delivery.',
    })

    await expect(markWorkspaceWorkflowReadyToMerge({
      cwd: repo,
      runId: run.id,
    })).rejects.toThrow('Workflow acceptance must be green before marking ready to merge')

    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'diff-review',
      status: 'completed',
    })
    await updateWorkspaceWorkflowAgentStatus({
      cwd: repo,
      runId: run.id,
      agentId: 'validation-review',
      status: 'completed',
    })
    await runWorkspaceWorkflowValidation({
      cwd: repo,
      runId: run.id,
      scriptName: 'test',
    })

    const ready = await markWorkspaceWorkflowReadyToMerge({
      cwd: repo,
      runId: run.id,
      note: 'Human reviewed the delivery draft.',
    })

    expect(ready.run).toMatchObject({
      id: run.id,
      status: 'ready_to_merge',
      deliveryState: expect.objectContaining({
        mergedAtIso: null,
        commitHash: null,
        note: 'Human reviewed the delivery draft.',
      }),
    })
    expect(ready.deliveryState.readyToMergeAtIso).toBeTruthy()

    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    const merged = await markWorkspaceWorkflowMerged({
      cwd: repo,
      runId: run.id,
      pullRequestUrl: 'https://github.com/example/repo/pull/42',
      note: 'Merged after PR review.',
    })

    expect(merged.run).toMatchObject({
      id: run.id,
      status: 'merged',
      deliveryState: expect.objectContaining({
        commitHash: head,
        pullRequestUrl: 'https://github.com/example/repo/pull/42',
        note: 'Merged after PR review.',
      }),
    })
    expect(merged.deliveryState.readyToMergeAtIso).toBe(ready.deliveryState.readyToMergeAtIso)
    expect(merged.deliveryState.mergedAtIso).toBeTruthy()

    const dashboard = await listWorkspaceWorkflows({ cwd: repo })
    expect(dashboard.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: 'merged',
      deliveryState: expect.objectContaining({
        commitHash: head,
      }),
    })

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 20 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'workflow.ready_to_merge',
        severity: 'success',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          note: 'Human reviewed the delivery draft.',
        }),
      }),
      expect.objectContaining({
        kind: 'workflow.merged',
        severity: 'success',
        metadata: expect.objectContaining({
          workflowRunId: run.id,
          commitHash: head,
          pullRequestUrl: 'https://github.com/example/repo/pull/42',
        }),
      }),
    ]))
  })

  it('enforces workspace command deny policy for validation scripts', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "console.log(\'ok\')"',
      },
    }, null, 2), 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'commands:',
      '  deny:',
      '    - test',
      '',
    ].join('\n'), 'utf8')

    await expect(runWorkspaceScript({
      cwd: repo,
      scriptName: 'test',
    })).rejects.toThrow('Command is denied by .cody-web-ui.yml policy: test')
  })

  it('enforces workspace command allow policy for terminal sessions', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "console.log(\'ok\')"',
        dev: 'node -e "setTimeout(() => {}, 1000)"',
      },
    }, null, 2), 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'commands:',
      '  allow:',
      '    - test',
      '',
    ].join('\n'), 'utf8')

    await expect(startWorkspaceTerminalSession({
      cwd: repo,
      scriptName: 'dev',
    })).rejects.toThrow('Command is not allowed by .cody-web-ui.yml policy')
  })

  it('evaluates workspace command policy for app-server approval commands', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'commands:',
      '  allow:',
      '    - test',
      '    - build:*',
      '  deny:',
      '    - publish*',
      '',
    ].join('\n'), 'utf8')

    await expect(evaluateWorkspaceCommandPolicy({
      cwd: repo,
      command: 'npm test -- --runInBand',
    })).resolves.toMatchObject({
      status: 'allowed',
      matchedPattern: 'test',
    })
    await expect(evaluateWorkspaceCommandPolicy({
      cwd: repo,
      command: 'npm run build:cli',
    })).resolves.toMatchObject({
      status: 'allowed',
      matchedPattern: 'build:*',
    })
    await expect(evaluateWorkspaceCommandPolicy({
      cwd: repo,
      command: 'npm publish --dry-run',
    })).resolves.toMatchObject({
      status: 'denied',
      matchedPattern: 'publish*',
      reason: 'Command is denied by .cody-web-ui.yml policy: publish*',
    })
    await expect(evaluateWorkspaceCommandPolicy({
      cwd: repo,
      command: 'git status',
    })).resolves.toMatchObject({
      status: 'denied',
      reason: 'Command is not allowed by .cody-web-ui.yml policy',
    })
  })

  it('evaluates workspace file change policy for app-server approvals', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, '.gitignore'), 'ignored/**\n', 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'workspace:',
      '  sandboxMode: workspace-write',
      'security:',
      '  sensitivePaths:',
      '    - .env*',
      '',
    ].join('\n'), 'utf8')

    await expect(evaluateWorkspaceFileChangePolicy({
      cwd: repo,
      grantRoot: join(repo, 'src'),
    })).resolves.toMatchObject({
      status: 'allowed',
      category: 'workspace',
      relativePath: 'src',
    })
    await expect(evaluateWorkspaceFileChangePolicy({
      cwd: repo,
      grantRoot: join(repo, '.env.local'),
    })).resolves.toMatchObject({
      status: 'denied',
      category: 'sensitive',
      matchedPattern: '.env.*',
    })
    await expect(evaluateWorkspaceFileChangePolicy({
      cwd: repo,
      grantRoot: join(repo, 'ignored/generated.txt'),
    })).resolves.toMatchObject({
      status: 'denied',
      category: 'ignored',
      matchedPattern: 'ignored/**',
    })
    await expect(evaluateWorkspaceFileChangePolicy({
      cwd: repo,
      grantRoot: '/tmp/outside-file.txt',
    })).resolves.toMatchObject({
      status: 'denied',
      category: 'outside_workspace',
    })

    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'workspace:',
      '  sandboxMode: read-only',
      '',
    ].join('\n'), 'utf8')
    await expect(evaluateWorkspaceFileChangePolicy({
      cwd: repo,
      grantRoot: join(repo, 'src'),
    })).resolves.toMatchObject({
      status: 'denied',
      category: 'read_only',
      matchedPattern: 'workspace.sandboxMode=read-only',
    })
  })

  it('returns configured known ports and required-port warnings', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'ports:',
      '  known:',
      '    - name: local-app',
      '      port: 61234',
      '      required: true',
      '',
    ].join('\n'), 'utf8')

    const snapshot = await getWorkspacePorts(repo)

    expect(snapshot.knownPorts).toEqual([
      {
        name: 'local-app',
        port: 61234,
        url: null,
        required: true,
      },
    ])
    expect(snapshot.warnings).toContain('Required configured port local-app (:61234) is not listening.')
  })

  it('lists and reads files inside the workspace root', async () => {
    const repo = await createRepo()
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src', 'app.ts'), 'export const answer = 42\n', 'utf8')

    const rootList = await listWorkspaceFiles({ cwd: repo })
    expect(rootList.path).toBe('')
    expect(rootList.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'src', path: 'src', kind: 'directory' }),
      expect.objectContaining({ name: 'example.txt', path: 'example.txt', kind: 'file' }),
    ]))
    expect(rootList.entries.some((entry) => entry.name === '.git')).toBe(false)

    const srcList = await listWorkspaceFiles({ cwd: repo, path: 'src' })
    expect(srcList.parentPath).toBe('')
    expect(srcList.entries).toEqual([
      expect.objectContaining({ name: 'app.ts', path: 'src/app.ts', kind: 'file' }),
    ])

    const file = await readWorkspaceFile({ cwd: repo, path: 'src/app.ts' })
    expect(file).toMatchObject({
      path: 'src/app.ts',
      name: 'app.ts',
      content: 'export const answer = 42\n',
      truncated: false,
      isBinary: false,
    })
  })

  it('keeps directories visible when a workspace folder exceeds the entry limit', async () => {
    const repo = await createRepo()
    await Promise.all(Array.from({ length: 205 }, (_, index) => (
      writeFile(join(repo, `generated-${String(index).padStart(3, '0')}.txt`), 'generated\n', 'utf8')
    )))
    await mkdir(join(repo, 'worktrees'))

    const rootList = await listWorkspaceFiles({ cwd: repo })

    expect(rootList.truncated).toBe(true)
    expect(rootList.entries).toHaveLength(200)
    expect(rootList.entries[0]).toEqual(expect.objectContaining({
      name: 'worktrees',
      path: 'worktrees',
      kind: 'directory',
    }))
  })

  it('rejects workspace file paths outside the workspace root', async () => {
    const repo = await createRepo()

    await expect(readWorkspaceFile({
      cwd: repo,
      path: '../outside.txt',
    })).rejects.toThrow('path must stay inside the workspace root')
  })

  it('searches workspace file names and contents without exposing protected paths', async () => {
    const repo = await createRepo()
    await mkdir(join(repo, 'src'))
    await mkdir(join(repo, 'private'))
    await writeFile(join(repo, 'src', 'workspaceSearch.ts'), 'export const workspaceNeedle = 42\n', 'utf8')
    await writeFile(join(repo, 'private', 'hidden.ts'), 'workspaceNeedle\n', 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'security:',
      '  ignorePatterns:',
      '    - private/**',
      '',
    ].join('\n'), 'utf8')

    const fileResult = await searchWorkspace({ cwd: repo, query: 'workspaceSearch', scope: 'files' })
    expect(fileResult.items).toEqual([
      expect.objectContaining({ path: 'src/workspaceSearch.ts', line: null }),
    ])

    const contentResult = await searchWorkspace({ cwd: repo, query: 'workspaceNeedle', scope: 'content' })
    expect(contentResult.items).toEqual([
      expect.objectContaining({ path: 'src/workspaceSearch.ts', line: 1, column: 14 }),
    ])
    expect(contentResult.items.some((item) => item.path.startsWith('private/'))).toBe(false)
    await expect(searchWorkspace({ cwd: repo, query: 'needle', path: '../outside' })).rejects.toThrow('workspace root')
  })

  it('serves supported workspace images from relative or absolute paths', async () => {
    const repo = await createRepo()
    const resolvedRepo = await realpath(repo)
    await mkdir(join(repo, 'docs'))
    const svgPath = join(resolvedRepo, 'docs', 'architecture.svg')
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><text>Architecture</text></svg>', 'utf8')

    const relativeAsset = await readWorkspaceAsset({ cwd: repo, path: 'docs/architecture.svg' })
    const absoluteAsset = await readWorkspaceAsset({ cwd: repo, path: svgPath })
    expect(relativeAsset.contentType).toBe('image/svg+xml; charset=utf-8')
    expect(relativeAsset.content.toString('utf8')).toContain('Architecture')
    expect(absoluteAsset.path).toBe('docs/architecture.svg')
    await expect(readWorkspaceAsset({ cwd: repo, path: 'example.txt' })).rejects.toThrow('unsupported')
    await expect(readWorkspaceAsset({ cwd: repo, path: '../outside.svg' })).rejects.toThrow('workspace root')
  })

  it('hides and blocks sensitive or ignored workspace file paths', async () => {
    const repo = await createRepo()
    await mkdir(join(repo, 'tmp'), { recursive: true })
    await writeFile(join(repo, '.env'), 'TOKEN=secret\n', 'utf8')
    await writeFile(join(repo, 'tmp/cache.txt'), 'cached\n', 'utf8')
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'security:',
      '  sensitivePaths:',
      '    - .env*',
      '  ignorePatterns:',
      '    - tmp/**',
      '',
    ].join('\n'), 'utf8')

    const rootList = await listWorkspaceFiles({ cwd: repo })
    expect(rootList.entries.map((entry) => entry.path)).not.toContain('.env')
    expect(rootList.entries.map((entry) => entry.path)).not.toContain('tmp')

    await expect(readWorkspaceFile({
      cwd: repo,
      path: '.env',
    })).rejects.toThrow('sensitive path policy')
    await expect(readWorkspaceFile({
      cwd: repo,
      path: 'tmp/cache.txt',
    })).rejects.toThrow('workspace ignore policy')
    await expect(writeWorkspaceFile({
      cwd: repo,
      path: '.env',
      content: 'TOKEN=changed\n',
    })).rejects.toThrow('sensitive path policy')
  })

  it('writes an existing workspace file after creating a checkpoint', async () => {
    const repo = await createRepo()

    const result = await writeWorkspaceFile({
      cwd: repo,
      path: 'example.txt',
      content: 'edited\n',
    })

    expect(result.file).toMatchObject({
      path: 'example.txt',
      content: 'edited\n',
      isBinary: false,
    })
    expect(result.checkpoint).toMatchObject({
      paths: ['example.txt'],
      hasPatch: false,
    })
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('edited\n')
    const checkpoints = await listToolingCheckpoints({ cwd: repo, limit: 1 })
    expect(checkpoints[0]?.id).toBe(result.checkpoint.id)
  })

  it('rejects workspace file writes outside the workspace root', async () => {
    const repo = await createRepo()

    await expect(writeWorkspaceFile({
      cwd: repo,
      path: '../outside.txt',
      content: 'nope\n',
    })).rejects.toThrow('filePath must stay inside the git workspace root')
  })

  it('runs a one-shot workspace validation script and captures output', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: [
          'node',
          '-e',
          [
            'console.log("ok from test")',
            'console.log("Tests  3 passed (3)")',
            'console.log("All files | 87.5 | 80 | 90 | 88.2 |")',
          ].join('; '),
        ].map((part) => JSON.stringify(part)).join(' '),
      },
    }, null, 2), 'utf8')

    const result = await runWorkspaceScript({
      cwd: repo,
      scriptName: 'test',
    })

    expect(result).toMatchObject({
      scriptName: 'test',
      command: 'npm run test',
      status: 'passed',
      exitCode: 0,
      truncated: false,
    })
    expect(result.output).toContain('ok from test')
    expect(result.testSummary).toMatchObject({
      total: 3,
      passed: 3,
      failed: null,
    })
    expect(result.coverageSummary).toMatchObject({
      statements: 87.5,
      branches: 80,
      functions: 90,
      lines: 88.2,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    const canonicalRepo = await realpath(repo)
    const history = await listWorkspaceValidationRuns({ cwd: repo, limit: 5 })
    expect(history).toMatchObject({
      cwd: canonicalRepo,
      repoRoot: canonicalRepo,
      runs: [
        expect.objectContaining({
          scriptName: 'test',
          command: 'npm run test',
          status: 'passed',
          output: expect.stringContaining('ok from test'),
          testSummary: expect.objectContaining({
            total: 3,
            passed: 3,
          }),
          coverageSummary: expect.objectContaining({
            lines: 88.2,
          }),
        }),
      ],
    })

    const snapshot = await getWorkspaceSnapshot(repo)
    expect(snapshot.validationPlan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'test',
        command: 'npm run test',
        status: 'covered',
        evidence: expect.objectContaining({
          status: 'passed',
          exitCode: 0,
          testSummary: expect.objectContaining({ total: 3, passed: 3 }),
          coverageSummary: expect.objectContaining({ lines: 88.2 }),
        }),
      }),
    ]))
    expect(snapshot.validationPlan.coveredCount).toBeGreaterThanOrEqual(1)
  })

  it('returns failed status and stderr for a failing workspace validation script', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        build: 'node -e "console.error(\'src/build.ts(7,3): error TS2304: Cannot find name nope.\'); process.exit(2)"',
      },
    }, null, 2), 'utf8')

    const result = await runWorkspaceScript({
      cwd: repo,
      scriptName: 'build',
    })

    expect(result).toMatchObject({
      scriptName: 'build',
      status: 'failed',
      exitCode: 2,
      problems: [
        expect.objectContaining({
          filePath: 'src/build.ts',
          line: 7,
          column: 3,
          source: 'TS2304',
          severity: 'error',
        }),
      ],
    })
    expect(result.stderr).toContain('Cannot find name nope')
    expect(result.output).toContain('Cannot find name nope')
  })

  it('rejects long-running workspace scripts from dashboard execution', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        dev: 'vite',
      },
    }, null, 2), 'utf8')

    await expect(runWorkspaceScript({
      cwd: repo,
      scriptName: 'dev',
    })).rejects.toThrow('Only one-shot validation scripts can be run from the dashboard')
  })

  it('starts a workspace terminal session and captures package script output', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        hello: 'node -e "console.log(\'hello terminal\')"',
      },
    }, null, 2), 'utf8')

    const started = await startWorkspaceTerminalSession({
      cwd: repo,
      scriptName: 'hello',
    })

    expect(started).toMatchObject({
      scriptName: 'hello',
      command: 'npm run hello',
      status: 'running',
    })

    let sessions = await listWorkspaceTerminalSessions(repo)
    for (let attempt = 0; attempt < 20 && sessions.sessions[0]?.status === 'running'; attempt += 1) {
      await wait(100)
      sessions = await listWorkspaceTerminalSessions(repo)
    }

    expect(sessions.sessions[0]).toMatchObject({
      id: started.id,
      scriptName: 'hello',
      status: 'exited',
      exitCode: 0,
    })
    expect(sessions.sessions[0]?.output).toContain('hello terminal')
  })

  it('rejects terminal sessions for scripts missing from package.json', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "console.log(1)"',
      },
    }, null, 2), 'utf8')

    await expect(startWorkspaceTerminalSession({
      cwd: repo,
      scriptName: 'dev',
    })).rejects.toThrow('scriptName was not found in package.json')
  })

  it('reads git status and stages then unstages workspace paths', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\n', 'utf8')
    await writeFile(join(repo, 'new-file.txt'), 'draft\n', 'utf8')

    const before = await getWorkspaceGitStatus(repo)
    expect(before).toMatchObject({
      stagedFileCount: 0,
      unstagedFileCount: 1,
      untrackedFileCount: 1,
    })
    expect(before.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'example.txt', status: ' M' }),
      expect.objectContaining({ path: 'new-file.txt', status: '??' }),
    ]))

    const staged = await runWorkspaceGitPathAction({
      cwd: repo,
      action: 'stage',
      paths: ['example.txt', 'new-file.txt'],
    })
    expect(staged.paths).toEqual(['example.txt', 'new-file.txt'])
    expect(staged.status.stagedFileCount).toBe(2)
    expect(staged.status.unstagedFileCount).toBe(0)
    expect(staged.status.untrackedFileCount).toBe(0)

    const unstaged = await runWorkspaceGitPathAction({
      cwd: repo,
      action: 'unstage',
      paths: ['example.txt', 'new-file.txt'],
    })
    expect(unstaged.status.stagedFileCount).toBe(0)
    expect(unstaged.status.unstagedFileCount).toBe(1)
    expect(unstaged.status.untrackedFileCount).toBe(1)
  })

  it('builds commit and PR drafts from staged changes', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'two\nthree\n', 'utf8')
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src', 'Widget.vue'), '<template><main>ok</main></template>\n', 'utf8')
    await runWorkspaceGitPathAction({
      cwd: repo,
      action: 'stage',
      paths: ['example.txt', 'src/Widget.vue'],
    })

    const draft = await getWorkspaceGitDeliveryDraft(repo)

    expect(draft).toMatchObject({
      hasStagedChanges: true,
      fileCount: 2,
      insertions: expect.any(Number),
      deletions: expect.any(Number),
    })
    expect(draft.files.map((file) => file.path)).toEqual(['example.txt', 'src/Widget.vue'])
    expect(draft.commitMessage).toContain('Update')
    expect(draft.commitMessage).toContain('example.txt')
    expect(draft.prBody).toContain('## Summary')
    expect(draft.prBody).toContain('## Validation')
    expect(draft.riskSummary).toEqual(expect.arrayContaining([
      'UI changes should be browser-smoke-tested across the affected workflow.',
    ]))
    expect(draft.validationPlan).toEqual(expect.arrayContaining([
      'npm test',
      'npm run build',
      'Browser smoke test affected UI flow',
    ]))
  })

  it('builds review drafts from current workspace diff before staging', async () => {
    const repo = await createRepo()
    await mkdir(join(repo, 'src'))
    await mkdir(join(repo, 'src', 'server'))
    await writeFile(join(repo, 'src', 'server', 'tool.ts'), 'export const value = 1\n', 'utf8')
    await git(repo, ['add', 'src/server/tool.ts'])
    await git(repo, ['commit', '-m', 'add server file'])
    await writeFile(join(repo, 'example.txt'), 'two\nthree\n', 'utf8')
    await writeFile(join(repo, 'src', 'server', 'tool.ts'), 'export const value = 2\n', 'utf8')
    await writeFile(join(repo, 'notes.md'), '# local note\n', 'utf8')

    const draft = await getWorkspaceReviewDraft(repo)

    expect(draft).toMatchObject({
      source: 'workspace_diff',
      hasReviewChanges: true,
      hasStagedChanges: false,
      fileCount: 2,
      insertions: expect.any(Number),
      deletions: expect.any(Number),
    })
    expect(draft.files.map((file) => file.path)).toEqual(['example.txt', 'src/server/tool.ts'])
    expect(draft.untrackedFiles).toEqual(['notes.md'])
    expect(draft.warnings).toEqual(expect.arrayContaining([
      '1 untracked file(s) are not included in the generated patch until staged.',
    ]))
    expect(draft.commitMessage).toContain('example.txt')
    expect(draft.prBody).toContain('reviewed file(s)')
    expect(draft.riskSummary).toEqual(expect.arrayContaining([
      'Server tooling changes can affect local command and git operations.',
    ]))
    expect(draft.validationPlan).toEqual(expect.arrayContaining([
      'npm test',
      'npm run build',
      'Exercise affected tooling API endpoint',
    ]))
  })

  it('commits staged changes with delivery draft evidence and audit trail', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, 'example.txt'), 'committed from browser\n', 'utf8')
    await runWorkspaceGitPathAction({
      cwd: repo,
      action: 'stage',
      paths: ['example.txt'],
    })

    const result = await commitStagedWorkspaceChanges({
      cwd: repo,
      commitMessage: 'Update example from control tower\n\n- M example.txt',
    })

    expect(result.commitHash).toHaveLength(40)
    expect(result.commitMessage).toBe('Update example from control tower\n\n- M example.txt')
    expect(result.draft.files.map((file) => file.path)).toEqual(['example.txt'])
    expect(result.status.stagedFileCount).toBe(0)
    expect(result.status.unstagedFileCount).toBe(0)
    expect((await git(repo, ['log', '-1', '--pretty=%B'])).trim()).toBe('Update example from control tower\n\n- M example.txt')

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'git.commit_created',
        severity: 'success',
        metadata: expect.objectContaining({
          commitHash: result.commitHash,
          fileCount: 1,
          files: ['example.txt'],
        }),
      }),
    ]))
  }, 10_000)

  it('builds pull request drafts from commits ahead of a base branch', async () => {
    const repo = await createRepo()
    const baseBranch = (await git(repo, ['branch', '--show-current'])).trim()
    await git(repo, ['checkout', '-b', 'codex/pr-draft'])
    await writeFile(join(repo, 'example.txt'), 'feature change\n', 'utf8')
    await git(repo, ['add', 'example.txt'])
    await git(repo, ['commit', '-m', 'Add PR draft feature'])

    const draft = await getWorkspacePullRequestDraft({
      cwd: repo,
      baseBranch,
    })

    expect(draft).toMatchObject({
      branch: 'codex/pr-draft',
      baseBranch,
      commitCount: 1,
      fileCount: 1,
      title: 'Add PR draft feature',
    })
    expect(draft.commits).toEqual(['Add PR draft feature'])
    expect(draft.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'example.txt', status: 'M' }),
    ]))
    expect(draft.body).toContain('## Summary')
    expect(draft.body).toContain('Add PR draft feature')
    expect(draft.warnings).toEqual(expect.arrayContaining([
      'No origin remote is configured for this repository.',
    ]))
  })

  it('dry-runs pull request creation and records audit evidence', async () => {
    const repo = await createRepo()
    const baseBranch = (await git(repo, ['branch', '--show-current'])).trim()
    await git(repo, ['checkout', '-b', 'codex/pr-create'])
    await writeFile(join(repo, 'example.txt'), 'ready for pr\n', 'utf8')
    await git(repo, ['add', 'example.txt'])
    await git(repo, ['commit', '-m', 'Prepare PR creation'])

    const result = await createWorkspacePullRequest({
      cwd: repo,
      baseBranch,
      title: 'Prepare PR creation',
      body: '## Summary\n- Test dry-run PR creation.',
      draft: true,
      dryRun: true,
    })

    expect(result).toMatchObject({
      branch: 'codex/pr-create',
      baseBranch,
      title: 'Prepare PR creation',
      draft: true,
      dryRun: true,
      url: '',
    })
    expect(result.command.slice(0, 5)).toEqual(['gh', 'pr', 'create', '--base', baseBranch])
    expect(result.command).toEqual(expect.arrayContaining(['--head', 'codex/pr-create', '--draft']))

    const auditTrail = await listWorkspaceAuditEvents({ cwd: repo, limit: 10 })
    expect(auditTrail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'git.pr_create_dry_run',
        severity: 'info',
        metadata: expect.objectContaining({
          branch: 'codex/pr-create',
          baseBranch,
          dryRun: true,
          command: result.command,
        }),
      }),
    ]))
  })

  it('creates, lists, and removes managed workspace worktrees', async () => {
    const repo = await createRepo()
    const repoRoot = await realpath(repo)
    const managedRoot = `${repoRoot}.worktrees`
    tempDirs.push(managedRoot)

    const created = await createWorkspaceWorktree({
      cwd: repo,
      branchName: 'codex/test-isolation',
      baseRef: 'HEAD',
    })

    expect(created.worktree).toMatchObject({
      branch: 'codex/test-isolation',
      isManaged: true,
      isCurrent: false,
    })
    expect(created.worktree.path).toContain(managedRoot)

    const listed = await listWorkspaceWorktrees(repo)
    expect(listed.managedRoot).toBe(managedRoot)
    expect(listed.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: repoRoot, isCurrent: true }),
      expect.objectContaining({ branch: 'codex/test-isolation', isManaged: true }),
    ]))

    const removed = await removeWorkspaceWorktree({
      cwd: repo,
      path: created.worktree.path,
    })
    expect(removed.removedPath).toBe(created.worktree.path)
    expect(removed.snapshot.worktrees.some((worktree) => worktree.path === created.worktree.path)).toBe(false)
  })

  it('rejects removing unmanaged worktrees from the worktree panel', async () => {
    const repo = await createRepo()

    await expect(removeWorkspaceWorktree({
      cwd: repo,
      path: repo,
    })).rejects.toThrow('Only managed worktrees can be removed from this panel')
  })

  it('applies the current tracked diff to a clean managed worktree', async () => {
    const repo = await createRepo()
    const repoRoot = await realpath(repo)
    const managedRoot = `${repoRoot}.worktrees`
    tempDirs.push(managedRoot)

    const created = await createWorkspaceWorktree({
      cwd: repo,
      branchName: 'codex/patch-target',
      baseRef: 'HEAD',
    })
    await writeFile(join(repo, 'example.txt'), 'patched\n', 'utf8')

    const result = await applyWorkspacePatchToWorktree({
      cwd: repo,
      path: created.worktree.path,
    })

    expect(result).toMatchObject({
      patchBytes: expect.any(Number),
      worktree: expect.objectContaining({
        branch: 'codex/patch-target',
        isManaged: true,
      }),
      targetStatus: expect.objectContaining({
        unstagedFileCount: 1,
      }),
    })
    expect(await readFile(join(created.worktree.path, 'example.txt'), 'utf8')).toBe('patched\n')
    expect(result.targetStatus.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'example.txt', status: ' M' }),
    ]))
  })

  it('rejects applying a patch to a dirty managed worktree', async () => {
    const repo = await createRepo()
    const repoRoot = await realpath(repo)
    const managedRoot = `${repoRoot}.worktrees`
    tempDirs.push(managedRoot)

    const created = await createWorkspaceWorktree({
      cwd: repo,
      branchName: 'codex/dirty-target',
      baseRef: 'HEAD',
    })
    await writeFile(join(repo, 'example.txt'), 'source patch\n', 'utf8')
    await writeFile(join(created.worktree.path, 'example.txt'), 'target dirty\n', 'utf8')

    await expect(applyWorkspacePatchToWorktree({
      cwd: repo,
      path: created.worktree.path,
    })).rejects.toThrow('Target worktree must be clean before applying a patch')
  })

  it('returns an empty delivery draft when there are no staged changes', async () => {
    const repo = await createRepo()

    const draft = await getWorkspaceGitDeliveryDraft(repo)

    expect(draft).toMatchObject({
      hasStagedChanges: false,
      fileCount: 0,
      commitMessage: 'No staged changes',
      prBody: 'Stage files to generate a PR body draft.',
      validationPlan: [],
    })
  })

  it('exposes notification policy without leaking raw webhook URLs', async () => {
    const repo = await createRepo()
    await writeFile(join(repo, '.cody-web-ui.yml'), [
      'notifications:',
      '  enabled: true',
      '  events:',
      '    - approval_required',
      '  channels:',
      '    - name: ops',
      '      type: webhook',
      '      url: http://127.0.0.1:9999/private-token',
      '      events:',
      '        - approval_required',
      'theme:',
      '  skin: cyber-ops',
      '  layout: review-focus',
      '  density: compact',
      '  accent: "#22d3ee"',
      '  followSystem: false',
    ].join('\n'), 'utf8')

    const snapshot = await getWorkspaceSnapshot(repo)

    expect(snapshot.workspaceConfig.notifications).toMatchObject({
      enabled: true,
      events: ['approval_required'],
      channels: [
        expect.objectContaining({
          name: 'ops',
          type: 'webhook',
          enabled: true,
          target: 'http://127.0.0.1:9999/...',
        }),
      ],
    })
    expect(snapshot.workspaceConfig.theme).toEqual({
      skinId: 'cyber-ops',
      accentColor: '#22d3ee',
      density: 'compact',
      layoutPresetId: 'review-focus',
      followSystem: false,
    })
    expect(JSON.stringify(snapshot.workspaceConfig.notifications)).not.toContain('private-token')
  })

  it('rejects git path actions outside the workspace root', async () => {
    const repo = await createRepo()

    await expect(runWorkspaceGitPathAction({
      cwd: repo,
      action: 'stage',
      paths: ['../outside.txt'],
    })).rejects.toThrow('filePath must stay inside the git workspace root')
  })
})
