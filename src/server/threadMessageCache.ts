import type { ThreadReadResponse } from '../api/appServerDtos.js'
import { toLocalImagePreviewUrl } from '../api/normalizers/userMessageContent.js'
import type { UiMessage, UiThreadMessagePage } from '../types/codex.js'
import { normalizeThreadHistory } from '@codycodeagent/cody-web-core/session'
import {
  conversationTranscriptFromState,
  createConversationState,
  reduceConversationEvents,
} from '@codycodeagent/cody-web-core/conversation'

export type ThreadMessageCacheStatus = 'loading' | 'ready' | 'refreshing' | 'failed'

export type ThreadMessageCacheEntry = {
  threadId: string
  messages: UiMessage[]
  total: number
  status: ThreadMessageCacheStatus
  hydratedAtIso: string | null
  refreshedAtIso: string | null
  checkedAtIso: string | null
  appThreadUpdatedAt: number | null
  lastError?: string
  dirty: boolean
  hydratePromise?: Promise<void>
  refreshPromise?: Promise<void>
}

export type ThreadMessageCacheOptions = {
  rpc: (method: string, params: unknown) => Promise<unknown>
  now?: () => Date
  refreshIntervalMs?: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60_000

function asThreadReadResponse(value: unknown): ThreadReadResponse {
  return value as ThreadReadResponse
}

function normalizeThreadMessages(payload: ThreadReadResponse): UiMessage[] {
  const threadId = payload.thread.id
  const state = reduceConversationEvents(
    createConversationState(threadId),
    normalizeThreadHistory(payload, threadId),
  )
  return conversationTranscriptFromState(state).map((message): UiMessage => ({
    ...message,
    ...(message.images?.length ? {
      images: message.images.map((image) => image.startsWith('/') ? toLocalImagePreviewUrl(image) : image),
    } : {}),
    ...(message.skills?.length ? {
      skills: message.skills.map((skill) => ({
        ...skill,
        displayName: skill.displayName ?? skill.name,
        description: '',
      })),
    } : {}),
  }))
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT)
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(Math.trunc(value), 0)
}

function pageMessagesBefore(
  messages: UiMessage[],
  limit: number,
  offset: number,
  beforeMessageId: string,
): { messages: UiMessage[]; start: number } {
  const matchedIndex = beforeMessageId
    ? messages.findIndex((message) => message.id === beforeMessageId)
    : -1
  const end = matchedIndex >= 0
    ? matchedIndex
    : Math.max(messages.length - offset, 0)
  const start = Math.max(end - limit, 0)
  return { messages: messages.slice(start, end), start }
}

export class ThreadMessageCache {
  private readonly entries = new Map<string, ThreadMessageCacheEntry>()
  private readonly rpc: ThreadMessageCacheOptions['rpc']
  private readonly now: () => Date
  private readonly refreshIntervalMs: number
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(options: ThreadMessageCacheOptions) {
    this.rpc = options.rpc
    this.now = options.now ?? (() => new Date())
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  }

