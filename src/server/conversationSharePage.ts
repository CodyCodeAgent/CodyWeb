import MarkdownIt from 'markdown-it'
import type { Response } from 'express'
import type { ConversationShareLookup, ConversationShareRecord } from './conversationShareStore.js'

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
markdown.renderer.rules.image = (_tokens, _index, _options, env: { locale?: ShareLocale }) => `<span class="shared-image-note">${env.locale === 'en' ? 'Image omitted from the public snapshot' : '图片未随公开链接发布'}</span>`

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

function renderShareMessages(share: ConversationShareRecord, locale: ShareLocale): string {
  let previousTurnId = ''
  let turnIndex = 0
  return share.snapshot.messages.map((message) => {
    const beginsTurn = message.turnId !== previousTurnId
    if (beginsTurn) {
      previousTurnId = message.turnId
      turnIndex += 1
    }
    const roleLabel = message.role === 'user' ? (locale === 'zh-CN' ? '提问' : 'Question') : message.role === 'assistant' ? 'Cody' : (locale === 'zh-CN' ? '过程' : 'Process')
    const body = message.text.trim() ? `<div class="shared-markdown">${markdown.render(message.text, { locale })}</div>` : ''
    const tool = message.tool ? renderTool(message.tool, locale) : ''
    const images = message.imageCount > 0 ? `<p class="shared-image-note">${locale === 'zh-CN' ? `此条消息包含 ${String(message.imageCount)} 张图片，未随公开链接发布。` : `This message contains ${String(message.imageCount)} image(s), which are not included in the public snapshot.`}</p>` : ''
    const turnLabel = locale === 'zh-CN' ? `回合 ${String(turnIndex)}` : `Turn ${String(turnIndex)}`
    return `${beginsTurn && turnIndex > 1 ? '<hr class="turn-divider">' : ''}<article class="shared-message" data-role="${message.role}"><div class="shared-role"><span>${escapeHtml(roleLabel)}</span>${beginsTurn ? `<small>${turnLabel}</small>` : ''}</div><div class="shared-message-body">${body}${tool}${images}</div></article>`
  }).join('')
}

