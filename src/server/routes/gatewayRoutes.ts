import { asRecord, readJsonBody, setJson, type DomainRoute } from './httpRoute.js'

type PendingRequestGateway = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  attachConversation: (threadId: string, context: unknown) => Promise<void>
  submitConversation: (payload: unknown) => Promise<unknown>
  interruptConversation: (threadId: string, context: unknown) => Promise<boolean>
  respond: (payload: unknown) => Promise<void>
  listPending: () => unknown[]
  listMethods: () => Promise<string[]>
  listNotifications: () => Promise<string[]>
  diagnostics: () => Promise<unknown>
  accessSecurity: (context: Parameters<DomainRoute>[0]) => unknown
}

export function createGatewayRoutes(gateway: PendingRequestGateway): DomainRoute {
  return async ({ req, res, url }) => {
    const key = `${req.method ?? ''} ${url.pathname}`
    if (key === 'POST /codex-api/rpc') {
      const body = asRecord(await readJsonBody(req))
      if (!body || typeof body.method !== 'string' || body.method.length === 0) setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
      else setJson(res, 200, { result: await gateway.rpc(body.method, body.params ?? null) })
    } else if (key === 'POST /codex-api/conversations/attach') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
      if (!threadId.trim()) setJson(res, 400, { error: 'Invalid body: expected { threadId, context? }' })
      else {
        await gateway.attachConversation(threadId, body?.context ?? {})
        setJson(res, 200, { result: { attached: true } })
      }
    } else if (key === 'POST /codex-api/conversations/submit') {
      setJson(res, 202, { result: await gateway.submitConversation(await readJsonBody(req)) })
    } else if (key === 'POST /codex-api/conversations/interrupt') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
      if (!threadId.trim()) setJson(res, 400, { error: 'Invalid body: expected { threadId, context? }' })
      else setJson(res, 200, { result: { interrupted: await gateway.interruptConversation(threadId, body?.context ?? {}) } })
    } else if (key === 'POST /codex-api/server-requests/respond') {
      await gateway.respond(await readJsonBody(req)); setJson(res, 200, { ok: true })
    } else if (key === 'GET /codex-api/server-requests/pending') setJson(res, 200, { data: gateway.listPending() })
    else if (key === 'GET /codex-api/meta/methods') setJson(res, 200, { data: await gateway.listMethods() })
    else if (key === 'GET /codex-api/meta/notifications') setJson(res, 200, { data: await gateway.listNotifications() })
    else if (key === 'GET /codex-api/meta/diagnostics') setJson(res, 200, { result: await gateway.diagnostics() })
    else if (key === 'GET /codex-api/meta/access-security') setJson(res, 200, { result: gateway.accessSecurity({ req, res, url }) })
    else return false
    return true
  }
}
