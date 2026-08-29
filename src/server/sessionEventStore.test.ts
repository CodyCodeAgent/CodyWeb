import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendCodexSessionEvent,
  appendReconciledTokenUsageSnapshot,
  codexSessionEventFromNotification,
  listCodexSessionEvents,
  listCodexWorkspaceSessions,
  summarizeDailyTokenUsage,
  summarizeGlobalDailyTokenUsage,
} from './sessionEventStore'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-session-events-'))
  tempDirs.push(dir)
  await git(dir, ['init'])
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  })))
})

describe('codexSessionEventFromNotification', () => {
  it('reads the last usage delta from standard token usage notifications', () => {
    const event = codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'thread/tokenUsage/updated',
        atIso: '2026-07-11T05:00:00.000Z',
        params: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          tokenUsage: {
            last: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
          },
        },
      },
    )
    expect(event).toMatchObject({
      kind: 'token_usage',
      metadata: { inputTokens: 120, outputTokens: 30, totalTokens: 150, usageSource: 'realtime' },
    })
  })

  it('maps Codex notifications into replayable session events', () => {
    const event = codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'server/request',
        atIso: '2026-07-05T10:00:00.000Z',
        params: {
          request: {
            method: 'item/commandExecution/requestApproval',
            threadId: 'thread-1',
            turnId: 'turn-1',
          },
        },
      },
    )

    expect(event).toMatchObject({
      cwd: '/repo',
      repoRoot: '/repo',
      createdAtIso: '2026-07-05T10:00:00.000Z',
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'approval_required',
      severity: 'warning',
      title: 'Approval required',
      metadata: {
        requestMethod: 'item/commandExecution/requestApproval',
      },
    })
  })

  it('includes automatic checkpoint evidence in turn lifecycle metadata', () => {
    expect(codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'turn/started',
        atIso: '2026-07-05T10:00:00.000Z',
        params: { turn: { id: 'turn-1', threadId: 'thread-1' } },
        metadata: {
          beforeCheckpointId: 'checkpoint-before',
          beforeCheckpointHasPatch: true,
          beforeCheckpointPatchBytes: 123,
        },
      },
    )).toMatchObject({
      kind: 'task_started',
      metadata: {
        beforeCheckpointId: 'checkpoint-before',
        beforeCheckpointHasPatch: true,
        beforeCheckpointPatchBytes: 123,
      },
    })

    expect(codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'turn/completed',
        atIso: '2026-07-05T10:01:00.000Z',
        params: { turn: { id: 'turn-1', threadId: 'thread-1' } },
        metadata: {
          afterCheckpointId: 'checkpoint-after',
          afterCheckpointHasPatch: true,
          afterCheckpointPatchBytes: 456,
        },
      },
    )).toMatchObject({
      kind: 'task_completed',
      metadata: {
        afterCheckpointId: 'checkpoint-after',
        afterCheckpointHasPatch: true,
        afterCheckpointPatchBytes: 456,
      },
    })
  })

  it('uses rate limit usage to choose warning severity', () => {
    expect(codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: {
              usedPercent: 94.2,
            },
          },
        },
      },
    )).toMatchObject({
      kind: 'rate_limit',
      severity: 'warning',
      summary: 'Codex usage is at 94%.',
      metadata: {
        usedPercent: 94.2,
      },
    })
  })

  it('does not persist reconnect diagnostics as terminal task failures', () => {
    expect(codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'error',
        atIso: '2026-07-05T10:00:00.000Z',
        params: { threadId: 'thread-1', turnId: 'turn-1', message: 'Reconnecting... 5/5' },
      },
    )).toBeNull()

    expect(codexSessionEventFromNotification(
      { cwd: '/repo', repoRoot: '/repo' },
      {
        method: 'turn/failed',
        atIso: '2026-07-05T10:01:00.000Z',
        params: { threadId: 'thread-1', turnId: 'turn-1', error: { message: 'request timed out' } },
      },
    )).toMatchObject({
      kind: 'task_failed',
      severity: 'danger',
      summary: 'request timed out',
    })
  })
})

