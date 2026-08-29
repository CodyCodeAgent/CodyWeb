import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_COMPOSER_IMAGE_POLICY } from '@codycodeagent/cody-web-core/composer'

const MAX_JSON_BODY_BYTES = 30 * 1024 * 1024
const IMAGE_UPLOAD_DIR = join(tmpdir(), 'cody-web-ui-images')
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body is too large')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) return null

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return null

  return JSON.parse(raw) as unknown
}

function normalizeImageMimeType(value: unknown, fileName: string): string {
  if (typeof value === 'string' && IMAGE_MIME_TO_EXT[value]) {
    return value
  }

  const extension = extname(fileName).toLowerCase()
  return IMAGE_EXT_TO_MIME[extension] ?? ''
}

function parseImageDataUrl(value: unknown): { mimeType: string; buffer: Buffer } | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/u)
  if (!match) return null

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2].replace(/\s/gu, ''), 'base64'),
  }
}

function toLocalImageUrl(filePath: string): string {
  return `/codex-api/local-image?path=${encodeURIComponent(filePath)}`
}

export async function handleImageUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJsonBody(req)
  const body = asRecord(payload)
  if (!body) {
    setJson(res, 400, { error: 'Invalid body: expected image upload object' })
    return
  }

  const name = typeof body.name === 'string' && body.name.trim().length > 0
    ? basename(body.name.trim())
    : 'image'
  const parsed = parseImageDataUrl(body.dataUrl)
  if (!parsed) {
    setJson(res, 400, { error: 'Invalid image payload: expected data URL' })
    return
  }

  const mimeType = normalizeImageMimeType(body.mimeType, name) || parsed.mimeType
  if (!IMAGE_MIME_TO_EXT[mimeType]) {
    setJson(res, 415, { error: 'Unsupported image type' })
    return
  }

  if (parsed.buffer.byteLength === 0 || parsed.buffer.byteLength > DEFAULT_COMPOSER_IMAGE_POLICY.maxBytes) {
    setJson(res, 413, { error: 'Image must be between 1 byte and 20 MB' })
    return
  }

  await mkdir(IMAGE_UPLOAD_DIR, { recursive: true })
  const id = randomUUID()
  const filePath = join(IMAGE_UPLOAD_DIR, `${id}${IMAGE_MIME_TO_EXT[mimeType]}`)
  await writeFile(filePath, parsed.buffer, { mode: 0o600 })

  setJson(res, 200, {
    result: {
      id,
      name,
      path: filePath,
      url: toLocalImageUrl(filePath),
      mimeType,
    },
  })
}

export async function handleLocalImage(reqUrl: URL, res: ServerResponse, method: string): Promise<void> {
  const filePath = reqUrl.searchParams.get('path') ?? ''
  const mimeType = IMAGE_EXT_TO_MIME[extname(filePath).toLowerCase()]
  if (!filePath || !mimeType) {
    setJson(res, 400, { error: 'Invalid local image path' })
    return
  }

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    setJson(res, 404, { error: 'Local image not found' })
    return
  }

  if (!fileStat.isFile() || fileStat.size > DEFAULT_COMPOSER_IMAGE_POLICY.maxBytes) {
    setJson(res, 400, { error: 'Invalid local image file' })
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', mimeType)
  res.setHeader('Content-Length', String(fileStat.size))
  res.setHeader('Cache-Control', 'private, max-age=3600')

  if (method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) {
      setJson(res, 500, { error: 'Failed to read local image' })
      return
    }
    res.destroy()
  })
  stream.pipe(res)
}
