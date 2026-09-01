import {
  CodexSessionManager,
  type CodexConversationSnapshot,
  type ExecutionPolicyProvider,
  type ExecutionContext,
  type TurnHandle,
  type TurnInput,
  type TurnOutcome,
} from '@codycodeagent/cody-web-core/session'
import type { AppServerHost, ServerRequestReply } from '@codycodeagent/cody-web-core/runtime'
import type { CodexEvent } from '@codycodeagent/cody-web-core/conversation'
import { asRecord } from '@codycodeagent/cody-web-core/protocol'

export type ConversationSubmitIntent = {
  threadId: string
  clientCommandId: string
  mode: 'queue' | 'steer'
  context: ExecutionContext
  input: TurnInput
}

/**
 * The one product-process adapter over Core's session manager.
 *
 * HTTP/WebSocket views, Feishu, and scheduled tasks can select policy and
 * consume normalized events, but none of them can speak App Server RPC or
 * maintain a second native-turn queue.  A native thread is always bound by
 * its own id, so every adapter joins the exact same owner state.
 */
export class CodyWebConversationOwner {
  private readonly manager: CodexSessionManager
  private readonly attachedThreadIds = new Set<string>()
  private readonly attachmentByThreadId = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: CodexEvent) => void>()
  private readonly stopManagerEvents: () => void

  constructor(host: AppServerHost, policy?: ExecutionPolicyProvider) {
    this.manager = new CodexSessionManager({ host, policy })
    this.stopManagerEvents = this.manager.subscribe((event) => {
      for (const listener of this.listeners) listener(event)
    })
  }

  subscribe(listener: (event: CodexEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async attach(threadId: string, context: ExecutionContext): Promise<{ events: CodexEvent[] }> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    return { events: this.manager.listAttachmentEvents(normalizedThreadId) }
  }

  async snapshot(threadId: string, context: ExecutionContext): Promise<CodexConversationSnapshot> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    return this.manager.readSnapshot(normalizedThreadId)
  }

  async read(threadId: string, context: ExecutionContext): Promise<CodexEvent[]> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    return this.manager.read(normalizedThreadId)
  }

  async start(context: ExecutionContext): Promise<{ threadId: string }> {
    const binding = await this.manager.startThread(context)
    this.attachedThreadIds.add(binding.threadId)
    return { threadId: binding.threadId }
  }

  async submit(intent: ConversationSubmitIntent): Promise<{ clientCommandId: string }> {
    const threadId = this.threadId(intent.threadId)
    const clientCommandId = intent.clientCommandId.trim()
    if (!clientCommandId) throw new Error('clientCommandId is required')
    await this.ensureAttached(threadId, intent.context)
    this.manager.setContext(threadId, intent.context)
    return { clientCommandId: this.manager.submit(threadId, intent.input, intent.mode, clientCommandId).clientCommandId }
  }

  async submitUntilStarted(intent: ConversationSubmitIntent): Promise<TurnHandle> {
    const threadId = this.threadId(intent.threadId)
    const clientCommandId = intent.clientCommandId.trim()
    if (!clientCommandId) throw new Error('clientCommandId is required')
    await this.ensureAttached(threadId, intent.context)
    this.manager.setContext(threadId, intent.context)
    return this.manager.submit(threadId, intent.input, intent.mode, clientCommandId).started
  }

  async runEphemeral(
    context: ExecutionContext,
    input: TurnInput,
    clientCommandId: string,
    timeoutMs = 60_000,
  ): Promise<TurnOutcome> {
    const binding = await this.manager.startThread(context)
    this.attachedThreadIds.add(binding.threadId)
    const submission = this.manager.submit(binding.id, input, 'queue', clientCommandId)
    const boundedTimeoutMs = Math.max(1_000, Math.min(timeoutMs, 10 * 60_000))
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`Codex analysis timed out after ${String(boundedTimeoutMs)}ms`))
      }, boundedTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([submission.completed, timeout])
    } catch (error) {
      // This is an owner operation, not a product-side RPC escape hatch: a
      // short analysis may never leave an orphan native Turn behind on timeout.
      if (timedOut) await this.manager.interrupt(binding.id).catch(() => undefined)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async interrupt(threadId: string, context: ExecutionContext): Promise<boolean> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    return this.manager.interrupt(normalizedThreadId)
  }

  async respondApproval(threadId: string, context: ExecutionContext, requestId: string, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): Promise<void> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    await this.manager.respondApproval(normalizedThreadId, requestId, decision)
  }

  async respondQuestion(threadId: string, context: ExecutionContext, requestId: string, answer: unknown): Promise<void> {
    const normalizedThreadId = this.threadId(threadId)
    await this.ensureAttached(normalizedThreadId, context)
    this.manager.setContext(normalizedThreadId, context)
    await this.manager.respondQuestion(normalizedThreadId, requestId, answer)
  }

  /**
   * UI/Feishu replies are deliberately routed through Core's pending-request
   * manager.  The bridge must not race a raw `resolveServerRequest` call with
   * the manager's request lifecycle.
   */
  async respondServerRequest(payload: unknown): Promise<void> {
    const body = asRecord(payload)
    if (!body) throw new Error('Invalid response payload: expected object')
    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Invalid response payload: "id" must be an integer')
    const rawError = asRecord(body.error)
    const reply: ServerRequestReply = rawError
      ? {
          error: {
            code: typeof rawError.code === 'number' && Number.isFinite(rawError.code) ? Math.trunc(rawError.code) : -32000,
            message: typeof rawError.message === 'string' && rawError.message.trim() ? rawError.message.trim() : 'Server request rejected by client',
          },
        }
      : Object.prototype.hasOwnProperty.call(body, 'result')
        ? { result: body.result }
        : (() => { throw new Error('Invalid response payload: expected "result" or "error"') })()
    await this.manager.respondServerRequest(String(id), reply)
  }

  isServerRequestPending(requestId: number): boolean {
    return this.manager.isServerRequestPending(String(requestId))
  }

  async listThreads(...args: Parameters<CodexSessionManager['listThreads']>) { return this.manager.listThreads(...args) }
  async listModels() { return this.manager.listModels() }
  async listCollaborationModes() { return this.manager.listCollaborationModes() }
  async readConfig() { return this.manager.readConfig() }
  async reloadMcpServers() { return this.manager.reloadMcpServers() }
  async readAccountRateLimits() { return this.manager.readAccountRateLimits() }
  async listSkills(cwds: string[]) { return this.manager.listSkills(cwds) }
  async listSkillCatalog(cwds: string[]) { return this.manager.listSkillCatalog(cwds) }
  async setSkillEnabled(path: string, enabled: boolean) { await this.manager.setSkillEnabled(path, enabled) }
  async renameThread(threadId: string, name: string) { await this.manager.renameThread(this.threadId(threadId), name) }
  async forkThread(threadId: string) { return { threadId: await this.manager.forkThread(this.threadId(threadId)) } }
  async compactThread(threadId: string) { await this.manager.compactThread(this.threadId(threadId)) }
  async archiveThread(threadId: string) { await this.manager.archiveThread(this.threadId(threadId)) }

  async dispose(): Promise<void> {
    this.stopManagerEvents()
    this.listeners.clear()
    this.attachmentByThreadId.clear()
    this.attachedThreadIds.clear()
    await this.manager.dispose()
  }

  private threadId(value: string): string {
    const normalized = value.trim()
    if (!normalized) throw new Error('threadId is required')
    return normalized
  }

  private async ensureAttached(threadId: string, context: ExecutionContext): Promise<void> {
    if (this.attachedThreadIds.has(threadId)) return
    const pending = this.attachmentByThreadId.get(threadId)
    if (pending) return pending
    const attaching = this.manager.resume({ id: threadId, threadId }, context)
      .then(() => { this.attachedThreadIds.add(threadId) })
      .finally(() => { this.attachmentByThreadId.delete(threadId) })
    this.attachmentByThreadId.set(threadId, attaching)
    return attaching
  }
}
