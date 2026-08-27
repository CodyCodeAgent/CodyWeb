import type Database from 'better-sqlite3'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { withLocalDatabase } from './localDatabase.js'

const LEGACY_SETTING_KEY = 'prompt-library.templates.v1'
const MAX_BODY_BYTES = 512 * 1024

export type StoredPromptTemplate = {
  id: string; title: string; description: string; content: string; category: string
  primarySkill: { name: string; path: string; displayName: string; description: string } | null
  authoringMode: 'human' | 'ai'
  scope: 'global' | 'workspace'; workspaceCwd: string; isFavorite: boolean
  useCount: number; lastUsedAtIso: string; createdAtIso: string; updatedAtIso: string
}

function ensurePromptTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      primary_skill_json TEXT NOT NULL DEFAULT 'null',
      authoring_mode TEXT NOT NULL DEFAULT 'human',
      category TEXT NOT NULL DEFAULT 'General',
      scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace')),
      workspace_cwd TEXT NOT NULL DEFAULT '',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at_iso TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_templates_scope ON prompt_templates(scope, workspace_cwd);
    CREATE INDEX IF NOT EXISTS idx_prompt_templates_recent ON prompt_templates(last_used_at_iso DESC);
  `)
  const columns = db.prepare('PRAGMA table_info(prompt_templates)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'primary_skill_json')) {
    db.exec("ALTER TABLE prompt_templates ADD COLUMN primary_skill_json TEXT NOT NULL DEFAULT 'null'")
  }
  if (!columns.some((column) => column.name === 'authoring_mode')) {
    db.exec("ALTER TABLE prompt_templates ADD COLUMN authoring_mode TEXT NOT NULL DEFAULT 'human'")
  }
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

function primarySkill(value: unknown): StoredPromptTemplate['primarySkill'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const name = text(row.name); const path = text(row.path)
  if (!name || !path || name.length > 160 || path.length > 2_048) return null
  return { name, path, displayName: text(row.displayName) || name, description: text(row.description).slice(0, 1_000) }
}

function parsePrimarySkill(value: unknown): StoredPromptTemplate['primarySkill'] {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return primarySkill(JSON.parse(value)) } catch { return null }
}

function normalizeTemplate(value: unknown): StoredPromptTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = text(row.id); const title = text(row.title); const content = text(row.content)
  if (!id || !title || !content || id.length > 160 || title.length > 160 || content.length > 128 * 1024) return null
  const scope = row.scope === 'workspace' ? 'workspace' : 'global'
  const now = new Date().toISOString()
  return {
    id, title, content, description: text(row.description), category: text(row.category) || 'General', scope,
    primarySkill: primarySkill(row.primarySkill), authoringMode: row.authoringMode === 'ai' ? 'ai' : 'human',
    workspaceCwd: scope === 'workspace' ? text(row.workspaceCwd) : '', isFavorite: row.isFavorite === true,
    useCount: typeof row.useCount === 'number' && Number.isFinite(row.useCount) ? Math.max(0, Math.trunc(row.useCount)) : 0,
    lastUsedAtIso: text(row.lastUsedAtIso), createdAtIso: text(row.createdAtIso) || now, updatedAtIso: text(row.updatedAtIso) || now,
  }
}

function upsertTemplate(db: Database.Database, template: StoredPromptTemplate): void {
  db.prepare(`
    INSERT INTO prompt_templates (id, title, description, content, primary_skill_json, authoring_mode, category, scope, workspace_cwd, is_favorite, use_count, last_used_at_iso, created_at_iso, updated_at_iso)
    VALUES (@id, @title, @description, @content, @primarySkillJson, @authoringMode, @category, @scope, @workspaceCwd, @isFavorite, @useCount, @lastUsedAtIso, @createdAtIso, @updatedAtIso)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content,
      primary_skill_json=excluded.primary_skill_json, authoring_mode=excluded.authoring_mode,
      category=excluded.category, scope=excluded.scope, workspace_cwd=excluded.workspace_cwd,
      is_favorite=excluded.is_favorite, use_count=excluded.use_count, last_used_at_iso=excluded.last_used_at_iso,
      updated_at_iso=excluded.updated_at_iso
  `).run({ ...template, primarySkillJson: JSON.stringify(template.primarySkill), isFavorite: template.isFavorite ? 1 : 0 })
}

function migrateLegacyTemplates(db: Database.Database): void {
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get() as { count?: unknown })?.count ?? 0)
  if (count > 0) return
  const settingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  if (!settingsTable) return
  const row = db.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ? LIMIT 1').get(LEGACY_SETTING_KEY) as { valueJson?: unknown } | undefined
  if (typeof row?.valueJson !== 'string') return
  try {
    const values = JSON.parse(row.valueJson) as unknown
    if (!Array.isArray(values)) return
    for (const value of values) {
      const template = normalizeTemplate(value)
      if (template) upsertTemplate(db, template)
    }
  } catch { /* Ignore malformed legacy settings. */ }
}

export async function listPromptTemplates(): Promise<StoredPromptTemplate[]> {
  return withLocalDatabase((db) => {
    ensurePromptTable(db); migrateLegacyTemplates(db)
    const rows = db.prepare(`SELECT id, title, description, content, primary_skill_json AS primarySkillJson, authoring_mode AS authoringMode, category, scope, workspace_cwd AS workspaceCwd,
      is_favorite AS isFavorite, use_count AS useCount, last_used_at_iso AS lastUsedAtIso,
      created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso FROM prompt_templates ORDER BY updated_at_iso DESC`).all()
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      primarySkill: parsePrimarySkill(row.primarySkillJson),
      authoringMode: row.authoringMode === 'ai' ? 'ai' : 'human',
      isFavorite: row.isFavorite === 1,
    } as StoredPromptTemplate))
  })
}

export async function findPromptTemplate(idValue: unknown): Promise<StoredPromptTemplate | null> {
  const id = text(idValue)
  if (!id) return null
  return (await listPromptTemplates()).find((template) => template.id === id) ?? null
}

export async function replacePromptTemplates(values: unknown): Promise<StoredPromptTemplate[]> {
  if (!Array.isArray(values)) throw new Error('templates must be an array')
  const templates = values.map(normalizeTemplate).filter((value): value is StoredPromptTemplate => value !== null)
  if (templates.length !== values.length) throw new Error('One or more prompt templates are invalid')
  await withLocalDatabase((db) => {
    ensurePromptTable(db)
    db.transaction(() => {
      const ids = new Set(templates.map((template) => template.id))
      for (const template of templates) upsertTemplate(db, template)
      for (const row of db.prepare('SELECT id FROM prompt_templates').all() as Array<{ id: string }>) {
        if (!ids.has(row.id)) db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(row.id)
      }
    })()
  })
  return listPromptTemplates()
}

export async function savePromptTemplate(value: unknown, expectedUpdatedAt = ''): Promise<StoredPromptTemplate> {
  const template = normalizeTemplate(value)
  if (!template) throw new Error('Prompt template is invalid')
  return withLocalDatabase((db) => {
    ensurePromptTable(db); migrateLegacyTemplates(db)
    const existing = db.prepare('SELECT updated_at_iso AS updatedAtIso FROM prompt_templates WHERE id = ?').get(template.id) as { updatedAtIso?: string } | undefined
    if (existing && expectedUpdatedAt && existing.updatedAtIso !== expectedUpdatedAt) {
      throw new Error('Prompt template changed in another session')
    }
    upsertTemplate(db, template)
    return template
  })
}

export async function deletePromptTemplate(idValue: unknown, expectedUpdatedAt = ''): Promise<void> {
  const id = text(idValue)
  if (!id) throw new Error('Prompt template id is required')
  await withLocalDatabase((db) => {
    ensurePromptTable(db)
    const existing = db.prepare('SELECT updated_at_iso AS updatedAtIso FROM prompt_templates WHERE id = ?').get(id) as { updatedAtIso?: string } | undefined
    if (existing && expectedUpdatedAt && existing.updatedAtIso !== expectedUpdatedAt) throw new Error('Prompt template changed in another session')
    db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id)
  })
}

export async function updatePromptTemplateUsage(idValue: unknown, usedAtValue: unknown): Promise<StoredPromptTemplate> {
  const id = text(idValue); const usedAtIso = text(usedAtValue) || new Date().toISOString()
  if (!id) throw new Error('Prompt template id is required')
  return withLocalDatabase((db) => {
    ensurePromptTable(db)
    db.prepare('UPDATE prompt_templates SET use_count = use_count + 1, last_used_at_iso = ?, updated_at_iso = ? WHERE id = ?').run(usedAtIso, usedAtIso, id)
    const row = db.prepare(`SELECT id, title, description, content, category, scope, workspace_cwd AS workspaceCwd,
      is_favorite AS isFavorite, use_count AS useCount, last_used_at_iso AS lastUsedAtIso,
      primary_skill_json AS primarySkillJson, authoring_mode AS authoringMode,
      created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso FROM prompt_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error('Prompt template was not found')
    return { ...row, primarySkill: parsePrimarySkill(row.primarySkillJson), authoringMode: row.authoringMode === 'ai' ? 'ai' : 'human', isFavorite: row.isFavorite === 1 } as StoredPromptTemplate
  })
}

