/**
 * Feishu inbound message parser.
 *
 * The websocket event only gives us a message type plus a JSON encoded content
 * string.  This module deliberately has no SDK/network dependency so it can be
 * reused by the live bot, history imports and merge-forward expansion.
 */

export type FeishuResourceType = 'image' | 'file' | 'audio' | 'media' | 'sticker'

export type FeishuMessageResource = {
  type: FeishuResourceType
  key: string
  name: string
  /** A nested/forwarded message may need its own id when downloading. */
  messageId?: string
  /** Known Feishu API limitation; preserved so delivery can degrade visibly. */
  downloadUnsupportedReason?: string
}

export type FeishuMention = {
  key?: string
  name?: string
  openId?: string
  userId?: string
  unionId?: string
  appId?: string
  idType?: string
}

export type FeishuRawMention = {
  key?: unknown
  name?: unknown
  id?: unknown
  id_type?: unknown
  idType?: unknown
}

export type ParseFeishuMessageInput = {
  messageType?: unknown
  content?: unknown
  mentions?: unknown
  messageId?: unknown
  parentId?: unknown
  rootId?: unknown
  threadId?: unknown
}

export type ParseFeishuMessageOptions = {
  /** When present, this bot's @mention is removed while other mentions remain. */
  botOpenId?: string
  /** Feishu may identify a bot mention by app_id instead of open_id. */
  botAppId?: string
}

export type ParsedFeishuMessage = {
  messageType: string
  text: string
  resources: FeishuMessageResource[]
  mentions: FeishuMention[]
  explicitlyMentioned: boolean
  userDslUnwrapped: boolean
  rawContent: string
  /** Present only for a user-visible quote, not normal thread-root routing. */
  quotedMessageId?: string
}

/**
 * A resolver may retain the original structured card for attachment discovery
 * while supplying text merged from the two `im.message.get` representations.
 * This is intentionally public: it is a transport-neutral wire convention,
 * not a parser implementation detail.
 */
export const FEISHU_RESOLVED_CARD_TEXT_KEY = '__cody_resolved_card_text__'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contentString(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try { return JSON.stringify(content) } catch { return String(content) }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}

/** Handles both websocket `{id:{open_id}}` and REST `{id:'ou_x',id_type:'open_id'}` shapes. */
export function normalizeFeishuMention(value: FeishuRawMention | null | undefined): FeishuMention {
  const id = value?.id
  const idType = asString(value?.id_type || value?.idType) || undefined
  const mention: FeishuMention = {
    key: asString(value?.key) || undefined,
    name: asString(value?.name) || undefined,
    idType,
  }
  const objectId = asRecord(id)
  if (objectId) {
    mention.openId = asString(objectId.open_id || objectId.openId) || undefined
    mention.userId = asString(objectId.user_id || objectId.userId) || undefined
    mention.unionId = asString(objectId.union_id || objectId.unionId) || undefined
    mention.appId = asString(objectId.app_id || objectId.appId) || undefined
  } else if (typeof id === 'string' && id) {
    if (!idType || idType === 'open_id') mention.openId = id
    else if (idType === 'user_id') mention.userId = id
    else if (idType === 'union_id') mention.unionId = id
    else if (idType === 'app_id') mention.appId = id
  }
  return mention
}

function normalizeMentions(value: unknown): FeishuMention[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => normalizeFeishuMention(asRecord(item) as FeishuRawMention | null))
}

/** Lark sometimes nests the real v2 card JSON in a JSON encoded `user_dsl` field. */
export function unwrapFeishuUserDsl(rawContent: string): string | null {
  const outer = asRecord(parseJson(rawContent))
  if (!outer || typeof outer.user_dsl !== 'string') return null
  const inner = asRecord(parseJson(outer.user_dsl))
  if (!inner || (!inner.body && !inner.elements && !inner.header)) return null
  return JSON.stringify(inner)
}

class ResourceCollector {
  readonly resources: FeishuMessageResource[] = []
  private readonly seen = new Set<string>()
  private readonly counters: Record<FeishuResourceType, number> = {
    image: 0, file: 0, audio: 0, media: 0, sticker: 0,
  }

