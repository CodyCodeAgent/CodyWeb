import { setJson, type DomainRoute } from './httpRoute.js'
import type { ThreadMessageCache } from '../threadMessageCache.js'

function readIntegerParam(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

export function createThreadCacheRoutes(cache: ThreadMessageCache): DomainRoute {
  return async ({ req, res, url }) => {
    const key = `${req.method ?? ''} ${url.pathname}`
    if (key !== 'GET /codex-api/thread-cache/messages') return false

    const threadId = url.searchParams.get('threadId')?.trim() ?? ''
    if (!threadId) {
      setJson(res, 400, { error: 'threadId is required' })
      return true
    }

    const result = await cache.getMessagesPage({
      threadId,
      limit: readIntegerParam(url.searchParams.get('limit'), 10),
      offset: readIntegerParam(url.searchParams.get('offset'), 0),
      beforeMessageId: url.searchParams.get('beforeMessageId')?.trim() ?? '',
    })
    setJson(res, 200, { result })
    return true
  }
}