  start(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      void this.refreshDueEntries()
    }, this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  markDirty(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return
    const entry = this.entries.get(normalizedThreadId)
    if (entry) entry.dirty = true
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId.trim())
  }

  async getMessagesPage(input: {
    threadId: string
    limit?: number
    offset?: number
    beforeMessageId?: string
  }): Promise<UiThreadMessagePage> {
    const threadId = input.threadId.trim()
    if (!threadId) throw new Error('threadId is required')

    const limit = normalizeLimit(input.limit ?? DEFAULT_LIMIT)
    const offset = normalizeOffset(input.offset ?? 0)
    const entry = this.ensureEntry(threadId)

    if (!entry.hydratedAtIso) {
      await this.hydrate(entry)
    } else if (entry.dirty) {
      await this.refresh(entry, { forceFull: true })
    }

    return this.buildPage(entry, limit, offset, input.beforeMessageId?.trim() ?? '')
  }

  async refreshDueEntries(): Promise<void> {
    const nowMs = this.now().getTime()
    await Promise.all([...this.entries.values()].map(async (entry) => {
      if (!entry.hydratedAtIso) return
      if (entry.dirty) {
        await this.refresh(entry, { forceFull: true })
        return
      }
      const checkedAtMs = entry.checkedAtIso ? Date.parse(entry.checkedAtIso) : 0
      if (Number.isFinite(checkedAtMs) && nowMs - checkedAtMs < this.refreshIntervalMs) return
      await this.refresh(entry, { forceFull: false })
    }))
  }

  private ensureEntry(threadId: string): ThreadMessageCacheEntry {
    const existing = this.entries.get(threadId)
    if (existing) return existing

    const entry: ThreadMessageCacheEntry = {
      threadId,
      messages: [],
      total: 0,
      status: 'loading',
      hydratedAtIso: null,
      refreshedAtIso: null,
      checkedAtIso: null,
      appThreadUpdatedAt: null,
      dirty: false,
    }
    this.entries.set(threadId, entry)
    return entry
  }

  private async hydrate(entry: ThreadMessageCacheEntry): Promise<void> {
    if (entry.hydratePromise) return entry.hydratePromise

    entry.status = 'loading'
    entry.hydratePromise = this.fetchFull(entry)
      .finally(() => {
        entry.hydratePromise = undefined
      })
    return entry.hydratePromise
  }

  private async refresh(entry: ThreadMessageCacheEntry, options: { forceFull: boolean }): Promise<void> {
    if (entry.refreshPromise) return entry.refreshPromise

    entry.status = 'refreshing'
    entry.refreshPromise = this.refreshInternal(entry, options)
      .finally(() => {
        entry.refreshPromise = undefined
      })
    return entry.refreshPromise
  }

  private async refreshInternal(entry: ThreadMessageCacheEntry, options: { forceFull: boolean }): Promise<void> {
    try {
      if (!options.forceFull) {
        try {
          const metadata = asThreadReadResponse(await this.rpc('thread/read', {
            threadId: entry.threadId,
            includeTurns: false,
          }))
          const nextUpdatedAt = metadata.thread.updatedAt
          entry.checkedAtIso = this.now().toISOString()
          if (entry.appThreadUpdatedAt === nextUpdatedAt) {
            entry.status = 'ready'
            entry.dirty = false
            entry.lastError = undefined
            return
          }
        } catch {
          // Fall back to a full refresh when the cheap metadata check is unavailable.
        }
      }

      await this.fetchFull(entry)
    } catch (error) {
      entry.status = 'failed'
      entry.lastError = error instanceof Error ? error.message : 'Failed to refresh thread cache'
      throw error
    }
  }

  private async fetchFull(entry: ThreadMessageCacheEntry): Promise<void> {
    try {
      const payload = asThreadReadResponse(await this.rpc('thread/read', {
        threadId: entry.threadId,
        includeTurns: true,
      }))
      const nowIso = this.now().toISOString()
      const messages = normalizeThreadMessages(payload)
      entry.messages = messages
      entry.total = messages.length
      entry.status = 'ready'
      entry.hydratedAtIso = entry.hydratedAtIso ?? nowIso
      entry.refreshedAtIso = nowIso
      entry.checkedAtIso = nowIso
      entry.appThreadUpdatedAt = payload.thread.updatedAt
      entry.lastError = undefined
      entry.dirty = false
    } catch (error) {
      entry.status = 'failed'
      entry.lastError = error instanceof Error ? error.message : 'Failed to hydrate thread cache'
      throw error
    }
  }

  private buildPage(
    entry: ThreadMessageCacheEntry,
    limit: number,
    offset: number,
    beforeMessageId: string,
  ): UiThreadMessagePage {
    const page = pageMessagesBefore(entry.messages, limit, offset, beforeMessageId)
    const messages = page.messages
    const nextOffset = entry.messages.length - page.start
    const remainingBefore = page.start
    return {
      threadId: entry.threadId,
      messages,
      total: entry.total,
      limit,
      offset,
      nextOffset,
      nextBeforeMessageId: messages[0]?.id ?? null,
      remainingBefore,
      hasMoreBefore: remainingBefore > 0,
      cache: {
        status: entry.status,
        hydratedAtIso: entry.hydratedAtIso,
        refreshedAtIso: entry.refreshedAtIso,
        checkedAtIso: entry.checkedAtIso,
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      },
    }
  }
}