  add(resource: FeishuMessageResource): number {
    const identity = `${resource.type}:${resource.key}`
    if (!this.seen.has(identity)) {
      this.seen.add(identity)
      this.counters[resource.type] += 1
      this.resources.push(resource)
    }
    const sameType = this.resources.filter((item) => item.type === resource.type)
    return sameType.findIndex((item) => item.key === resource.key) + 1
  }

  label(type: FeishuResourceType, key: string, name?: string): string {
    const labels: Record<FeishuResourceType, string> = {
      image: '图片', file: '文件', audio: '音频', media: '视频', sticker: '表情',
    }
    const number = this.add({ type, key, name: name || defaultResourceName(type, key) })
    return name ? `[${labels[type]} ${number}: ${name}]` : `[${labels[type]} ${number}]`
  }
}

function defaultResourceName(type: FeishuResourceType, key: string): string {
  if (type === 'image') return `${key}.jpg`
  if (type === 'audio') return `${key}.opus`
  if (type === 'media') return `${key}.mp4`
  return key
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * Feishu also uses parent_id as thread plumbing. Only surface it when it points
 * at a real quoted message rather than the current message or thread root.
 */
export function getFeishuQuotedMessageId(input: Pick<ParseFeishuMessageInput, 'messageId' | 'parentId' | 'rootId' | 'threadId'>): string | undefined {
  const parentId = asString(input.parentId)
  if (!parentId) return undefined
  const messageId = asString(input.messageId)
  const threadId = asString(input.threadId)
  const rootId = asString(input.rootId)
  if (parentId === messageId) return undefined
  // In a topic/thread Feishu repeats the thread root as parent_id plumbing.
  // In an ordinary group, however, replying to a message legitimately sends
  // parent_id === root_id with no thread_id. That is a real visible quote and
  // must be preserved (notably for quoted-card auto-route setup).
  if (threadId && (parentId === rootId || parentId === threadId)) return undefined
  return parentId
}

export function buildFeishuQuoteHint(quotedMessageId: string | undefined): string {
  return quotedMessageId ? `[用户引用了飞书消息 ${quotedMessageId}]\n` : ''
}

function removeBotMention(text: string, mentions: FeishuMention[], botOpenId?: string, botAppId?: string): string {
  let result = text
  for (const mention of mentions) {
    const isBot = (Boolean(botOpenId) && mention.openId === botOpenId)
      || (Boolean(botAppId) && mention.appId === botAppId)
    if (mention.key) result = result.split(mention.key).join(isBot ? ' ' : `@${mention.name || '用户'}`)
    if (isBot && mention.name) {
      const escaped = mention.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(`@${escaped}`, 'gu'), ' ')
    }
  }
  // Unresolved placeholders are transport noise, not meaningful prompt text.
  return cleanText(result.replace(/@_user_\d+/gu, ' '))
}

function resolvePostBody(parsed: unknown): { title: string; content: unknown[] } {
  const record = asRecord(parsed)
  if (!record) return { title: '', content: [] }
  if (Array.isArray(record.content)) return { title: asString(record.title), content: record.content }
  for (const value of Object.values(record)) {
    const locale = asRecord(value)
    if (locale && Array.isArray(locale.content)) {
      return { title: asString(locale.title), content: locale.content }
    }
  }
  return { title: '', content: [] }
}

function stringField(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return asString(record?.content || record?.text)
}

function openUrl(record: JsonRecord): string {
  const direct = [record.url, asRecord(record.multi_url)?.url, asRecord(record.multi_url)?.pc_url,
    asRecord(record.multi_url)?.android_url, asRecord(record.multi_url)?.ios_url]
    .map(asString).find(Boolean)
  if (direct) return direct
  if (Array.isArray(record.behaviors)) {
    for (const behavior of record.behaviors) {
      const row = asRecord(behavior)
      if (!row || row.type !== 'open_url') continue
      const url = [row.default_url, row.pc_url, row.url, row.android_url, row.ios_url].map(asString).find(Boolean)
      if (url) return url
    }
  }
  return ''
}

