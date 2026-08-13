import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  UiConversationShareMessage,
  UiConversationShareSnapshot,
  UiConversationShareSummary,
  UiConversationShareThemeSnapshot,
  UiToolTimelineEntry,
} from '../types/codex.js'
import { localDatabasePath, openLocalDatabase } from './localDatabase.js'

const MAX_TITLE_LENGTH = 160
const MAX_THREAD_ID_LENGTH = 240
const MAX_PROJECT_NAME_LENGTH = 160
const MAX_MESSAGES = 240
const MAX_MESSAGE_TEXT_LENGTH = 240_000
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,80}$/u
const INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/iu
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu
const RADIUS_PATTERN = /^\d{1,2}(?:\.\d{1,3})?(?:px|rem)$/u
const FONT_PATTERN = /^[\p{L}\p{N}\s,.'"_()\-]{1,240}$/u

type ConversationShareRow = {
  id: string
  tokenHash: string
  sourceThreadId: string
  title: string
  snapshotJson: string
  createdAtIso: string
  expiresAtIso: string | null
  revokedAtIso: string | null
  messageCount: number
  turnCount: number
}

export type ConversationShareRecord = UiConversationShareSummary & {
  snapshot: UiConversationShareSnapshot
  revokedAtIso: string | null
}

export type ConversationShareLookup =
  | { status: 'active'; share: ConversationShareRecord }
  | { status: 'expired' | 'revoked' | 'missing'; share: null }

const TOOL_KINDS = new Set<UiToolTimelineEntry['kind']>([
  'command', 'fileChange', 'mcp', 'collabAgent', 'webSearch', 'imageView',
  'review', 'context', 'rollback', 'unknown',
])

function ensureConversationShareTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_shares (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      source_thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      expires_at_iso TEXT,
      revoked_at_iso TEXT,
      message_count INTEGER NOT NULL,
      turn_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_shares_thread
      ON conversation_shares(source_thread_id, created_at_iso DESC);
  `)
}

function withConversationShareDb<T>(databasePath: string | undefined, operation: (db: Database.Database) => T): T {
  const db = openLocalDatabase(databasePath ?? localDatabasePath())
  try {
    ensureConversationShareTable(db)
    return operation(db)
  } finally {
    db.close()
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function trimText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\s*[:=]\s*["']?)[^"'\s,;]{4,}/giu, '$1[REDACTED]')
}

function redactPaths(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^\s`'"<>]+/gu, (path) => {
      const parts = path.split('/').filter(Boolean)
      return `…/${parts.slice(-2).join('/')}`
    })
    .replace(/\/data\d+\/home\/[^\s`'"<>]+/gu, (path) => {
      const parts = path.split('/').filter(Boolean)
      return `…/${parts.slice(-2).join('/')}`
    })
    .replace(/file:\/\/[^\s)\]}>]+/giu, '[本地文件链接已隐藏]')
    .replace(/\/codex-api\/local-image\?[^\s)\]}>]+/giu, '[本地图片已隐藏]')
}

function sanitizeText(value: unknown, shouldRedactPaths: boolean, maxLength = MAX_MESSAGE_TEXT_LENGTH): string {
  const text = typeof value === 'string' ? value.slice(0, maxLength) : ''
  const withoutSecrets = redactSecrets(text)
  return shouldRedactPaths ? redactPaths(withoutSecrets) : withoutSecrets
}

function normalizeTool(value: unknown, shouldRedactPaths: boolean): UiToolTimelineEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const kind = typeof row.kind === 'string' && TOOL_KINDS.has(row.kind as UiToolTimelineEntry['kind'])
    ? row.kind as UiToolTimelineEntry['kind']
    : 'unknown'
  const details = Array.isArray(row.details)
    ? row.details.slice(0, 120).map((detail) => sanitizeText(detail, shouldRedactPaths, 20_000)).filter(Boolean)
    : []
  return {
    kind,
    title: sanitizeText(row.title, shouldRedactPaths, 400),
    status: sanitizeText(row.status, shouldRedactPaths, 120),
    summary: sanitizeText(row.summary, shouldRedactPaths, 8_000),
    details,
    ...(typeof row.output === 'string' ? { output: sanitizeText(row.output, shouldRedactPaths, 120_000) } : {}),
    ...(typeof row.outputLabel === 'string' ? { outputLabel: sanitizeText(row.outputLabel, shouldRedactPaths, 200) } : {}),
  }
}

function normalizeInlineImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1_250_000 || !INLINE_IMAGE_PATTERN.test(value)) return null
  return value
}

function normalizeTheme(value: unknown): UiConversationShareThemeSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const colors = row.colors && typeof row.colors === 'object' && !Array.isArray(row.colors)
    ? row.colors as Record<string, unknown>
    : null
  if (!colors) return null
  const color = (key: string, fallback: string): string => (
    typeof colors[key] === 'string' && HEX_COLOR_PATTERN.test(colors[key] as string) ? colors[key] as string : fallback
  )
  const fonts = row.fonts && typeof row.fonts === 'object' && !Array.isArray(row.fonts)
    ? row.fonts as Record<string, unknown>
    : {}
  const font = (key: string, fallback: string): string => (
    typeof fonts[key] === 'string' && FONT_PATTERN.test(fonts[key] as string) ? fonts[key] as string : fallback
  )
  const radii = row.radii && typeof row.radii === 'object' && !Array.isArray(row.radii)
    ? row.radii as Record<string, unknown>
    : {}
  const radius = (key: string, fallback: string): string => (
    typeof radii[key] === 'string' && RADIUS_PATTERN.test(radii[key] as string) ? radii[key] as string : fallback
  )
  const recipes = row.recipes && typeof row.recipes === 'object' && !Array.isArray(row.recipes)
    ? row.recipes as Record<string, unknown>
    : {}
  const backgroundRow = row.background && typeof row.background === 'object' && !Array.isArray(row.background)
    ? row.background as Record<string, unknown>
    : null
  const backgroundType = backgroundRow?.type === 'grid' || backgroundRow?.type === 'noise'
    || backgroundRow?.type === 'image' || backgroundRow?.type === 'animated'
    ? backgroundRow.type
    : 'solid'
  const clampNumber = (input: unknown, fallback: number, minimum: number, maximum: number): number => (
    typeof input === 'number' && Number.isFinite(input) ? Math.max(minimum, Math.min(maximum, input)) : fallback
  )
  const assetsRow = row.assets && typeof row.assets === 'object' && !Array.isArray(row.assets)
    ? row.assets as Record<string, unknown>
    : {}
  const assets: UiConversationShareThemeSnapshot['assets'] = {}
  for (const key of ['background', 'assistantAvatar', 'userAvatar'] as const) {
    const image = normalizeInlineImage(assetsRow[key])
    if (image) assets[key] = image
  }
  return {
    skinId: trimText(row.skinId, 120).replace(/[^a-z0-9._-]/giu, '') || 'shared-skin',
    skinName: trimText(row.skinName, 160) || 'CodyWeb',
    colorMode: row.colorMode === 'dark' ? 'dark' : 'light',
    colors: {
      background: color('background', '#0f1724'),
      surface: color('surface', '#142033'),
      panel: color('panel', '#142033'),
      elevated: color('elevated', '#19263a'),
      text: color('text', '#edf3fc'),
      textMuted: color('textMuted', '#a6b3c8'),
      border: color('border', '#2b3a50'),
      accent: color('accent', '#72a7ff'),
      codeBackground: color('codeBackground', '#090f1a'),
    },
    fonts: {
      sans: font('sans', 'Inter, Arial, sans-serif'),
      mono: font('mono', 'SFMono-Regular, Consolas, monospace'),
    },
    radii: { sm: radius('sm', '8px'), md: radius('md', '14px'), lg: radius('lg', '20px') },
    recipes: {
      message: recipes.message === 'bubble' || recipes.message === 'rail' ? recipes.message : 'native',
      identity: recipes.identity === 'avatars' ? 'avatars' : 'none',
      panel: recipes.panel === 'beveled' || recipes.panel === 'glass' ? recipes.panel : 'native',
      backdrop: recipes.backdrop === 'aero-grid' || recipes.backdrop === 'grid' || recipes.backdrop === 'image'
        ? recipes.backdrop
        : 'solid',
    },
    background: backgroundRow ? {
      type: backgroundType,
      fit: backgroundRow.fit === 'contain' ? 'contain' : 'cover',
      position: typeof backgroundRow.position === 'string' && /^[\w\s.%\-]{1,80}$/u.test(backgroundRow.position)
        ? backgroundRow.position
        : 'center',
      blur: clampNumber(backgroundRow.blur, 0, 0, 48),
      dim: clampNumber(backgroundRow.dim, 30, 0, 100),
      saturation: clampNumber(backgroundRow.saturation, 100, 0, 200),
    } : null,
    assets,
  }
}

function normalizeMessage(value: unknown, shouldRedactPaths: boolean): UiConversationShareMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const role = row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : null
  const id = trimText(row.id, 240)
  const turnId = trimText(row.turnId, 240)
  if (!role || !id || !turnId) return null
  const tool = normalizeTool(row.tool, shouldRedactPaths)
  const text = sanitizeText(row.text, shouldRedactPaths)
  const imageCount = Number.isInteger(row.imageCount) ? Math.max(0, Math.min(20, Number(row.imageCount))) : 0
  const images = Array.isArray(row.images)
    ? row.images.slice(0, 20).map(normalizeInlineImage).filter((image): image is string => Boolean(image))
    : []
  if (!text.trim() && !tool && imageCount === 0) return null
  return {
    id,
    turnId,
    role,
    text,
    messageType: trimText(row.messageType, 120),
    imageCount: Math.max(imageCount, images.length),
    images,
    tool,
  }
}

export function normalizeConversationShareSnapshot(value: unknown, now = new Date()): UiConversationShareSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid share snapshot')
  const row = value as Record<string, unknown>
  const options = row.options && typeof row.options === 'object' && !Array.isArray(row.options)
    ? row.options as Record<string, unknown>
    : {}
  const redactLocalPaths = options.redactLocalPaths !== false
  const includeToolDetails = options.includeToolDetails === true
  const title = trimText(row.title, MAX_TITLE_LENGTH)
  const threadTitle = trimText(row.threadTitle, MAX_TITLE_LENGTH)
  const projectName = trimText(row.projectName, MAX_PROJECT_NAME_LENGTH)
  if (!title) throw new Error('Share title is required')
  const messages = Array.isArray(row.messages)
    ? row.messages.slice(0, MAX_MESSAGES).map((message) => normalizeMessage(message, redactLocalPaths)).filter((message): message is UiConversationShareMessage => Boolean(message))
    : []
  if (messages.length === 0) throw new Error('Select at least one conversation message')
  const selectedTurnIds = [...new Set(messages.map((message) => message.turnId))]
  const selectedMessageIds = messages.map((message) => message.id)
  const theme = normalizeTheme(row.theme)
  const snapshot: UiConversationShareSnapshot = {
    version: row.version === 2 ? 2 : 1,
    locale: row.locale === 'en' ? 'en' : 'zh-CN',
    title,
    threadTitle: threadTitle || title,
    projectName,
    createdAtIso: now.toISOString(),
    messages,
    selectedTurnIds,
    selectedMessageIds,
    theme,
    options: { includeToolDetails, redactLocalPaths },
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Selected conversation is too large to share')
  }
  return snapshot
}

function rowToRecord(row: ConversationShareRow): ConversationShareRecord {
  return {
    id: row.id,
    title: row.title,
    threadId: row.sourceThreadId,
    publicPath: '',
    createdAtIso: row.createdAtIso,
    expiresAtIso: row.expiresAtIso,
    revokedAtIso: row.revokedAtIso,
    messageCount: row.messageCount,
    turnCount: row.turnCount,
    snapshot: JSON.parse(row.snapshotJson) as UiConversationShareSnapshot,
  }
}

function readRow(value: unknown): ConversationShareRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as ConversationShareRow
  return typeof row.id === 'string' && typeof row.snapshotJson === 'string' ? row : null
}

export function createConversationShare(input: {
  threadId: string
  snapshot: unknown
  expiresInDays: number | null
  databasePath?: string
  now?: Date
}): { summary: UiConversationShareSummary; token: string } {
  const now = input.now ?? new Date()
  const threadId = trimText(input.threadId, MAX_THREAD_ID_LENGTH)
  if (!threadId) throw new Error('Thread id is required')
  const snapshot = normalizeConversationShareSnapshot(input.snapshot, now)
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const normalizedDays = input.expiresInDays === null
    ? null
    : Math.max(1, Math.min(365, Math.floor(input.expiresInDays)))
  const expiresAtIso = normalizedDays === null
    ? null
    : new Date(now.getTime() + normalizedDays * 24 * 60 * 60 * 1000).toISOString()
  const snapshotJson = JSON.stringify(snapshot)
  const turnCount = snapshot.selectedTurnIds.length

  withConversationShareDb(input.databasePath, (db) => {
    db.prepare(`
      INSERT INTO conversation_shares (
        id, token_hash, source_thread_id, title, snapshot_json,
        created_at_iso, expires_at_iso, revoked_at_iso, message_count, turn_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, tokenHash(token), threadId, snapshot.title, snapshotJson, now.toISOString(), expiresAtIso, snapshot.messages.length, turnCount)
  })

  return {
    token,
    summary: {
      id,
      title: snapshot.title,
      threadId,
      publicPath: `/share/${token}`,
      createdAtIso: now.toISOString(),
      expiresAtIso,
      messageCount: snapshot.messages.length,
      turnCount,
    },
  }
}

