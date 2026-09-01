import { asRecord, readJsonBody, setJson, type DomainRoute } from './httpRoute.js'

type PendingRequestGateway = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  listConversationThreads: (options?: { archived?: boolean }) => Promise<unknown>
  listConversationModels: () => Promise<unknown>
  listConversationCollaborationModes: () => Promise<unknown>
  listConversationSkills: (cwds: string[]) => Promise<unknown>
  listConversationSkillCatalog: (cwds: string[]) => Promise<unknown>
  setConversationSkillEnabled: (path: string, enabled: boolean) => Promise<void>
  startConversationThread: (context: unknown) => Promise<{ threadId: string }>
  renameConversationThread: (threadId: string, name: string) => Promise<void>
  forkConversationThread: (threadId: string) => Promise<{ threadId: string }>
  compactConversationThread: (threadId: string) => Promise<void>
  archiveConversationThread: (threadId: string) => Promise<void>
  attachConversation: (threadId: string, context: unknown) => Promise<unknown>
  snapshotConversation: (threadId: string, context: unknown) => Promise<unknown>
  submitConversation: (payload: unknown) => Promise<unknown>
  interruptConversation: (threadId: string, context: unknown) => Promise<boolean>
  respond: (payload: unknown) => Promise<void>
  listPending: () => unknown[]
  listMethods: () => Promise<string[]>
  listNotifications: () => Promise<string[]>
  diagnostics: () => Promise<unknown>
  accessSecurity: (context: Parameters<DomainRoute>[0]) => unknown
}

/** Native thread/turn ownership is intentionally unavailable through the
 * generic RPC tunnel.  Those calls must go via the conversation owner routes
 * below so a browser cannot bypass queueing, bindings, or terminal handling. */
function isConversationOwnerMethod(method: string): boolean {
  return /^(?:thread\/(?:start|resume|read|list|name\/set|fork|compact\/start|archive)|turn\/(?:start|steer|interrupt)|model\/list|collaborationMode\/list|skills\/(?:list|config\/write))$/u.test(method)
}

function queryCwds(url: URL): string[] {
  return Array.from(new Set(url.searchParams.getAll('cwd').map(value => value.trim()).filter(Boolean)))
}

export function createGatewayRoutes(gateway: PendingRequestGateway): DomainRoute {
  return async ({ req, res, url }) => {
    const key = `${req.method ?? ''} ${url.pathname}`
    if (key === 'POST /codex-api/rpc') {
      const body = asRecord(await readJsonBody(req))
      if (!body || typeof body.method !== 'string' || body.method.length === 0) setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
      else if (isConversationOwnerMethod(body.method)) setJson(res, 403, { error: `Native conversation method ${body.method} must use the Core conversation owner API` })
      else setJson(res, 200, { result: await gateway.rpc(body.method, body.params ?? null) })
    } else if (key === 'GET /codex-api/conversations/threads') {
      const archived = url.searchParams.get('archived') === 'true'
      setJson(res, 200, { result: await gateway.listConversationThreads({ archived }) })
    } else if (key === 'GET /codex-api/conversations/models') {
      setJson(res, 200, { result: await gateway.listConversationModels() })
    } else if (key === 'GET /codex-api/conversations/collaboration-modes') {
      setJson(res, 200, { result: await gateway.listConversationCollaborationModes() })
    } else if (key === 'GET /codex-api/conversations/skills') {
      setJson(res, 200, { result: await gateway.listConversationSkills(queryCwds(url)) })
    } else if (key === 'GET /codex-api/conversations/skill-catalog') {
      setJson(res, 200, { result: await gateway.listConversationSkillCatalog(queryCwds(url)) })
    } else if (key === 'POST /codex-api/conversations/skills/enabled') {
      const body = asRecord(await readJsonBody(req))
      const path = typeof body?.path === 'string' ? body.path.trim() : ''
      const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null
      if (!path || enabled === null) setJson(res, 400, { error: 'Invalid body: expected { path, enabled }' })
      else { await gateway.setConversationSkillEnabled(path, enabled); setJson(res, 200, { result: { ok: true } }) }
    } else if (key === 'POST /codex-api/conversations/threads/start') {
      const body = asRecord(await readJsonBody(req))
      const context = asRecord(body?.context)
      const thread = asRecord(context?.thread)
      if (body?.context !== undefined && !thread) setJson(res, 400, { error: 'Invalid body: expected context.thread object' })
      else setJson(res, 201, { result: await gateway.startConversationThread({ ...(context ?? {}), thread: thread ?? {} }) })
    } else if (key === 'POST /codex-api/conversations/threads/rename') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!threadId || !name) setJson(res, 400, { error: 'Invalid body: expected { threadId, name }' })
      else { await gateway.renameConversationThread(threadId, name); setJson(res, 200, { result: { ok: true } }) }
    } else if (key === 'POST /codex-api/conversations/threads/fork') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) setJson(res, 400, { error: 'Invalid body: expected { threadId }' })
      else setJson(res, 201, { result: await gateway.forkConversationThread(threadId) })
    } else if (key === 'POST /codex-api/conversations/threads/compact') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) setJson(res, 400, { error: 'Invalid body: expected { threadId }' })
      else { await gateway.compactConversationThread(threadId); setJson(res, 202, { result: { ok: true } }) }
    } else if (key === 'POST /codex-api/conversations/threads/archive') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) setJson(res, 400, { error: 'Invalid body: expected { threadId }' })
      else { await gateway.archiveConversationThread(threadId); setJson(res, 202, { result: { ok: true } }) }
    } else if (key === 'POST /codex-api/conversations/attach') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
      if (!threadId.trim()) setJson(res, 400, { error: 'Invalid body: expected { threadId, context? }' })
      else {
        const attachment = await gateway.attachConversation(threadId, body?.context ?? {})
        setJson(res, 200, { result: { attached: true, ...(asRecord(attachment) ?? {}) } })
      }
    } else if (key === 'POST /codex-api/conversations/snapshot') {
      const body = asRecord(await readJsonBody(req))
      const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
      if (!threadId.trim()) setJson(res, 400, { error: 'Invalid body: expected { threadId, context? }' })
      else setJson(res, 200, { result: await gateway.snapshotConversation(threadId, body?.context ?? {}) })
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