function postNodeText(nodeValue: unknown, collector: ResourceCollector, botOpenId?: string): string {
  const node = asRecord(nodeValue)
  if (!node) return ''
  const tag = asString(node.tag)
  if (tag === 'text') return asString(node.text)
  if (tag === 'a') return asString(node.text) || asString(node.href)
  if (tag === 'at') return botOpenId && asString(node.user_id) === botOpenId ? '' : `@${asString(node.user_name) || '用户'}`
  if (tag === 'code_block') {
    const code = asString(node.text || node.content || node.code).replace(/\n+$/u, '')
    const language = asString(node.language || node.lang).trim().replace(/\s+/gu, '_')
    const longest = Math.max(2, ...[...code.matchAll(/`+/gu)].map((match) => match[0].length))
    const fence = '`'.repeat(longest + 1)
    return `\n${fence}${language}\n${code}\n${fence}\n`
  }
  if (tag === 'img' || tag === 'image') {
    const key = asString(node.image_key || node.img_key)
    return key ? collector.label('image', key) : '[图片]'
  }
  if (tag === 'media') {
    const fileKey = asString(node.file_key)
    const imageKey = asString(node.image_key)
    const labels = [
      fileKey ? collector.label('media', fileKey, asString(node.file_name) || undefined) : '[视频]',
      imageKey ? collector.label('image', imageKey) : '',
    ]
    return labels.filter(Boolean).join(' ')
  }
  if (tag === 'file') {
    const key = asString(node.file_key)
    return key ? collector.label('file', key, asString(node.file_name) || undefined) : '[文件]'
  }
  return ''
}

function parsePost(parsed: unknown, collector: ResourceCollector, botOpenId?: string): string {
  const { title, content } = resolvePostBody(parsed)
  const paragraphs = content.map((value) => {
    const nodes = Array.isArray(value) ? value : [value]
    return nodes.map((node) => postNodeText(node, collector, botOpenId)).join('')
  }).map(cleanText).filter(Boolean)
  return cleanText([title, ...paragraphs].filter(Boolean).join('\n'))
}

function collectCardResources(value: unknown, collector: ResourceCollector, visited = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || visited.has(value)) return
  visited.add(value)
  if (Array.isArray(value)) {
    for (const child of value) collectCardResources(child, collector, visited)
    return
  }
  const record = value as JsonRecord
  const tag = asString(record.tag)
  const imageKey = asString(record.image_key || record.img_key)
  const fileKey = asString(record.file_key)
  if ((tag === 'img' || tag === 'image') && imageKey) collector.add({ type: 'image', key: imageKey, name: `${imageKey}.jpg` })
  if (tag === 'file' && fileKey) collector.add({ type: 'file', key: fileKey, name: asString(record.file_name) || fileKey })
  if (tag === 'media' && fileKey) collector.add({ type: 'media', key: fileKey, name: asString(record.file_name) || `${fileKey}.mp4` })
  for (const child of Object.values(record)) collectCardResources(child, collector, visited)
}

function cardNodeText(value: unknown, collector: ResourceCollector, botOpenId?: string, visited = new Set<unknown>()): string[] {
  if (!value || typeof value !== 'object' || visited.has(value)) return []
  visited.add(value)
  if (Array.isArray(value)) return value.flatMap((child) => cardNodeText(child, collector, botOpenId, visited))
  const record = value as JsonRecord
  const tag = asString(record.tag)
  const output: string[] = []

  if (tag === 'text') output.push(asString(record.text))
  else if (tag === 'a') {
    const label = asString(record.text) || asString(record.href)
    const href = asString(record.href)
    output.push(label && href && label !== href ? `${label}(${href})` : label)
  } else if (tag === 'at') {
    if (!botOpenId || asString(record.user_id) !== botOpenId) output.push(`@${asString(record.user_name) || '用户'}`)
  } else if (tag === 'markdown' || tag === 'plain_text' || tag === 'div') {
    output.push(stringField(record.text) || asString(record.content))
  } else if (tag === 'button') {
    const label = stringField(record.text)
    const url = openUrl(record)
    if (label) output.push(url ? `[${label}](${url})` : `[${label}]`)
  } else if (tag === 'input') {
    const placeholder = stringField(record.placeholder)
    if (placeholder) output.push(`[输入框: ${placeholder}]`)
  } else if (tag === 'select_static' || tag === 'multi_select_static' || tag === 'overflow') {
    const placeholder = stringField(record.placeholder)
    const options = Array.isArray(record.options)
      ? record.options.map((option) => stringField(asRecord(option)?.text)).filter(Boolean)
      : []
    output.push(`[下拉${placeholder ? `: ${placeholder}` : ''}${options.length ? ` | 选项: ${options.join(' / ')}` : ''}]`)
  } else if (tag === 'img' || tag === 'image') {
    const key = asString(record.image_key || record.img_key)
    const alt = stringField(record.alt)
    if (key) {
      const label = collector.label('image', key)
      output.push(alt ? `${label.slice(0, -1)}: ${alt}]` : label)
    }
  } else if (tag === 'file') {
    const key = asString(record.file_key)
    if (key) output.push(collector.label('file', key, asString(record.file_name) || undefined))
  } else if (tag === 'media') {
    const key = asString(record.file_key)
    if (key) output.push(collector.label('media', key, asString(record.file_name) || undefined))
  }

  // Text-bearing field cells do not always have tags.
  if (!tag && (record.content || record.text)) {
    const text = stringField(record.text) || asString(record.content)
    if (text) output.push(text)
  }

  const containerKeys = ['fields', 'extra', 'columns', 'elements', 'actions', 'items', 'rows', 'cells']
  for (const key of containerKeys) {
    const child = record[key]
    if (child) output.push(...cardNodeText(child, collector, botOpenId, visited))
  }
  return output
}

/** Traverses both server-simplified cards and original/v2 interactive-card JSON. */
export function extractFeishuCardText(rawContent: string, collector = new ResourceCollector(), botOpenId?: string): string {
  const unwrapped = unwrapFeishuUserDsl(rawContent) ?? rawContent
  const card = asRecord(parseJson(unwrapped))
  if (!card) return '[卡片]'
  // Keep collecting resources from the original structured payload below. A
  // REST resolver can place a faithful union of the two Lark renderings here,
  // avoiding information loss when one representation omits field values.
  const resolvedText = asString(card[FEISHU_RESOLVED_CARD_TEXT_KEY])
  if (resolvedText) {
    collectCardResources(card, collector)
    return cleanText(resolvedText)
  }
  if (card.type === 'template') return '[卡片 (模板)]'
  collectCardResources(card, collector)
  const title = asString(card.title) || stringField(asRecord(card.header)?.title)
  const root = asRecord(card.body)?.elements ?? card.elements
  const bodyParts = Array.isArray(root) && root.length > 0 && Array.isArray(root[0])
    ? root.map((paragraph) => cardNodeText(paragraph, collector, botOpenId).join('')).filter(Boolean)
    : cardNodeText(root, collector, botOpenId)
  const parts = [title ? `[卡片: ${title}]` : '', ...bodyParts]
  return cleanText(parts.filter(Boolean).join('\n')) || '[卡片]'
}

function parseMergeForward(parsed: unknown, collector: ResourceCollector, botOpenId?: string): string {
  const record = asRecord(parsed)
  const messages = Array.isArray(record?.messages) ? record.messages : Array.isArray(record?.items) ? record.items : []
  if (messages.length === 0) return '[合并转发消息]'
  const lines = messages.map((item) => {
    const row = asRecord(item)
    if (!row) return ''
    const body = asRecord(row.body)
    const nested = parseFeishuMessage({
      messageType: row.msg_type || row.message_type,
      content: body?.content ?? row.content,
      mentions: row.mentions,
      messageId: row.message_id,
    }, { botOpenId })
    for (const resource of nested.resources) collector.add({ ...resource, messageId: resource.messageId || asString(row.message_id) || undefined })
    const sender = asString(asRecord(row.sender)?.sender_name || row.sender_name)
    return `${sender ? `${sender}: ` : ''}${nested.text}`
  }).filter(Boolean)
  return cleanText(['[合并转发消息]', ...lines].join('\n'))
}

/** Convert any supported Feishu inbound content into a prompt and downloadable resources. */
export function parseFeishuMessage(input: ParseFeishuMessageInput, options: ParseFeishuMessageOptions = {}): ParsedFeishuMessage {
  const messageType = asString(input.messageType) || 'text'
  const rawContent = contentString(input.content)
  const unwrapped = messageType === 'interactive' ? unwrapFeishuUserDsl(rawContent) : null
  const effectiveContent = unwrapped ?? rawContent
  const parsed = parseJson(effectiveContent)
  const record = asRecord(parsed)
  const mentions = normalizeMentions(input.mentions)
  const collector = new ResourceCollector()
  const quotedMessageId = getFeishuQuotedMessageId(input)
  let text = ''

  if (messageType === 'text') text = asString(record?.text) || (typeof parsed === 'string' ? parsed : rawContent)
  else if (messageType === 'post' || messageType === 'rich_text') text = parsePost(parsed, collector, options.botOpenId)
  else if (messageType === 'image') {
    const key = asString(record?.image_key)
    text = key ? collector.label('image', key) : '[图片]'
  } else if (messageType === 'file') {
    const key = asString(record?.file_key)
    text = key ? collector.label('file', key, asString(record?.file_name) || undefined) : '[文件]'
  } else if (messageType === 'audio') {
    const key = asString(record?.file_key)
    text = key ? collector.label('audio', key, asString(record?.file_name) || undefined) : '[音频]'
  } else if (messageType === 'media') {
    const fileKey = asString(record?.file_key)
    const imageKey = asString(record?.image_key)
    text = [fileKey ? collector.label('media', fileKey, asString(record?.file_name) || undefined) : '[视频]',
      imageKey ? collector.label('image', imageKey) : ''].filter(Boolean).join(' ')
  } else if (messageType === 'sticker') {
    const key = asString(record?.file_key || record?.image_key || record?.sticker_id)
    text = key ? collector.label('sticker', key) : '[表情]'
  } else if (messageType === 'interactive') text = extractFeishuCardText(effectiveContent, collector, options.botOpenId)
  else if (messageType === 'merge_forward') text = parseMergeForward(parsed, collector, options.botOpenId)
  else if (messageType === 'share_chat') {
    const chatId = asString(record?.chat_id)
    const chatName = asString(record?.name || record?.chat_name)
    text = chatName ? `[群聊分享: ${chatName}${chatId ? ` (${chatId})` : ''}]` : chatId ? `[群聊分享: ${chatId}]` : '[群聊分享]'
  } else text = asString(record?.text || record?.content) || rawContent || `[不支持的消息类型: ${messageType}]`

  const botMentionIds = [options.botOpenId, options.botAppId].filter((value): value is string => Boolean(value))
  const explicitlyMentioned = botMentionIds.length > 0 && (
    mentions.some((mention) => mention.openId === options.botOpenId || mention.appId === options.botAppId)
    || containsPostMention(parsed, new Set(botMentionIds))
  )
  text = removeBotMention(text, mentions, options.botOpenId, options.botAppId)
  if (text && quotedMessageId) text = `${buildFeishuQuoteHint(quotedMessageId)}${text}`

  return {
    messageType,
    text,
    resources: collector.resources,
    mentions,
    explicitlyMentioned,
    userDslUnwrapped: unwrapped !== null,
    rawContent,
    ...(quotedMessageId ? { quotedMessageId } : {}),
  }
}

function containsPostMention(value: unknown, botIds: ReadonlySet<string>, visited = new Set<unknown>()): boolean {
  if (!value || typeof value !== 'object' || visited.has(value)) return false
  visited.add(value)
  if (Array.isArray(value)) return value.some((child) => containsPostMention(child, botIds, visited))
  const record = value as JsonRecord
  if (record.tag === 'at' && botIds.has(asString(record.user_id || record.app_id))) return true
  return Object.values(record).some((child) => containsPostMention(child, botIds, visited))
}