function baseDocument(title: string, body: string, locale: ShareLocale): string {
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(title)} · CodyWeb</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#5f6d85;--border:#dce3ee;--accent:#1967d2;--accent-soft:#eaf2ff;--user:#eef4ff;--code:#111827;--code-text:#e5edf9;--shadow:0 18px 50px rgba(22,34,58,.1)}
@media(prefers-color-scheme:dark){:root{--bg:#0f1724;--panel:#142033;--text:#edf3fc;--muted:#a6b3c8;--border:#2b3a50;--accent:#72a7ff;--accent-soft:#1b3152;--user:#192b46;--code:#090f1a;--code-text:#dbe8f8;--shadow:0 20px 56px rgba(0,0,0,.28)}}
*{box-sizing:border-box}html{font-size:16px}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 42%),var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}a{color:var(--accent)}.page{width:min(100% - 32px,920px);margin:0 auto;padding:40px 0 72px}.share-header{margin-bottom:24px;padding:26px 28px;border:1px solid var(--border);border-radius:18px;background:color-mix(in srgb,var(--panel) 94%,transparent);box-shadow:var(--shadow)}.brand{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--muted);font-size:.78rem;font-weight:750;letter-spacing:.14em;text-transform:uppercase}.brand-actions{display:flex;align-items:center;gap:8px}.readonly,.download-image{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:5px 10px;border:1px solid var(--border);border-radius:999px;letter-spacing:.04em;text-transform:none}.download-image{color:var(--accent);text-decoration:none;transition:background .18s ease,border-color .18s ease}.download-image:hover{border-color:var(--accent);background:var(--accent-soft)}.download-image:focus-visible{outline:2px solid var(--accent);outline-offset:2px}h1{margin:20px 0 8px;font-size:clamp(1.7rem,4vw,2.6rem);line-height:1.18;letter-spacing:-.025em}.meta{margin:0;color:var(--muted);font-size:.92rem}.conversation{padding:18px clamp(18px,4vw,38px);border:1px solid var(--border);border-radius:18px;background:var(--panel);box-shadow:var(--shadow)}.shared-message{display:grid;grid-template-columns:88px minmax(0,1fr);gap:18px;padding:20px 0}.shared-role{display:flex;flex-direction:column;gap:3px;color:var(--muted);font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.shared-role small{font-size:.7rem;font-weight:500;letter-spacing:0;text-transform:none}.shared-message[data-role=user] .shared-message-body{padding:16px 18px;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--border));border-radius:14px;background:var(--user)}.shared-message-body{min-width:0}.shared-markdown>:first-child{margin-top:0}.shared-markdown>:last-child{margin-bottom:0}.shared-markdown p,.shared-markdown ul,.shared-markdown ol{margin:.75em 0}.shared-markdown pre,.shared-tool pre{max-width:100%;overflow:auto;padding:14px 16px;border-radius:10px;background:var(--code);color:var(--code-text);font-size:.88rem;line-height:1.55}.shared-markdown code{font-family:"SFMono-Regular",Consolas,monospace}.shared-markdown :not(pre)>code{padding:.12em .34em;border:1px solid var(--border);border-radius:5px;background:color-mix(in srgb,var(--accent-soft) 50%,var(--panel));font-size:.9em}.shared-markdown table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}.shared-markdown th,.shared-markdown td{padding:8px 11px;border:1px solid var(--border);text-align:left}.shared-markdown blockquote{margin:1em 0;padding-left:16px;border-left:3px solid var(--accent);color:var(--muted)}.turn-divider{height:1px;margin:10px 0;border:0;background:var(--border)}.shared-tool{margin:10px 0;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--panel) 84%,var(--accent-soft))}.shared-tool summary{display:flex;justify-content:space-between;gap:16px;padding:11px 13px;cursor:pointer;font-weight:650}.shared-tool small{color:var(--muted);font-weight:500}.shared-tool>p,.shared-tool>ul,.shared-tool>pre{margin:0 13px 13px}.shared-image-note{color:var(--muted);font-size:.84rem}.share-footer{margin-top:18px;text-align:center;color:var(--muted);font-size:.78rem}.error-card{padding:48px 28px;text-align:center;border:1px solid var(--border);border-radius:18px;background:var(--panel);box-shadow:var(--shadow)}.error-card h1{font-size:1.7rem}
@media(max-width:640px){.page{width:min(100% - 20px,920px);padding:18px 0 42px}.share-header{padding:20px}.conversation{padding:10px 16px}.shared-message{grid-template-columns:1fr;gap:8px;padding:18px 0}.shared-role{flex-direction:row;justify-content:space-between}.shared-message[data-role=user] .shared-message-body{padding:14px}.brand{align-items:flex-start;flex-direction:column}.brand-actions{width:100%;justify-content:flex-start;flex-wrap:wrap}.readonly,.download-image{min-height:44px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important}}
</style></head><body>${body}</body></html>`
}

export function renderConversationSharePage(share: ConversationShareRecord, imagePath: string): string {
  const locale = localeOf(share)
  const copy = locale === 'zh-CN' ? {
    brand: 'CodyWeb / 共享对话', readonly: '只读分享', download: '下载分享图',
    expiryPrefix: '有效至', permanent: '永久有效', turns: '个精选回合', sharedAt: '分享于', conversation: '分享的对话',
    footer: '这是由 CodyWeb 生成的只读对话快照，不包含原 Session 的访问权限。',
  } : {
    brand: 'CodyWeb / Shared conversation', readonly: 'Read-only share', download: 'Download image',
    expiryPrefix: 'Expires', permanent: 'Never expires', turns: 'selected turns', sharedAt: 'Shared', conversation: 'Shared conversation',
    footer: 'This is a read-only snapshot generated by CodyWeb. It cannot access the source session.',
  }
  const expiry = share.expiresAtIso ? `${copy.expiryPrefix} ${formatDate(share.expiresAtIso, locale)}` : copy.permanent
  const turnSummary = locale === 'en' && share.turnCount === 1 ? 'selected turn' : copy.turns
  return baseDocument(share.title, `<main class="page"><header class="share-header"><div class="brand"><span>${copy.brand}</span><span class="brand-actions"><a class="download-image" href="${escapeHtml(imagePath)}" download>${copy.download}</a><span class="readonly">${copy.readonly}</span></span></div><h1>${escapeHtml(share.title)}</h1><p class="meta">${String(share.turnCount)} ${turnSummary} · ${copy.sharedAt} ${formatDate(share.createdAtIso, locale)} · ${expiry}</p></header><section class="conversation" aria-label="${copy.conversation}">${renderShareMessages(share, locale)}</section><footer class="share-footer">${copy.footer}</footer></main>`, locale)
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
  const brand = locale === 'zh-CN' ? 'CodyWeb / 共享对话' : 'CodyWeb / Shared conversation'
  const readonly = locale === 'zh-CN' ? '只读分享' : 'Read-only share'
  return baseDocument(copy[0], `<main class="page"><section class="error-card"><div class="brand"><span>${brand}</span><span class="readonly">${readonly}</span></div><h1>${copy[0]}</h1><p class="meta">${copy[1]}</p></section></main>`, locale)
}

export function sendConversationShareHtml(res: Response, statusCode: number, html: string): void {
  res.status(statusCode)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  res.send(html)
}
