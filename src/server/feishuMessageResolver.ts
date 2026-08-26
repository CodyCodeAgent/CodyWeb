/**
 * REST completion for Feishu websocket message events.
 *
 * The websocket payload is deliberately treated as the fast-path, but it is
 * not authoritative for `nonsupport`, interactive cards, merge-forwards or
 * quoted messages. This module has no SDK dependency: the runtime injects one
 * small `getMessage` adapter and can therefore use the same code in tests and
 * with either the official SDK or an HTTP client.
 */
import {
  FEISHU_RESOLVED_CARD_TEXT_KEY,
  getFeishuQuotedMessageId,
  parseFeishuMessage,
  type ParseFeishuMessageInput,
} from './feishuMessageParser.js'

type JsonRecord = Record<string, unknown>

export type FeishuMessageGetOptions = { userCardContent?: boolean }
export type FeishuMessageGetter = (messageId: string, options?: FeishuMessageGetOptions) => Promise<unknown>

export type FeishuMessageResolverLimits = {
  /** Maximum forwarded nodes rendered into a single prompt. */
  maxForwardNodes: number
  /** Maximum nested merge-forward levels rendered into a single prompt. */
  maxForwardDepth: number
  /** Maximum characters retained in a completed message body. */
  maxTextCharacters: number
  /** Whether to fetch a real quoted parent message (one bounded request). */
  resolveQuote: boolean
}

export type FeishuResolvedQuote = {
  messageId: string
  messageType?: string
  content?: string
  text?: string
  senderId?: string
  senderType?: string
  senderName?: string
  status: 'resolved' | 'unavailable'
  reason?: string
}

export type ResolvedFeishuMessage = ParseFeishuMessageInput & {
  messageType: string
  content: string
  /** Preserved REST metadata where the websocket event omitted it. */
  mentions?: unknown
  /** Bounded parent context; callers can prepend it to a model prompt. */
  quote?: FeishuResolvedQuote
  resolution: {
    fetched: boolean
    interactiveViews?: { simplified: boolean; userCardContent: boolean }
    mergeForward?: { nodeCount: number; truncated: boolean; detailUnavailable?: boolean }
  }
}

