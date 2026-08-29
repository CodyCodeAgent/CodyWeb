import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listCatalog } from './catalogStore'
import { CatalogSyncService } from './catalogSyncService'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-catalog-sync-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  delete process.env.CODY_WEB_UI_SETTINGS_DB
  await rm(tempDir, { recursive: true, force: true })
})

describe('CatalogSyncService', () => {
  it('paginates active and archived Codex threads into the local catalog', async () => {
    const thread = (id: string, cwd: string, preview: string, createdAt: number, updatedAt: number) => ({
      id,
      sessionId: `session-${id}`,
      forkedFromId: null,
      parentThreadId: null,
      preview,
      name: preview,
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      historyMode: 'paginated',
      modelProvider: 'openai',
      createdAt,
      updatedAt,
      recencyAt: updatedAt,
      status: { type: 'idle' },
      path: null,
      cwd,
      cliVersion: 'test',
      source: 'appServer',
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [],
    })
    const rpc = vi.fn(async (_method: string, params: unknown) => {
      const row = params as { archived?: boolean; cursor?: string }
      if (row.archived) {
        return {
          data: [thread('archived-1', '/repo', 'Archived', 10, 20)],
          nextCursor: null,
        }
      }
      if (!row.cursor) {
        return {
          data: [thread('active-1', '/repo', 'Active one', 10, 30)],
          nextCursor: 'page-2',
        }
      }
      return {
        data: [thread('active-2', '/repo/two', 'Active two', 15, 35)],
        nextCursor: null,
      }
    })
    const service = new CatalogSyncService(rpc)

    await service.syncNow()

    expect(rpc).toHaveBeenCalledTimes(3)
    expect((await listCatalog('visible')).threadCount).toBe(2)
    expect((await listCatalog('hidden')).projects[0]?.threads[0]?.id).toBe('archived-1')
    expect(service.getStatus()).toMatchObject({ successCount: 1, failureCount: 0 })
    service.stop()
  })

  it('surfaces manual sync failures while retaining diagnostic status', async () => {
    const service = new CatalogSyncService(async () => {
      throw new Error('Codex unavailable')
    })

    await expect(service.syncNow()).rejects.toThrow('Codex unavailable')
    expect(service.getStatus()).toMatchObject({
      successCount: 0,
      failureCount: 1,
      lastError: 'Codex unavailable',
    })
    service.stop()
  })
})
