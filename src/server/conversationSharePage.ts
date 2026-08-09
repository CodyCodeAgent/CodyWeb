import MarkdownIt from 'markdown-it'
import type { Response } from 'express'
import type { ConversationShareLookup, ConversationShareRecord } from './conversationShareStore.js'
import { conversationShareTheme, cssVariables, FALLBACK_SHARE_THEME } from './conversationSharePresentation.js'

type ShareLocale = 'en' | 'zh-CN'

function localeOf(share: ConversationShareRecord): ShareLocale {
  return share.snapshot.locale === 'en' ? 'en' : 'zh-CN'
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet('target', '_blank')
  tokens[index]?.attrSet('rel', 'noopener noreferrer nofollow')
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}
markdown.renderer.rules.image = (_tokens, _index, _options, env: { locale?: ShareLocale }) => `<span class="shared-image-note">${env.locale === 'en' ? 'Linked image omitted from the public snapshot' : '链接图片未随公开快照发布'}</span>`

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character)
}

function formatDate(value: string | null, locale: ShareLocale): string {
  if (!value) return locale === 'zh-CN' ? '永久有效' : 'Never expires'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return locale === 'zh-CN' ? '有效期未知' : 'Expiry unavailable'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(time))
}

function renderTool(tool: NonNullable<ConversationShareRecord['snapshot']['messages'][number]['tool']>, locale: ShareLocale): string {
  const details = tool.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('')
  const output = tool.output ? `<pre><code>${escapeHtml(tool.output)}</code></pre>` : ''
  return `<details class="shared-tool"><summary><span>${escapeHtml(tool.title || (locale === 'zh-CN' ? '工具调用' : 'Tool activity'))}</span><small>${escapeHtml(tool.status)}</small></summary><p>${escapeHtml(tool.summary)}</p>${details ? `<ul>${details}</ul>` : ''}${output}</details>`
}

function avatar(role: 'user' | 'assistant' | 'system', share: ConversationShareRecord): string {
  const theme = conversationShareTheme(share.snapshot)
  const source = role === 'assistant' ? theme.assets.assistantAvatar : role === 'user' ? theme.assets.userAvatar : ''
  const fallback = role === 'assistant' ? 'C' : role === 'user' ? 'U' : '•'
  return `<span class="shared-avatar" data-role="${role}">${source ? `<img src="${source}" alt="">` : escapeHtml(fallback)}</span>`
}

function renderShareMessages(share: ConversationShareRecord, locale: ShareLocale): string {
  return share.snapshot.messages.map((message) => {
    const roleLabel = message.role === 'user'
      ? (locale === 'zh-CN' ? '你' : 'You')
      : message.role === 'assistant' ? 'Cody' : (locale === 'zh-CN' ? '过程' : 'Process')
    const body = message.text.trim() ? `<div class="shared-markdown">${markdown.render(message.text, { locale })}</div>` : ''
    const tool = message.tool ? renderTool(message.tool, locale) : ''
    const images = (message.images ?? []).map((source) => `<img src="${source}" alt="${locale === 'zh-CN' ? '对话图片' : 'Conversation image'}" loading="lazy">`).join('')
    const omittedCount = Math.max(0, message.imageCount - (message.images?.length ?? 0))
    const omitted = omittedCount > 0
      ? `<p class="shared-image-note">${locale === 'zh-CN' ? `${String(omittedCount)} 张过大图片未包含在快照中。` : `${String(omittedCount)} oversized image(s) were omitted from the snapshot.`}</p>`
      : ''
    return `<article class="shared-message" data-role="${message.role}">${avatar(message.role, share)}<div class="shared-message-content"><span class="shared-role">${escapeHtml(roleLabel)}</span><div class="shared-message-body">${images ? `<div class="shared-images">${images}</div>` : ''}${body}${tool}${omitted}</div></div></article>`
  }).join('')
}

