import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deletePromptTemplate, listPromptTemplates, replacePromptTemplates, savePromptTemplate, updatePromptTemplateFavorite, updatePromptTemplateUsage } from './promptLibraryStore'

let tempDir = ''

afterEach(async () => {
  delete process.env.CODY_WEB_UI_SETTINGS_DB
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('prompt library store', () => {
  it('stores prompt templates as dedicated sqlite rows', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cody-prompt-library-'))
    process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
    const now = '2026-07-12T00:00:00.000Z'

    await replacePromptTemplates([{
      id: 'review', title: 'Review', description: 'Review changes', content: 'Review the changes.',
      primarySkill: {
        name: 'code-review', path: '/repo/.codex/skills/code-review/SKILL.md',
        displayName: 'Code review', description: 'Review workspace changes.',
      }, authoringMode: 'ai',
      category: 'Review', scope: 'workspace', workspaceCwd: '/repo', isFavorite: true,
      useCount: 2, lastUsedAtIso: now, createdAtIso: now, updatedAtIso: now,
    }])

    await expect(listPromptTemplates()).resolves.toEqual([expect.objectContaining({
      id: 'review', scope: 'workspace', workspaceCwd: '/repo', isFavorite: true, useCount: 2,
      authoringMode: 'ai', primarySkill: expect.objectContaining({ name: 'code-review' }),
    })])
  })

  it('deletes rows omitted from a replacement transaction', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cody-prompt-library-'))
    process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
    const base = { description: '', category: 'General', scope: 'global' as const, workspaceCwd: '', isFavorite: false, useCount: 0, lastUsedAtIso: '', createdAtIso: '2026-07-12T00:00:00.000Z', updatedAtIso: '2026-07-12T00:00:00.000Z' }
    await replacePromptTemplates([{ ...base, id: 'one', title: 'One', content: 'One' }, { ...base, id: 'two', title: 'Two', content: 'Two' }])
    await replacePromptTemplates([{ ...base, id: 'two', title: 'Two', content: 'Updated' }])
    expect((await listPromptTemplates()).map((item) => item.id)).toEqual(['two'])
  })

  it('updates individual templates atomically and rejects stale editors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cody-prompt-library-'))
    process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
    const base = { description: '', category: 'General', scope: 'global' as const, workspaceCwd: '', isFavorite: false, useCount: 0, lastUsedAtIso: '', createdAtIso: '2026-07-12T00:00:00.000Z', updatedAtIso: '2026-07-12T00:00:00.000Z' }
    const original = { ...base, id: 'atomic', title: 'Atomic', content: 'First', updatedAtIso: '2026-07-12T01:00:00.000Z' }
    await savePromptTemplate(original)
    const saved = await savePromptTemplate({ ...original, content: 'Second', updatedAtIso: '2026-07-12T02:00:00.000Z' }, original.updatedAtIso)
    expect(saved.content).toBe('Second')
    await expect(savePromptTemplate({ ...original, content: 'Stale' }, original.updatedAtIso)).rejects.toThrow('another session')

    const favorite = await updatePromptTemplateFavorite(original.id, true)
    expect(favorite.isFavorite).toBe(true)
    const used = await updatePromptTemplateUsage(original.id, '2026-07-12T03:00:00.000Z')
    expect(used.useCount).toBe(1)
    await deletePromptTemplate(original.id, used.updatedAtIso)
    expect(await listPromptTemplates()).toEqual([])
  })
})
