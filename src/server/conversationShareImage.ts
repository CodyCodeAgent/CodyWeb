import type { Response } from 'express'
import type { ConversationShareRecord } from './conversationShareStore.js'
import { conversationShareTheme, mixHex } from './conversationSharePresentation.js'

type ShareLocale = 'en' | 'zh-CN'

const WIDTH = 1_200
const MARGIN = 68
const CONTENT_WIDTH = WIDTH - MARGIN * 2
const MAX_HEIGHT = 14_000
const BODY_FONT_SIZE = 27
const BODY_LINE_HEIGHT = 44

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character)
}

function localeOf(share: ConversationShareRecord): ShareLocale {
  return share.snapshot.locale === 'en' ? 'en' : 'zh-CN'
}

function formatDate(value: string | null, locale: ShareLocale): string {
  if (!value) return locale === 'zh-CN' ? '永久有效' : 'Never expires'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return locale === 'zh-CN' ? '有效期未知' : 'Expiry unavailable'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(time))
}

function plainMarkdown(value: string, locale: ShareLocale): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_match, alt: string) => alt || (locale === 'zh-CN' ? '[图片]' : '[Image]'))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s*>\s?/gmu, '│ ')
    .replace(/\r\n?/gu, '\n')
    .trim()
}

function visualUnits(character: string): number {
  if (/\s/u.test(character)) return 0.42
  return /[\u0000-\u00ff]/u.test(character) ? 0.56 : 1
}

function wrapLine(value: string, maxUnits: number): string[] {
  if (!value) return ['']
  const lines: string[] = []
  let current = ''
  let units = 0
  for (const character of value) {
    const nextUnits = visualUnits(character)
    if (current && units + nextUnits > maxUnits) {
      if (/[，。！？；：、,.!?;:）)\]】}]/u.test(character)) {
        lines.push(`${current.trimEnd()}${character}`)
        current = ''
        units = 0
        continue
      }
      lines.push(current.trimEnd())
      current = character.trimStart()
      units = current ? nextUnits : 0
    } else {
      current += character
      units += nextUnits
    }
  }
  if (current || lines.length === 0) lines.push(current.trimEnd())
  return lines
}

function wrapText(value: string, maxUnits: number): string[] {
  const result: string[] = []
  for (const paragraph of value.split('\n')) {
    if (!paragraph.trim()) {
      if (result.at(-1) !== '') result.push('')
      continue
    }
    result.push(...wrapLine(paragraph, maxUnits))
  }
  while (result.at(-1) === '') result.pop()
  return result
}

function textLines(lines: string[], input: {
  x: number
  y: number
  size: number
  lineHeight: number
  fill: string
  weight?: number
  anchor?: 'start' | 'end' | 'middle'
}): string {
  const anchor = input.anchor ?? 'start'
  return `<text x="${String(input.x)}" y="${String(input.y)}" fill="${input.fill}" font-size="${String(input.size)}" font-weight="${String(input.weight ?? 400)}" text-anchor="${anchor}">${lines.map((line, index) => `<tspan x="${String(input.x)}" dy="${index === 0 ? '0' : String(input.lineHeight)}">${escapeXml(line || ' ')}</tspan>`).join('')}</text>`
}

