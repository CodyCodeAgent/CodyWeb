import { createHash } from 'node:crypto'

export type FeishuAutoRouteDraft = {
  sourceSenderId: string
  sourceSenderType: 'app' | 'bot'
  messageType: 'interactive'
  cardTitle: string
  requiredKeywords: string[]
  instruction: string
  fingerprintKey: string
  preview: string
}

export type FeishuAutoRouteMatcher = Pick<FeishuAutoRouteDraft,
  'sourceSenderId' | 'sourceSenderType' | 'messageType' | 'cardTitle' | 'requiredKeywords' | 'fingerprintKey'
>

const DEFAULT_ROUTE_INSTRUCTION = '请分析这张卡片中的异常或变化，给出明确结论、可能原因和下一步处理建议。'
export const ANY_BOT_SOURCE_ID = '*'

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function normalize(value: string): string {
  return compact(value).toLocaleLowerCase()
}

export function extractFeishuCardTitle(text: string): string {
  const tagged = text.match(/^\s*\[卡片:\s*([^\]]+)\]/mu)?.[1]
  if (tagged) return compact(tagged)
  const first = text.split(/\r?\n/u).map(compact).find((line) => line && line !== '[卡片]') ?? ''
  return first.replace(/^\[卡片[:：]?\s*/u, '').replace(/\]$/u, '').trim()
}

function stableFieldLabels(text: string): string[] {
  const labels: string[] = []
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = compact(rawLine).replace(/^[-*•]\s*/u, '')
    if (/^\[卡片(?:[:：]|\])/u.test(line)) continue
    const match = line.match(/^([^：:\n]{2,24})[：:]/u)
    const label = match?.[1]?.trim() ?? ''
    if (!label || /^https?$/iu.test(label) || /\d{4,}/u.test(label)) continue
    labels.push(label)
  }
  return [...new Set(labels)].slice(0, 8)
}

export function feishuAutoRouteFingerprint(input: Omit<FeishuAutoRouteMatcher, 'fingerprintKey'>): string {
  const value = JSON.stringify([
    input.sourceSenderType,
    input.sourceSenderId.trim(),
    input.messageType,
    normalize(input.cardTitle),
    input.requiredKeywords.map(normalize).filter(Boolean).sort(),
  ])
  return createHash('sha256').update(value).digest('hex')
}

export function createFeishuAutoRouteDraft(input: {
  sourceSenderId: string
  sourceSenderType: string
  messageType?: string
  text: string
  instruction?: string
}): FeishuAutoRouteDraft | null {
  const directBotSource = input.sourceSenderType === 'app' || input.sourceSenderType === 'bot'
  // A card forwarded by a human no longer carries the original bot identity in
  // Feishu's quoted-message payload. Keep the rule scoped to the current group
  // (enforced by the store query) and match any foreign bot there by the exact
  // card title/schema. Direct bot cards still retain strict source matching.
  const sourceSenderType: 'app' | 'bot' = input.sourceSenderType === 'bot' ? 'bot' : 'app'
  const sourceSenderId = directBotSource ? input.sourceSenderId.trim() : ANY_BOT_SOURCE_ID
  if (!sourceSenderId || input.messageType !== 'interactive') return null
  const cardTitle = extractFeishuCardTitle(input.text)
  if (!cardTitle) return null
  const requiredKeywords = stableFieldLabels(input.text)
  const instruction = compact(input.instruction ?? '') || DEFAULT_ROUTE_INSTRUCTION
  const matcher = {
    sourceSenderId,
    sourceSenderType,
    messageType: 'interactive' as const,
    cardTitle,
    requiredKeywords,
  }
  return {
    ...matcher,
    instruction,
    fingerprintKey: feishuAutoRouteFingerprint(matcher),
    preview: input.text.trim().slice(0, 2_000),
  }
}

export function matchesFeishuAutoRoute(route: FeishuAutoRouteMatcher, input: {
  sourceSenderId: string
  sourceSenderType: string
  messageType: string
  text: string
}): boolean {
  const wildcardBotSource = route.sourceSenderId === ANY_BOT_SOURCE_ID
  if (wildcardBotSource) {
    if (input.sourceSenderType !== 'app' && input.sourceSenderType !== 'bot') return false
  } else {
    if (route.sourceSenderType !== input.sourceSenderType) return false
    if (!route.sourceSenderId || route.sourceSenderId !== input.sourceSenderId) return false
  }
  if (route.messageType !== input.messageType) return false
  const title = normalize(extractFeishuCardTitle(input.text))
  if (!title || title !== normalize(route.cardTitle)) return false
  const body = normalize(input.text)
  return route.requiredKeywords.every((keyword) => body.includes(normalize(keyword)))
}

export function buildFeishuAutoRoutePrompt(input: {
  routeName: string
  instruction: string
  cardText: string
}): string {
  return [
    `飞书群自动路由“${input.routeName}”命中了一张卡片。`,
    `固定处理指令：${input.instruction}`,
    '请直接处理卡片内容；如信息不足，请明确指出缺少什么。',
    '',
    '卡片内容：',
    input.cardText.trim(),
  ].join('\n')
}