describe('session event store', () => {
  it('persists JSONL events and replays them by thread', async () => {
    const repo = await createRepo()

    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:00:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:01:00.000Z',
      params: { turn: { id: 'turn-b', threadId: 'thread-b' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-05T10:02:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' } },
    })

    const trail = await listCodexSessionEvents({
      cwd: repo,
      threadId: 'thread-a',
      limit: 10,
    })
    const resolvedRepo = await realpath(repo)

    expect(trail.cwd).toBe(resolvedRepo)
    expect(trail.repoRoot).toBe(resolvedRepo)
    expect(trail.truncated).toBe(false)
    expect(trail.events.map((event) => event.kind)).toEqual(['task_completed', 'task_started'])
    expect(trail.events.every((event) => event.threadId === 'thread-a')).toBe(true)
  })

  it('returns an empty trail when no events have been persisted yet', async () => {
    const repo = await createRepo()
    const trail = await listCodexSessionEvents({ cwd: repo, threadId: 'missing', limit: 5 })

    expect(trail.events).toEqual([])
    expect(trail.truncated).toBe(false)
  })

  it('summarizes recent workspace sessions by thread', async () => {
    const repo = await createRepo()

    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:00:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/plan/updated',
      atIso: '2026-07-05T10:01:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-05T10:02:00.000Z',
      params: {
        turn: { id: 'turn-a', threadId: 'thread-a' },
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          total_tokens: 1540,
          cost_usd: 0.0125,
        },
      },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:03:00.000Z',
      params: { turn: { id: 'turn-b', threadId: 'thread-b' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'server/request',
      atIso: '2026-07-05T10:04:00.000Z',
      params: {
        request: {
          method: 'item/commandExecution/requestApproval',
          threadId: 'thread-b',
          turnId: 'turn-b',
        },
      },
    })

    const trail = await listCodexWorkspaceSessions({ cwd: repo, limit: 10 })

    expect(trail.truncated).toBe(false)
    expect(trail.sessions.map((session) => session.threadId)).toEqual(['thread-b', 'thread-a'])
    expect(trail.sessions[0]).toMatchObject({
      threadId: 'thread-b',
      status: 'waiting_for_approval',
      severity: 'warning',
      eventCount: 2,
      approvalCount: 1,
      latestEventKind: 'approval_required',
    })
    expect(trail.sessions[1]).toMatchObject({
      threadId: 'thread-a',
      status: 'completed',
      severity: 'success',
      eventCount: 3,
      planUpdateCount: 1,
      latestEventKind: 'task_completed',
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      tokenUsageEventCount: 1,
      costUsd: 0.0125,
      costEventCount: 1,
    })
  })

  it('limits workspace session summaries and marks truncation', async () => {
    const repo = await createRepo()

    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:00:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' } },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/started',
      atIso: '2026-07-05T10:01:00.000Z',
      params: { turn: { id: 'turn-b', threadId: 'thread-b' } },
    })

    const trail = await listCodexWorkspaceSessions({ cwd: repo, limit: 1 })

    expect(trail.sessions).toHaveLength(1)
    expect(trail.sessions[0]?.threadId).toBe('thread-b')
    expect(trail.truncated).toBe(true)
  })

  it('summarizes daily token usage by local date and deduplicates turns', async () => {
    const repo = await createRepo()

    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-05T16:50:00.000Z',
      params: {
        turn: { id: 'turn-a', threadId: 'thread-a' },
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          cost_usd: 0.01,
        },
      },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-05T16:55:00.000Z',
      params: {
        turn: { id: 'turn-a', threadId: 'thread-a' },
        usage: {
          input_tokens: 120,
          output_tokens: 50,
          total_tokens: 170,
          cost_usd: 0.02,
        },
      },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-05T16:05:00.000Z',
      params: {
        turn: { id: 'turn-b', threadId: 'thread-b' },
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        },
      },
    })

    const usage = await summarizeDailyTokenUsage({
      cwd: repo,
      date: '2026-07-06',
      timezoneOffsetMinutes: -480,
    })

    expect(usage).toMatchObject({
      date: '2026-07-06',
      inputTokens: 320,
      outputTokens: 130,
      totalTokens: 450,
      tokenUsageEventCount: 2,
      threadCount: 2,
      turnCount: 2,
      costUsd: 0.02,
      costEventCount: 1,
      source: 'realtime-events',
    })
  })

  it('aggregates today usage across catalog workspaces', async () => {
    const firstRepo = await createRepo()
    const secondRepo = await createRepo()
    await appendCodexSessionEvent(firstRepo, {
      method: 'turn/completed', atIso: '2026-07-12T03:00:00.000Z',
      params: { turn: { id: 'turn-a', threadId: 'thread-a' }, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
    })
    await appendCodexSessionEvent(secondRepo, {
      method: 'turn/completed', atIso: '2026-07-12T04:00:00.000Z',
      params: { turn: { id: 'turn-b', threadId: 'thread-b' }, usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 } },
    })

    const usage = await summarizeGlobalDailyTokenUsage({ cwds: [firstRepo, secondRepo, firstRepo], date: '2026-07-12' })
    expect(usage).toMatchObject({ inputTokens: 300, outputTokens: 60, totalTokens: 360, threadCount: 2, turnCount: 2, source: 'realtime-events' })
  })

  it('keeps realtime sessions that have not been reconciled yet', async () => {
    const repo = await createRepo()

    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-11T02:00:00.000Z',
      params: {
        turn: { id: 'turn-a', threadId: 'session-a' },
        usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
      },
    })
    await appendCodexSessionEvent(repo, {
      method: 'turn/completed',
      atIso: '2026-07-11T02:05:00.000Z',
      params: {
        turn: { id: 'turn-b', threadId: 'session-b' },
        usage: { input_tokens: 55, output_tokens: 25, total_tokens: 80 },
      },
    })
    await appendReconciledTokenUsageSnapshot({
      cwd: repo,
      sessionId: 'session-a',
      date: '2026-07-11',
      inputTokens: 18,
      outputTokens: 7,
      totalTokens: 25,
      eventCount: 2,
      reconciledAtIso: '2026-07-11T02:10:00.000Z',
    })

    const usage = await summarizeDailyTokenUsage({ cwd: repo, date: '2026-07-11' })

    expect(usage).toMatchObject({
      inputTokens: 73,
      outputTokens: 32,
      totalTokens: 105,
      tokenUsageEventCount: 2,
      threadCount: 2,
      source: 'reconciled-rollouts',
    })
  })

  it('returns empty daily token usage for non-git directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-session-events-non-git-'))
    tempDirs.push(dir)
    const resolvedDir = await realpath(dir)

    await expect(summarizeDailyTokenUsage({
      cwd: dir,
      date: '2026-07-06',
      timezoneOffsetMinutes: -480,
    })).resolves.toMatchObject({
      cwd: resolvedDir,
      repoRoot: resolvedDir,
      date: '2026-07-06',
      totalTokens: 0,
      tokenUsageEventCount: 0,
      source: 'none',
    })
  })

  it('persists and replays session events for non-git directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cody-web-ui-session-events-non-git-'))
    tempDirs.push(dir)
    const previousDatabasePath = process.env.CODY_WEB_UI_SETTINGS_DB
    process.env.CODY_WEB_UI_SETTINGS_DB = join(dir, '.data', 'settings.sqlite3')
    try {
      await appendCodexSessionEvent(dir, {
        method: 'turn/started',
        atIso: '2026-07-19T10:00:00.000Z',
        params: { turn: { id: 'turn-plain', threadId: 'thread-plain' } },
      })

      const trail = await listCodexSessionEvents({ cwd: dir, threadId: 'thread-plain' })
      const resolvedDir = await realpath(dir)
      expect(trail).toMatchObject({ cwd: resolvedDir, repoRoot: resolvedDir, truncated: false })
      expect(trail.events).toEqual([
        expect.objectContaining({ kind: 'task_started', threadId: 'thread-plain', cwd: resolvedDir, repoRoot: resolvedDir }),
      ])
    } finally {
      if (previousDatabasePath === undefined) delete process.env.CODY_WEB_UI_SETTINGS_DB
      else process.env.CODY_WEB_UI_SETTINGS_DB = previousDatabasePath
    }
  })
})