function baseDocument(
  title: string,
  body: string,
  locale: ShareLocale,
  theme = FALLBACK_SHARE_THEME,
): string {
  return `<!doctype html>
<html lang="${locale}" data-message-recipe="${theme.recipes.message}" data-identity-recipe="${theme.recipes.identity}" data-panel-recipe="${theme.recipes.panel}" data-backdrop-recipe="${theme.recipes.backdrop}" style="${cssVariables(theme)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(title)} · CodyWeb</title>
<style>
*{box-sizing:border-box}html{font-size:16px;color-scheme:${theme.colorMode}}body{margin:0;min-height:100vh;overflow-x:hidden;background:var(--share-bg);color:var(--share-text);font-family:var(--share-font);line-height:1.65}body::before,body::after{position:fixed;pointer-events:none;content:"";inset:0}body::before{z-index:-2;inset:calc(-1 * var(--share-background-blur));background-image:var(--share-background-image);background-position:var(--share-background-position);background-size:var(--share-background-fit);filter:blur(var(--share-background-blur)) saturate(var(--share-background-saturation));transform:scale(1.03)}body::after{z-index:-1;background:color-mix(in srgb,var(--share-bg) var(--share-background-dim),transparent)}html[data-backdrop-recipe=aero-grid] body{background-image:linear-gradient(rgb(255 255 255/.035) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255/.035) 1px,transparent 1px);background-size:28px 28px}html[data-backdrop-recipe=grid] body{background-image:linear-gradient(color-mix(in srgb,var(--share-accent) 8%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--share-accent) 8%,transparent) 1px,transparent 1px);background-size:24px 24px}a{color:var(--share-accent)}.page{width:min(100% - 32px,980px);margin:0 auto;padding:40px 0 72px}.share-header,.conversation{border:1px solid var(--share-border);border-radius:var(--share-radius-lg);background:color-mix(in srgb,var(--share-panel) 92%,transparent);box-shadow:0 20px 58px rgb(0 0 0/.16)}html[data-panel-recipe=glass] :is(.share-header,.conversation){background:color-mix(in srgb,var(--share-panel) 72%,transparent);backdrop-filter:blur(22px) saturate(120%)}html[data-panel-recipe=beveled] :is(.share-header,.conversation){border-top-color:color-mix(in srgb,#fff 46%,var(--share-border));box-shadow:inset 0 1px rgb(255 255 255/.18),0 20px 58px rgb(0 0 0/.18)}.share-header{margin-bottom:18px;padding:24px 28px}.brand{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--share-muted);font-size:.76rem;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.brand-actions{display:flex;align-items:center;gap:8px}.readonly,.download-image{display:inline-flex;min-height:38px;align-items:center;justify-content:center;padding:5px 11px;border:1px solid var(--share-border);border-radius:999px;letter-spacing:.02em;text-transform:none}.download-image{color:var(--share-accent);text-decoration:none;transition:background .18s ease,border-color .18s ease}.download-image:hover{border-color:var(--share-accent);background:color-mix(in srgb,var(--share-accent) 10%,transparent)}.download-image:focus-visible{outline:2px solid var(--share-accent);outline-offset:2px}h1{margin:18px 0 7px;font-size:clamp(1.55rem,4vw,2.35rem);line-height:1.2;letter-spacing:-.02em}.meta{margin:0;color:var(--share-muted);font-size:.88rem}.conversation{padding:26px clamp(18px,4vw,42px)}.shared-message{display:grid;grid-template-columns:44px minmax(0,1fr);gap:12px;align-items:start;padding:13px 0}.shared-message[data-role=user]{grid-template-columns:minmax(0,1fr) 44px}.shared-message[data-role=user] .shared-avatar{grid-column:2}.shared-message[data-role=user] .shared-message-content{grid-column:1;grid-row:1;align-items:flex-end}.shared-avatar{display:grid;width:44px;height:44px;place-items:center;overflow:hidden;border:1px solid color-mix(in srgb,var(--share-accent) 42%,var(--share-border));border-radius:var(--share-radius-md);background:var(--share-surface);color:var(--share-muted);font-size:.8rem;font-weight:800}.shared-avatar img{width:100%;height:100%;object-fit:cover}.shared-message-content{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:5px}.shared-role{color:var(--share-muted);font-size:.7rem;font-weight:700}.shared-message-body{min-width:0;max-width:min(100%,48rem);color:var(--share-text)}.shared-message[data-role=user] .shared-message-body{padding:14px 17px;border:1px solid color-mix(in srgb,var(--share-accent) 34%,var(--share-border));border-radius:var(--share-radius-md);background:color-mix(in srgb,var(--share-accent) 10%,var(--share-panel))}html[data-message-recipe=bubble] .shared-message[data-role=assistant] .shared-message-body{padding:14px 17px;border:1px solid var(--share-border);border-radius:var(--share-radius-md);background:var(--share-elevated)}html[data-message-recipe=rail] .shared-message[data-role=assistant] .shared-message-body{padding-left:16px;border-left:4px solid var(--share-accent)}html[data-identity-recipe=none] .shared-message{grid-template-columns:minmax(0,1fr)}html[data-identity-recipe=none] .shared-avatar{display:none}html[data-identity-recipe=none] .shared-message[data-role=user] .shared-message-content{grid-column:1}.shared-markdown>:first-child{margin-top:0}.shared-markdown>:last-child{margin-bottom:0}.shared-markdown p,.shared-markdown ul,.shared-markdown ol{margin:.68em 0}.shared-markdown pre,.shared-tool pre{max-width:100%;overflow:auto;padding:14px 16px;border:1px solid color-mix(in srgb,var(--share-border) 72%,transparent);border-radius:var(--share-radius-sm);background:var(--share-code);color:#e7edf7;font-family:var(--share-mono);font-size:.86rem;line-height:1.55}.shared-markdown code{font-family:var(--share-mono)}.shared-markdown :not(pre)>code{padding:.12em .34em;border:1px solid var(--share-border);border-radius:5px;background:color-mix(in srgb,var(--share-accent) 12%,var(--share-panel));font-size:.9em}.shared-markdown table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}.shared-markdown th,.shared-markdown td{padding:8px 11px;border:1px solid var(--share-border);text-align:left}.shared-markdown blockquote{margin:1em 0;padding-left:16px;border-left:3px solid var(--share-accent);color:var(--share-muted)}.shared-tool{margin:10px 0;border:1px solid var(--share-border);border-radius:var(--share-radius-sm);background:color-mix(in srgb,var(--share-elevated) 84%,transparent)}.shared-tool summary{display:flex;justify-content:space-between;gap:16px;padding:11px 13px;cursor:pointer;font-weight:650}.shared-tool small{color:var(--share-muted);font-weight:500}.shared-tool>p,.shared-tool>ul,.shared-tool>pre{margin:0 13px 13px}.shared-images{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(12rem,100%),1fr));gap:8px;margin-bottom:10px}.shared-images img{display:block;width:100%;max-height:30rem;border:1px solid var(--share-border);border-radius:var(--share-radius-sm);object-fit:contain;background:var(--share-surface)}.shared-image-note{color:var(--share-muted);font-size:.82rem}.share-footer{margin-top:18px;text-align:center;color:var(--share-muted);font-size:.76rem}.error-card{padding:48px 28px;text-align:center;border:1px solid var(--share-border);border-radius:var(--share-radius-lg);background:var(--share-panel);box-shadow:0 18px 50px rgb(0 0 0/.12)}.error-card h1{font-size:1.7rem}
@media(max-width:640px){.page{width:min(100% - 20px,980px);padding:16px 0 38px}.share-header{padding:18px}.conversation{padding:14px 12px}.brand{align-items:flex-start;flex-direction:column}.brand-actions{width:100%;flex-wrap:wrap}.readonly,.download-image{min-height:44px}.shared-message{grid-template-columns:36px minmax(0,1fr);gap:8px}.shared-message[data-role=user]{grid-template-columns:minmax(0,1fr) 36px}.shared-avatar{width:36px;height:36px;border-radius:10px}.shared-message-body{max-width:100%}.shared-message[data-role=user] .shared-message-body,html[data-message-recipe=bubble] .shared-message[data-role=assistant] .shared-message-body{padding:12px 13px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
</style></head><body>${body}</body></html>`
}

