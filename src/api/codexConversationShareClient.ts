import type { UiConversationShareSnapshot, UiConversationShareSummary } from '../types/codex'

type ShareApiResponse = {
  result?: {
    share?: UiConversationShareSummary
    shares?: UiConversationShareSummary[]
    revoked?: boolean
  }
  error?: string
}

async function readResponse(response: Response): Promise<ShareApiResponse> {
  const payload = await response.json().catch(() => ({})) as ShareApiResponse
  if (!response.ok) throw new Error(payload.error || `Share request failed (${String(response.status)})`)
  return payload
}

export async function createConversationShare(input: {
  threadId: string
  snapshot: UiConversationShareSnapshot
  expiresInDays: number | null
}): Promise<UiConversationShareSummary> {
  const payload = await readResponse(await fetch('/codex-api/conversation-shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
  if (!payload.result?.share) throw new Error('Share creation returned an invalid response')
  return payload.result.share
}

export async function fetchConversationShares(threadId: string): Promise<UiConversationShareSummary[]> {
  const payload = await readResponse(await fetch(`/codex-api/conversation-shares?threadId=${encodeURIComponent(threadId)}`))
  return Array.isArray(payload.result?.shares) ? payload.result.shares : []
}

export async function revokeConversationShare(id: string): Promise<void> {
  const payload = await readResponse(await fetch(`/codex-api/conversation-shares/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }))
  if (payload.result?.revoked !== true) throw new Error('Share revoke returned an invalid response')
}