export const DEFAULT_FEISHU_MESSAGE_RESOLVER_LIMITS: FeishuMessageResolverLimits = {
  maxForwardNodes: 80,
  maxForwardDepth: 5,
  maxTextCharacters: 60_000,
  resolveQuote: true,
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function json(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}

/** Accepts official SDK, raw REST and test-fixture response shapes. */
function firstMessage(detail: unknown): JsonRecord | null {
  const record = asRecord(detail)
  if (!record) return null
  const data = asRecord(record.data) ?? record
  const items = Array.isArray(data.items) ? data.items : Array.isArray(record.items) ? record.items : []
  return asRecord(items[0]) ?? asRecord(data.message) ?? asRecord(record.message) ?? asRecord(data)
}

function allMessages(detail: unknown): JsonRecord[] {
  const record = asRecord(detail)
  if (!record) return []
  const data = asRecord(record.data) ?? record
  const items = Array.isArray(data.items) ? data.items : Array.isArray(record.items) ? record.items : []
  return items.map(asRecord).filter((item): item is JsonRecord => item !== null)
}

function messageType(message: JsonRecord | null): string {
  return asString(message?.msg_type || message?.message_type || message?.messageType)
}

function messageContent(message: JsonRecord | null): string {
  const body = asRecord(message?.body)
  return stringify(body?.content ?? message?.content)
}

function messageId(message: JsonRecord | null): string {
  return asString(message?.message_id || message?.messageId)
}

function clipped(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 40))}\n[内容已按安全上限截断]`
}

const CARD_UPGRADE_MARKER = '请升级至最新版本客户端'

function looksLikeUpgradeShell(content: string): boolean {
  return content.includes(CARD_UPGRADE_MARKER)
}

function tryStructured(content: string): JsonRecord | null {
  const direct = asRecord(json(content))
  if (!direct) return null
  if (typeof direct.user_dsl === 'string') {
    const nested = asRecord(json(direct.user_dsl))
    if (nested) return nested
  }
  return direct
}

function normalizeForDedup(value: string): string {
  return value
    .replace(/<\/?[a-z_][^>]*>/giu, '')
    .replace(/\*\*/gu, '')
    .replace(/\((?:https?:[^)]+)\)/gu, '')
    .replace(/[\s，,：:。.\[\]()（）|/、】【、]/gu, '')
}

/**
 * Full card JSON is a better base, while simplified content occasionally
 * contains values omitted by the structured view. Preserve unique lines from
 * both views and surface server-only client expansion holes honestly.
 */
export function mergeFeishuCardText(simplified: string, userCardContent: string): string {
  const clean = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean)
  const a = clean(simplified)
  const b = clean(userCardContent)
  const base = (b.length && !looksLikeUpgradeShell(userCardContent)) ? b : a
  const other = base === b ? a : b
  const seen = new Set(base.map(normalizeForDedup).filter(Boolean))
  const output = [...base]
  let sawHole = false
  for (const line of other) {
    if (line.includes(CARD_UPGRADE_MARKER)) { sawHole = true; continue }
    const key = normalizeForDedup(line)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(line)
  }
  if ((a.some((line) => line.includes(CARD_UPGRADE_MARKER)) || sawHole) && !output.some((line) => line.includes('卡片内嵌组件'))) {
    output.push('[卡片内嵌组件，需在飞书客户端展开查看]')
  }
  return output.join('\n') || '[卡片]'
}

function effectiveCardContent(raw: string, mergedText: string): string {
  const structured = tryStructured(raw)
  if (!structured) return JSON.stringify({ [FEISHU_RESOLVED_CARD_TEXT_KEY]: mergedText })
  return JSON.stringify({ ...structured, [FEISHU_RESOLVED_CARD_TEXT_KEY]: mergedText })
}

async function resolveInteractive(messageIdValue: string, fallbackContent: string, getMessage: FeishuMessageGetter, maxText: number): Promise<{
  content: string
  fetched: boolean
  views: { simplified: boolean; userCardContent: boolean }
}> {
  // Both shapes are useful. Run in parallel so an event handler never waits
  // for two network round trips; failures are deliberately independent.
  const [simplifiedResult, fullResult] = await Promise.allSettled([
    getMessage(messageIdValue, { userCardContent: false }),
    getMessage(messageIdValue, { userCardContent: true }),
  ])
  const simplified = simplifiedResult.status === 'fulfilled' ? firstMessage(simplifiedResult.value) : null
  const full = fullResult.status === 'fulfilled' ? firstMessage(fullResult.value) : null
  const simplifiedContent = messageContent(simplified)
  const fullContent = messageContent(full)
  const parseText = (content: string) => content
    ? parseFeishuMessage({ messageType: 'interactive', content }).text
    : ''
  const aText = parseText(simplifiedContent || fallbackContent)
  const bText = parseText(fullContent || fallbackContent)
  const mergedText = clipped(mergeFeishuCardText(aText, bText), maxText)
  // Full structured content retains v2 resources. If unavailable, preserve
  // user_dsl from the event before using the simplified REST shell.
  const base = fullContent || (tryStructured(fallbackContent) ? fallbackContent : simplifiedContent) || fallbackContent
  return {
    content: effectiveCardContent(base, mergedText),
    fetched: Boolean(simplifiedContent || fullContent),
    views: { simplified: Boolean(simplifiedContent), userCardContent: Boolean(fullContent) },
  }
}

function senderName(message: JsonRecord): string {
  const sender = asRecord(message.sender)
  return asString(sender?.sender_name || message.sender_name || sender?.name)
}

function senderIdentity(message: JsonRecord): { senderId?: string; senderType?: string; senderName?: string } {
  const sender = asRecord(message.sender) ?? {}
  const senderId = asRecord(sender.sender_id || sender.senderId) ?? asRecord(message.sender_id || message.senderId) ?? {}
  // union_id is tenant-stable across apps. A foreign bot's open_id is scoped
  // to the receiving app and can differ between REST quote lookup and the
  // later websocket event, so prefer union_id whenever Feishu supplies it.
  const id = [senderId.union_id, senderId.unionId, senderId.open_id, senderId.openId, senderId.app_id, senderId.appId, sender.id]
    .map(asString).find(Boolean)
  const type = asString(sender.sender_type || sender.senderType || message.sender_type || message.senderType)
  const name = senderName(message)
  return {
    ...(id ? { senderId: id } : {}),
    ...(type ? { senderType: type } : {}),
    ...(name ? { senderName: name } : {}),
  }
}

function cloneWith(message: JsonRecord, patch: JsonRecord): JsonRecord {
  return { ...message, ...patch, body: { ...(asRecord(message.body) ?? {}), ...(asRecord(patch.body) ?? {}) } }
}

/** Expand a REST merge-forward response once; never recursively call its parent. */
async function resolveMergeForward(input: {
  rootMessageId: string
  fallbackContent: string
  getMessage: FeishuMessageGetter
  limits: FeishuMessageResolverLimits
}): Promise<{ content: string; fetched: boolean; nodeCount: number; truncated: boolean; detailUnavailable: boolean }> {
  let detail: unknown
  let detailUnavailable = false
  try {
    // Feishu can return 500 when card_msg_content_type is combined with a
    // merge-forward parent, hence the false-first enumeration.
    detail = await input.getMessage(input.rootMessageId, { userCardContent: false })
  } catch {
    try { detail = await input.getMessage(input.rootMessageId, { userCardContent: true }) } catch { detailUnavailable = true }
  }
  const items = allMessages(detail)
  if (!items.length) {
    return { content: input.fallbackContent, fetched: false, nodeCount: 0, truncated: false, detailUnavailable: true }
  }

  const byParent = new Map<string, JsonRecord[]>()
  for (const item of items) {
    const parent = asString(item.upper_message_id || item.upperMessageId)
    if (!parent) continue
    const list = byParent.get(parent) ?? []
    list.push(item)
    byParent.set(parent, list)
  }
  const rootChildren = byParent.get(input.rootMessageId) ?? items.filter((item) => messageId(item) !== input.rootMessageId && !asString(item.upper_message_id || item.upperMessageId))
  const flattened: JsonRecord[] = []
  let truncated = false

  const completeNode = async (item: JsonRecord): Promise<JsonRecord> => {
    if (messageType(item) !== 'interactive' || !looksLikeUpgradeShell(messageContent(item))) return item
    const childId = messageId(item)
    if (!childId) return item
    const resolved = await resolveInteractive(childId, messageContent(item), input.getMessage, input.limits.maxTextCharacters)
    if (!resolved.fetched) {
      // Cross-tenant submessages may be intentionally inaccessible. Do not
      // silently turn this into an empty prompt.
      return cloneWith(item, { body: { content: JSON.stringify({ [FEISHU_RESOLVED_CARD_TEXT_KEY]: '[卡片无法完整获取：可能来自外部租户或无权限]' }) } })
    }
    return cloneWith(item, { body: { content: resolved.content } })
  }

  const walk = async (nodes: JsonRecord[], depth: number): Promise<void> => {
    for (const node of nodes) {
      if (flattened.length >= input.limits.maxForwardNodes) { truncated = true; return }
      const resolved = await completeNode(node)
      if (messageType(resolved) === 'merge_forward') {
        if (depth >= input.limits.maxForwardDepth) {
          flattened.push(cloneWith(resolved, { msg_type: 'text', body: { content: JSON.stringify({ text: '[嵌套合并转发已达到展开深度上限]' }) } }))
          truncated = true
          continue
        }
        const children = byParent.get(messageId(resolved)) ?? []
        if (children.length) { await walk(children, depth + 1); continue }
      }
      // Feishu's resource endpoint normally expects the outer merge-forward
      // message id. Make that invariant explicit for downstream downloads.
      flattened.push(cloneWith(resolved, { message_id: input.rootMessageId }))
    }
  }
  await walk(rootChildren, 0)
  return {
    content: JSON.stringify({ items: flattened }),
    fetched: true,
    nodeCount: flattened.length,
    truncated,
    detailUnavailable,
  }
}

async function resolveQuote(input: ParseFeishuMessageInput, getMessage: FeishuMessageGetter, limits: FeishuMessageResolverLimits): Promise<FeishuResolvedQuote | undefined> {
  const quotedId = getFeishuQuotedMessageId(input)
  if (!quotedId) return undefined
  try {
    const detail = await getMessage(quotedId, { userCardContent: false })
    const message = firstMessage(detail)
    if (!message) return { messageId: quotedId, status: 'unavailable', reason: '飞书未返回被引用消息' }
    const type = messageType(message) || undefined
    let content = clipped(messageContent(message), limits.maxTextCharacters)
    if (type === 'interactive') {
      content = (await resolveInteractive(quotedId, content, getMessage, limits.maxTextCharacters)).content
    } else if (type === 'merge_forward') {
      content = (await resolveMergeForward({
        rootMessageId: quotedId,
        fallbackContent: content,
        getMessage,
        limits: { ...limits, resolveQuote: false },
      })).content
    }
    const text = type ? parseFeishuMessage({ messageType: type, content, messageId: quotedId }).text : undefined
    return {
      messageId: quotedId,
      status: 'resolved',
      ...senderIdentity(message),
      ...(type ? { messageType: type } : {}),
      ...(content ? { content } : {}),
      ...(text ? { text } : {}),
    }
  } catch {
    return { messageId: quotedId, status: 'unavailable', reason: '无法读取被引用消息（可能已删除、跨租户或无权限）' }
  }
}

/**
 * Complete a websocket event into a `ParseFeishuMessageInput` compatible
 * value. It is deliberately bounded: quoted content never recursively resolves
 * another quote, and merge-forward/card expansion obeys the same node/text caps.
 */
export async function resolveFeishuMessage(input: ParseFeishuMessageInput, dependencies: {
  getMessage: FeishuMessageGetter
  limits?: Partial<FeishuMessageResolverLimits>
}): Promise<ResolvedFeishuMessage> {
  const limits = { ...DEFAULT_FEISHU_MESSAGE_RESOLVER_LIMITS, ...dependencies.limits }
  const initialType = asString(input.messageType) || 'text'
  const initialContent = stringify(input.content)
  const id = asString(input.messageId)
  let resolvedType = initialType
  let resolvedContent = initialContent
  let resolvedMentions = input.mentions
  let fetched = false
  let interactiveViews: { simplified: boolean; userCardContent: boolean } | undefined
  let mergeForward: ResolvedFeishuMessage['resolution']['mergeForward']

  if (id && initialType === 'nonsupport') {
    try {
      const message = firstMessage(await dependencies.getMessage(id, { userCardContent: true }))
      const realType = messageType(message)
      const realContent = messageContent(message)
      if (realType && realContent) {
        resolvedType = realType
        resolvedContent = realContent
        resolvedMentions = message?.mentions ?? resolvedMentions
        fetched = true
      }
    } catch { /* keep a visible nonsupport fallback */ }
  }

  if (id && resolvedType === 'interactive') {
    const card = await resolveInteractive(id, resolvedContent, dependencies.getMessage, limits.maxTextCharacters)
    resolvedContent = card.content
    fetched ||= card.fetched
    interactiveViews = card.views
  }

  if (id && resolvedType === 'merge_forward') {
    const forward = await resolveMergeForward({ rootMessageId: id, fallbackContent: resolvedContent, getMessage: dependencies.getMessage, limits })
    resolvedContent = forward.content
    fetched ||= forward.fetched
    mergeForward = { nodeCount: forward.nodeCount, truncated: forward.truncated, ...(forward.detailUnavailable ? { detailUnavailable: true } : {}) }
  }

  const quote = limits.resolveQuote ? await resolveQuote(input, dependencies.getMessage, limits) : undefined
  return {
    ...input,
    messageType: resolvedType,
    content: clipped(resolvedContent, limits.maxTextCharacters),
    ...(resolvedMentions !== undefined ? { mentions: resolvedMentions } : {}),
    ...(quote ? { quote } : {}),
    resolution: { fetched, ...(interactiveViews ? { interactiveViews } : {}), ...(mergeForward ? { mergeForward } : {}) },
  }
}