export function renderConversationSharePage(share: ConversationShareRecord, imagePath: string): string {
  const locale = localeOf(share)
  const theme = conversationShareTheme(share.snapshot)
  const copy = locale === 'zh-CN' ? {
    brand: 'CodyWeb / 分享的对话', readonly: '只读分享', download: '下载分享图',
    expiryPrefix: '有效至', permanent: '永久有效', messages: '条消息', sharedAt: '分享于', conversation: '分享的对话', skin: '皮肤',
    footer: '这是由 CodyWeb 生成的只读对话快照，不包含原 Session 的访问权限。',
  } : {
    brand: 'CodyWeb / Shared conversation', readonly: 'Read-only share', download: 'Download image',
    expiryPrefix: 'Expires', permanent: 'Never expires', messages: 'messages', sharedAt: 'Shared', conversation: 'Shared conversation', skin: 'Skin',
    footer: 'This is a read-only snapshot generated by CodyWeb. It cannot access the source session.',
  }
  const expiry = share.expiresAtIso ? `${copy.expiryPrefix} ${formatDate(share.expiresAtIso, locale)}` : copy.permanent
  const messageLabel = locale === 'en' && share.messageCount === 1 ? 'message' : copy.messages
  const body = `<main class="page"><header class="share-header"><div class="brand"><span>${copy.brand}</span><span class="brand-actions"><a class="download-image" href="${escapeHtml(imagePath)}" download>${copy.download}</a><span class="readonly">${copy.readonly}</span></span></div><h1>${escapeHtml(share.title)}</h1><p class="meta">${String(share.messageCount)} ${messageLabel} · ${copy.skin} ${escapeHtml(theme.skinName)} · ${copy.sharedAt} ${formatDate(share.createdAtIso, locale)} · ${expiry}</p></header><section class="conversation" aria-label="${copy.conversation}">${renderShareMessages(share, locale)}</section><footer class="share-footer">${copy.footer}</footer></main>`
  return baseDocument(share.title, body, locale, theme)
}

