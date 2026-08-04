import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { localDatabasePath, withLocalDatabase } from './localDatabase.js'
import { asRecord, setJson } from './routes/httpRoute.js'

const MAX_THEME_ASSET_BYTES = 3 * 1024 * 1024
const MAX_THEME_ASSET_REQUEST_BYTES = Math.ceil(MAX_THEME_ASSET_BYTES * 4 / 3) + 16 * 1024
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u
const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
} as const

export type ThemeAsset = {
  id: string
  url: string
  mimeType: keyof typeof MIME_EXTENSIONS
  byteSize: number
}

type StoredThemeAsset = ThemeAsset & { filePath: string }

function themeAssetDirectory(): string {
  return join(dirname(localDatabasePath()), 'theme-assets')
}

async function readBoundedJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_THEME_ASSET_REQUEST_BYTES) throw new Error('Theme image request exceeds 4 MB.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function hasExpectedSignature(mimeType: ThemeAsset['mimeType'], buffer: Buffer): boolean {
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
}

function parseThemeAssetDataUrl(value: unknown): { mimeType: ThemeAsset['mimeType']; buffer: Buffer } {
  if (typeof value !== 'string') throw new Error('Theme image must be a PNG, JPEG, or WebP data URL.')
  const match = DATA_URL_PATTERN.exec(value)
  if (!match) throw new Error('Theme image must be a PNG, JPEG, or WebP data URL.')
  const mimeType = match[1] as ThemeAsset['mimeType']
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_THEME_ASSET_BYTES) {
    throw new Error('Theme image must be between 1 byte and 3 MB.')
  }
  if (!hasExpectedSignature(mimeType, buffer)) throw new Error('Theme image content does not match its declared type.')
  return { mimeType, buffer }
}

function ensureThemeAssetTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS theme_assets (
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at_iso TEXT NOT NULL
    )
  `)
}

export async function saveThemeAsset(dataUrl: unknown): Promise<ThemeAsset> {
  const { mimeType, buffer } = parseThemeAssetDataUrl(dataUrl)
  const id = createHash('sha256').update(buffer).digest('hex')
  const fileName = `${id}${MIME_EXTENSIONS[mimeType]}`
  const directory = themeAssetDirectory()
  const filePath = join(directory, fileName)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  try {
    await writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await withLocalDatabase((db) => {
    ensureThemeAssetTable(db)
    db.prepare(`
      INSERT INTO theme_assets (id, mime_type, file_name, byte_size, created_at_iso)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mime_type = excluded.mime_type,
        file_name = excluded.file_name,
        byte_size = excluded.byte_size
    `).run(id, mimeType, fileName, buffer.byteLength, new Date().toISOString())
  })
  return { id, url: `/codex-api/theme-assets/${id}`, mimeType, byteSize: buffer.byteLength }
}

export async function readThemeAsset(id: string): Promise<StoredThemeAsset | null> {
  if (!ASSET_ID_PATTERN.test(id)) return null
  const row = await withLocalDatabase((db) => {
    ensureThemeAssetTable(db)
    return db.prepare('SELECT mime_type, file_name, byte_size FROM theme_assets WHERE id = ?').get(id) as {
      mime_type: ThemeAsset['mimeType']
      file_name: string
      byte_size: number
    } | undefined
  })
  if (!row || !(row.mime_type in MIME_EXTENSIONS) || row.file_name !== `${id}${MIME_EXTENSIONS[row.mime_type]}`) return null
  const filePath = join(themeAssetDirectory(), row.file_name)
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile() || fileStat.size !== row.byte_size) return null
  } catch {
    return null
  }
  return {
    id,
    url: `/codex-api/theme-assets/${id}`,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    filePath,
  }
}

export async function handleThemeAssetUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = asRecord(await readBoundedJsonBody(req))
    if (!body) {
      setJson(res, 400, { error: 'Invalid theme image request.' })
      return
    }
    setJson(res, 200, { result: { asset: await saveThemeAsset(body.dataUrl) } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Theme image upload failed.'
    setJson(res, /exceeds|between 1 byte/iu.test(message) ? 413 : 400, { error: message })
  }
}

export async function handleThemeAssetRead(id: string, res: ServerResponse, method: string): Promise<void> {
  const asset = await readThemeAsset(id)
  if (!asset) {
    setJson(res, 404, { error: 'Theme image not found.' })
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', asset.mimeType)
  res.setHeader('Content-Length', String(asset.byteSize))
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('ETag', `"${asset.id}"`)
  if (method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(asset.filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export async function readThemeAssetBytesForTest(id: string): Promise<Buffer | null> {
  const asset = await readThemeAsset(id)
  return asset ? readFile(asset.filePath) : null
}