export async function updatePromptTemplateFavorite(idValue: unknown, favorite: unknown): Promise<StoredPromptTemplate> {
  const id = text(idValue)
  if (!id || typeof favorite !== 'boolean') throw new Error('Prompt template favorite update is invalid')
  return withLocalDatabase((db) => {
    ensurePromptTable(db)
    const updatedAtIso = new Date().toISOString()
    db.prepare('UPDATE prompt_templates SET is_favorite = ?, updated_at_iso = ? WHERE id = ?').run(favorite ? 1 : 0, updatedAtIso, id)
    const row = db.prepare(`SELECT id, title, description, content, category, scope, workspace_cwd AS workspaceCwd,
      is_favorite AS isFavorite, use_count AS useCount, last_used_at_iso AS lastUsedAtIso,
      primary_skill_json AS primarySkillJson, authoring_mode AS authoringMode,
      created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso FROM prompt_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error('Prompt template was not found')
    return { ...row, primarySkill: parsePrimarySkill(row.primarySkillJson), authoringMode: row.authoringMode === 'ai' ? 'ai' : 'human', isFavorite: row.isFavorite === 1 } as StoredPromptTemplate
  })
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of req) { const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk; size += value.byteLength; if (size > MAX_BODY_BYTES) throw new Error('Request body is too large'); chunks.push(value) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
}

function send(res: ServerResponse, status: number, payload: unknown): void { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)) }

export async function handleListPromptTemplates(_url: URL, res: ServerResponse): Promise<void> {
  send(res, 200, { result: { templates: await listPromptTemplates() } })
}

export async function handleReplacePromptTemplates(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req) as { templates?: unknown }
  send(res, 200, { result: { templates: await replacePromptTemplates(body.templates) } })
}

export async function handleSavePromptTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req) as { template?: unknown; expectedUpdatedAt?: unknown }
  send(res, 200, { result: { template: await savePromptTemplate(body.template, text(body.expectedUpdatedAt)) } })
}

export async function handleDeletePromptTemplate(url: URL, res: ServerResponse): Promise<void> {
  await deletePromptTemplate(url.searchParams.get('id'), url.searchParams.get('expectedUpdatedAt') ?? '')
  send(res, 200, { result: { ok: true } })
}

export async function handleUsePromptTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req) as { id?: unknown; usedAtIso?: unknown }
  send(res, 200, { result: { template: await updatePromptTemplateUsage(body.id, body.usedAtIso) } })
}

export async function handleFavoritePromptTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req) as { id?: unknown; isFavorite?: unknown }
  send(res, 200, { result: { template: await updatePromptTemplateFavorite(body.id, body.isFavorite) } })
}