export function renderConversationShareUnavailable(status: ConversationShareLookup['status'], locale: ShareLocale = 'zh-CN'): string {
  const copy = locale === 'zh-CN'
    ? status === 'expired'
      ? ['分享已过期', '这个公开链接已经超过有效期。']
      : status === 'revoked'
        ? ['分享已撤销', '分享者已经停止公开这段对话。']
        : ['找不到分享', '链接可能不完整，或者分享已经不存在。']
    : status === 'expired'
      ? ['Share expired', 'This public link has passed its expiration date.']
      : status === 'revoked'
        ? ['Share revoked', 'The owner has stopped sharing this conversation.']
        : ['Share not found', 'The link may be incomplete, or this share no longer exists.']
  const brand = locale === 'zh-CN' ? 'CodyWeb / 分享的对话' : 'CodyWeb / Shared conversation'
  const readonly = locale === 'zh-CN' ? '只读分享' : 'Read-only share'
  return baseDocument(copy[0], `<main class="page"><section class="error-card"><div class="brand"><span>${brand}</span><span class="readonly">${readonly}</span></div><h1>${copy[0]}</h1><p class="meta">${copy[1]}</p></section></main>`, locale)
}

export function sendConversationShareHtml(res: Response, statusCode: number, html: string): void {
  res.status(statusCode)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  res.send(html)
}