export function lookupConversationShare(token: string, databasePath?: string, now = new Date()): ConversationShareLookup {
  if (!TOKEN_PATTERN.test(token)) return { status: 'missing', share: null }
  const row = withConversationShareDb(databasePath, (db) => readRow(db.prepare(`
    SELECT id, token_hash AS tokenHash, source_thread_id AS sourceThreadId,
      title, snapshot_json AS snapshotJson, created_at_iso AS createdAtIso,
      expires_at_iso AS expiresAtIso, revoked_at_iso AS revokedAtIso,
      message_count AS messageCount, turn_count AS turnCount
    FROM conversation_shares WHERE token_hash = ? LIMIT 1
  `).get(tokenHash(token))))
  if (!row) return { status: 'missing', share: null }
  if (row.revokedAtIso) return { status: 'revoked', share: null }
  if (row.expiresAtIso && Date.parse(row.expiresAtIso) <= now.getTime()) return { status: 'expired', share: null }
  return { status: 'active', share: rowToRecord(row) }
}

export function listConversationShares(threadId: string, databasePath?: string, now = new Date()): UiConversationShareSummary[] {
  const normalizedThreadId = trimText(threadId, MAX_THREAD_ID_LENGTH)
  if (!normalizedThreadId) return []
  return withConversationShareDb(databasePath, (db) => {
    const rows = db.prepare(`
      SELECT id, source_thread_id AS sourceThreadId, title,
        created_at_iso AS createdAtIso, expires_at_iso AS expiresAtIso,
        message_count AS messageCount, turn_count AS turnCount
      FROM conversation_shares
      WHERE source_thread_id = ? AND revoked_at_iso IS NULL
        AND (expires_at_iso IS NULL OR expires_at_iso > ?)
      ORDER BY created_at_iso DESC
      LIMIT 50
    `).all(normalizedThreadId, now.toISOString()) as Array<Omit<ConversationShareRow, 'tokenHash' | 'snapshotJson' | 'revokedAtIso'>>
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      threadId: row.sourceThreadId,
      publicPath: '',
      createdAtIso: row.createdAtIso,
      expiresAtIso: row.expiresAtIso,
      messageCount: Number(row.messageCount),
      turnCount: Number(row.turnCount),
    }))
  })
}

export function revokeConversationShare(id: string, databasePath?: string, now = new Date()): boolean {
  const normalizedId = trimText(id, 80)
  if (!normalizedId) return false
  return withConversationShareDb(databasePath, (db) => db.prepare(`
    UPDATE conversation_shares SET revoked_at_iso = ?
    WHERE id = ? AND revoked_at_iso IS NULL
  `).run(now.toISOString(), normalizedId).changes > 0)
}