function avatarNode(source: string | undefined, fallback: string, x: number, y: number, size: number, index: number, colors: { surface: string; border: string; accent: string; textMuted: string }): string {
  const clipId = `avatar-${String(index)}`
  const frame = `<rect x="${String(x)}" y="${String(y)}" width="${String(size)}" height="${String(size)}" rx="14" fill="${colors.surface}" stroke="${mixHex(colors.accent, colors.border, .42)}"/>`
  if (!source) return `${frame}${textLines([fallback], { x: x + size / 2, y: y + size * .68, size: 20, lineHeight: 20, fill: colors.textMuted, weight: 800, anchor: 'middle' })}`
  return `<defs><clipPath id="${clipId}"><rect x="${String(x + 2)}" y="${String(y + 2)}" width="${String(size - 4)}" height="${String(size - 4)}" rx="12"/></clipPath></defs>${frame}<image href="${source}" x="${String(x + 2)}" y="${String(y + 2)}" width="${String(size - 4)}" height="${String(size - 4)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
}

export function renderConversationShareImage(share: ConversationShareRecord): string {
  const locale = localeOf(share)
  const theme = conversationShareTheme(share.snapshot)
  const colors = theme.colors
  const copy = locale === 'zh-CN' ? {
    brand: 'CODYWEB / 分享的对话', readonly: '只读快照', user: '你', assistant: 'CODY', process: '过程',
    messages: '条消息', imagesOmitted: '张过大图片未包含', truncated: '内容较长，长图仅展示前半部分。请打开分享链接查看完整对话。',
    footer: '由 CodyWeb 生成 · 公开快照无法访问原 Session', expires: '有效至', skin: '皮肤',
  } : {
    brand: 'CODYWEB / SHARED CONVERSATION', readonly: 'READ-ONLY SNAPSHOT', user: 'YOU', assistant: 'CODY', process: 'PROCESS',
    messages: 'messages', imagesOmitted: 'oversized image(s) omitted', truncated: 'This conversation is long. Open the shared link to read the complete conversation.',
    footer: 'Generated by CodyWeb · This snapshot cannot access the source session', expires: 'Expires', skin: 'Skin',
  }
  const nodes: string[] = []
  const defs: string[] = []
  if (theme.assets.background) {
    defs.push(`<filter id="background-blur"><feGaussianBlur stdDeviation="${String((theme.background?.blur ?? 0) / 2)}"/></filter>`)
    nodes.push(`<image href="${theme.assets.background}" x="-40" y="-40" width="${String(WIDTH + 80)}" height="100%" preserveAspectRatio="xMidYMid slice" filter="url(#background-blur)"/>`)
    nodes.push(`<rect width="100%" height="100%" fill="${colors.background}" fill-opacity="${String((theme.background?.dim ?? 30) / 100)}"/>`)
  } else {
    nodes.push(`<rect width="100%" height="100%" fill="${colors.background}"/>`)
  }
  if (theme.recipes.backdrop === 'grid' || theme.recipes.backdrop === 'aero-grid') {
    defs.push(`<pattern id="share-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="${colors.accent}" stroke-opacity=".08" stroke-width="1"/></pattern>`)
    nodes.push('<rect width="100%" height="100%" fill="url(#share-grid)"/>')
  }

  let y = MARGIN
  const titleLines = wrapText(share.title, 34)
  const headerHeight = 160 + titleLines.length * 54
  const panelFill = theme.recipes.panel === 'glass' ? mixHex(colors.panel, colors.background, .78) : colors.panel
  nodes.push(`<rect x="${String(MARGIN)}" y="${String(y)}" width="${String(CONTENT_WIDTH)}" height="${String(headerHeight)}" rx="28" fill="${panelFill}" stroke="${colors.border}"/>`)
  nodes.push(textLines([copy.brand], { x: MARGIN + 34, y: y + 42, size: 17, lineHeight: 24, fill: colors.textMuted, weight: 700 }))
  nodes.push(`<rect x="${String(WIDTH - MARGIN - 210)}" y="${String(y + 22)}" width="176" height="42" rx="21" fill="${mixHex(colors.accent, colors.panel, .13)}"/>`)
  nodes.push(textLines([copy.readonly], { x: WIDTH - MARGIN - 188, y: y + 50, size: 16, lineHeight: 22, fill: colors.accent, weight: 700 }))
  nodes.push(textLines(titleLines, { x: MARGIN + 34, y: y + 104, size: 42, lineHeight: 54, fill: colors.text, weight: 750 }))
  const expiry = share.expiresAtIso ? `${copy.expires} ${formatDate(share.expiresAtIso, locale)}` : formatDate(null, locale)
  nodes.push(textLines([`${String(share.messageCount)} ${copy.messages} · ${copy.skin} ${theme.skinName} · ${expiry}`], { x: MARGIN + 34, y: y + headerHeight - 28, size: 18, lineHeight: 26, fill: colors.textMuted }))
  y += headerHeight + 34

  let truncated = false
  let messageIndex = 0
  for (const message of share.snapshot.messages) {
    messageIndex += 1
    const isUser = message.role === 'user'
    const role = isUser ? copy.user : message.role === 'assistant' ? copy.assistant : copy.process
    const chunks = [plainMarkdown(message.text, locale)]
    if (message.tool) chunks.push([message.tool.title, message.tool.summary, ...message.tool.details, message.tool.output].filter(Boolean).join('\n'))
    const omittedImages = Math.max(0, message.imageCount - (message.images?.length ?? 0))
    if (omittedImages > 0) chunks.push(`${String(omittedImages)} ${copy.imagesOmitted}`)
    const lines = wrapText(chunks.filter(Boolean).join('\n'), 35)
    const imageSources = (message.images ?? []).slice(0, 4)
    const imageHeight = imageSources.length > 0 ? imageSources.length * 224 + 8 : 0
    const availableLines = Math.max(0, Math.floor((MAX_HEIGHT - y - imageHeight - 260) / BODY_LINE_HEIGHT))
    if (availableLines <= 0) {
      truncated = true
      break
    }
    const visibleLines = lines.slice(0, availableLines)
    if (visibleLines.length < lines.length || (message.images?.length ?? 0) > imageSources.length) truncated = true
    const textHeight = visibleLines.length > 0 ? visibleLines.length * BODY_LINE_HEIGHT + 34 : 0
    const bodyHeight = Math.max(74, textHeight + imageHeight + 20)
    const bubbleWidth = CONTENT_WIDTH - 132
    const bubbleX = isUser ? WIDTH - MARGIN - bubbleWidth - 62 : MARGIN + 62
    const avatarX = isUser ? WIDTH - MARGIN - 48 : MARGIN
    const labelX = isUser ? bubbleX + bubbleWidth : bubbleX
    const labelAnchor = isUser ? 'end' : 'start'

    if (theme.recipes.identity === 'avatars') {
      const source = isUser ? theme.assets.userAvatar : theme.assets.assistantAvatar
      nodes.push(avatarNode(source, isUser ? 'U' : 'C', avatarX, y + 22, 48, messageIndex, colors))
    }
    nodes.push(textLines([role], { x: labelX, y: y + 18, size: 16, lineHeight: 22, fill: colors.textMuted, weight: 700, anchor: labelAnchor }))
    const bubbleFill = isUser
      ? mixHex(colors.accent, colors.panel, .11)
      : theme.recipes.message === 'bubble' ? colors.elevated : panelFill
    if (isUser || theme.recipes.message === 'bubble') {
      nodes.push(`<rect x="${String(bubbleX)}" y="${String(y + 28)}" width="${String(bubbleWidth)}" height="${String(bodyHeight)}" rx="20" fill="${bubbleFill}" stroke="${isUser ? mixHex(colors.accent, colors.border, .34) : colors.border}"/>`)
    } else if (theme.recipes.message === 'rail') {
      nodes.push(`<rect x="${String(bubbleX)}" y="${String(y + 34)}" width="5" height="${String(Math.max(42, bodyHeight - 12))}" rx="3" fill="${colors.accent}"/>`)
    }

    let contentY = y + 68
    for (let imageIndex = 0; imageIndex < imageSources.length; imageIndex += 1) {
      const source = imageSources[imageIndex]!
      const clipId = `image-${String(messageIndex)}-${String(imageIndex)}`
      defs.push(`<clipPath id="${clipId}"><rect x="${String(bubbleX + 24)}" y="${String(contentY - 24)}" width="${String(bubbleWidth - 48)}" height="206" rx="14"/></clipPath>`)
      nodes.push(`<rect x="${String(bubbleX + 24)}" y="${String(contentY - 24)}" width="${String(bubbleWidth - 48)}" height="206" rx="14" fill="${colors.surface}" stroke="${colors.border}"/>`)
      nodes.push(`<image href="${source}" x="${String(bubbleX + 25)}" y="${String(contentY - 23)}" width="${String(bubbleWidth - 50)}" height="204" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>`)
      contentY += 224
    }
    if (visibleLines.length > 0) {
      nodes.push(textLines(visibleLines, { x: bubbleX + 28, y: contentY, size: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT, fill: colors.text }))
    }
    y += bodyHeight + 52
    if (truncated) break
  }

  if (truncated) {
    const noticeLines = wrapText(copy.truncated, 40)
    const noticeHeight = noticeLines.length * 36 + 42
    nodes.push(`<rect x="${String(MARGIN + 62)}" y="${String(y)}" width="${String(CONTENT_WIDTH - 62)}" height="${String(noticeHeight)}" rx="18" fill="${mixHex(colors.accent, colors.panel, .08)}" stroke="${mixHex(colors.accent, colors.border, .38)}"/>`)
    nodes.push(textLines(noticeLines, { x: MARGIN + 90, y: y + 38, size: 22, lineHeight: 36, fill: colors.text, weight: 650 }))
    y += noticeHeight + 30
  }
  nodes.push(textLines([copy.footer], { x: MARGIN + 4, y: y + 34, size: 17, lineHeight: 24, fill: colors.textMuted }))
  const height = Math.min(MAX_HEIGHT, Math.max(820, y + 74))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(height)}" viewBox="0 0 ${String(WIDTH)} ${String(height)}"><defs>${defs.join('')}</defs><g font-family="${escapeXml(theme.fonts.sans)}">${nodes.join('')}</g></svg>`
}

export function sendConversationShareImage(res: Response, title: string, svg: string): void {
  const fileName = `${title.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'codyweb-conversation'}.svg`
  res.status(200)
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; img-src data:; script-src 'none'; frame-ancestors 'none'; sandbox")
  res.send(svg)
}
