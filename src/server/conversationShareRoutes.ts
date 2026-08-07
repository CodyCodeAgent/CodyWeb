import type { Request, Response } from 'express'
import {
  createConversationShare,
  listConversationShares,
  lookupConversationShare,
  revokeConversationShare,
} from './conversationShareStore.js'
import {
  renderConversationSharePage,
  renderConversationShareUnavailable,
  sendConversationShareHtml,
} from './conversationSharePage.js'
import { renderConversationShareImage, sendConversationShareImage } from './conversationShareImage.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function requestLocale(req: Request): 'en' | 'zh-CN' {
  const queryLocale = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : ''
  if (queryLocale === 'en' || queryLocale.startsWith('en-')) return 'en'
  if (queryLocale === 'zh' || queryLocale.startsWith('zh-')) return 'zh-CN'
  return req.acceptsLanguages('zh-CN', 'zh', 'en') === 'en' ? 'en' : 'zh-CN'
}

export function handlePublicConversationShare(req: Request, res: Response, databasePath?: string): void {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token : ''
    const result = lookupConversationShare(token, databasePath)
    if (result.status === 'active') {
      sendConversationShareHtml(res, 200, renderConversationSharePage(result.share, `/share/${token}/image.svg`))
      return
    }
    const statusCode = result.status === 'expired' || result.status === 'revoked' ? 410 : 404
    sendConversationShareHtml(res, statusCode, renderConversationShareUnavailable(result.status, requestLocale(req)))
  } catch {
    sendConversationShareHtml(res, 500, renderConversationShareUnavailable('missing', requestLocale(req)))
  }
}

export function handlePublicConversationShareImage(req: Request, res: Response, databasePath?: string): void {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token : ''
    const result = lookupConversationShare(token, databasePath)
    if (result.status === 'active') {
      sendConversationShareImage(res, result.share.title, renderConversationShareImage(result.share))
      return
    }
    res.status(result.status === 'missing' ? 404 : 410).end()
  } catch {
    res.status(500).end()
  }
}

export function handleCreateConversationShare(req: Request, res: Response, databasePath?: string): void {
  try {
    const body = asRecord(req.body)
    if (!body) {
      res.status(400).json({ error: 'Invalid share request' })
      return
    }
    const threadId = typeof body.threadId === 'string' ? body.threadId : ''
    const expiresInDays = body.expiresInDays === null
      ? null
      : typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)
        ? body.expiresInDays
        : 30
    const result = createConversationShare({
      threadId,
      snapshot: body.snapshot,
      expiresInDays,
      databasePath,
    })
    res.status(201).json({ result: { share: result.summary } })
  } catch (error) {
    res.status(400).json({ error: errorMessage(error, 'Failed to create conversation share') })
  }
}

export function handleListConversationShares(req: Request, res: Response, databasePath?: string): void {
  try {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : ''
    if (!threadId.trim()) {
      res.status(400).json({ error: 'threadId is required' })
      return
    }
    res.json({ result: { shares: listConversationShares(threadId, databasePath) } })
  } catch (error) {
    res.status(500).json({ error: errorMessage(error, 'Failed to list conversation shares') })
  }
}

export function handleRevokeConversationShare(req: Request, res: Response, databasePath?: string): void {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id : ''
    const revoked = revokeConversationShare(id, databasePath)
    if (!revoked) {
      res.status(404).json({ error: 'Share not found' })
      return
    }
    res.json({ result: { revoked: true } })
  } catch (error) {
    res.status(500).json({ error: errorMessage(error, 'Failed to revoke conversation share') })
  }
}
