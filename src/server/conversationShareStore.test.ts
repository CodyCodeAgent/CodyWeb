import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createConversationShare,
  listConversationShares,
  lookupConversationShare,
  revokeConversationShare,
} from './conversationShareStore'
import { renderConversationSharePage } from './conversationSharePage'
import { renderConversationShareImage } from './conversationShareImage'

let tempDir = ''
let databasePath = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cody-share-store-'))
  databasePath = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function snapshot() {
  return {
    version: 2,
    locale: 'zh-CN',
    title: 'Why the test failed',
    threadTitle: 'Debug session',
    projectName: 'project',
    createdAtIso: 'ignored',
    selectedTurnIds: ['turn-1'],
    selectedMessageIds: ['u1', 'a1'],
    theme: {
      skinId: 'qq-2007', skinName: 'QQ 2007', colorMode: 'dark',
      colors: {
        background: '#081522', surface: '#10263a', panel: '#12304a', elevated: '#173b58',
        text: '#f1f7ff', textMuted: '#a9bfd2', border: '#315d7a', accent: '#54b8ff', codeBackground: '#050b12',
      },
      fonts: { sans: 'Inter, Arial, sans-serif', mono: 'Consolas, monospace' },
      radii: { sm: '8px', md: '14px', lg: '20px' },
      recipes: { message: 'bubble', identity: 'avatars', panel: 'glass', backdrop: 'image' },
      background: { type: 'image', fit: 'cover', position: 'center', blur: 12, dim: 42, saturation: 110 },
      assets: { assistantAvatar: 'data:image/png;base64,AA==' },
    },
    options: { includeToolDetails: true, redactLocalPaths: true },
    messages: [
      { id: 'u1', turnId: 'turn-1', role: 'user', text: 'Check /Users/alice/code/project/src/a.ts', messageType: 'userMessage', imageCount: 0, tool: null },
      { id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'token=super-secret-token-value\n<script>alert(1)</script>', messageType: 'agentMessage', imageCount: 1, images: ['data:image/png;base64,AA=='], tool: null },
    ],
  }
}

describe('conversation share store', () => {
  it('stores a hashed public token and serves a sanitized immutable snapshot', () => {
    const created = createConversationShare({
      threadId: 'thread-1', snapshot: snapshot(), expiresInDays: 30, databasePath,
      now: new Date('2026-08-07T10:00:00.000Z'),
    })

    expect(created.summary.publicPath).toMatch(/^\/share\/[A-Za-z0-9_-]{40,80}$/u)
    const token = created.summary.publicPath.split('/').pop() ?? ''
    const lookup = lookupConversationShare(token, databasePath, new Date('2026-08-08T10:00:00.000Z'))
    expect(lookup.status).toBe('active')
    if (lookup.status !== 'active') throw new Error('Expected active share')
    expect(lookup.share.snapshot.messages[0]?.text).toBe('Check …/src/a.ts')
    expect(lookup.share.snapshot.messages[1]?.text).toContain('token=[REDACTED]')

    const html = renderConversationSharePage(lookup.share, `${created.summary.publicPath}/image.svg`)
    expect(html).toContain('Why the test failed')
    expect(html).toContain('只读分享')
    expect(html).toContain('data-message-recipe="bubble"')
    expect(html).toContain('--share-accent:#54b8ff')
    expect(html).toContain('QQ 2007')
    expect(html).toContain('data:image/png;base64,AA==')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('super-secret-token-value')
    const image = renderConversationShareImage(lookup.share)
    expect(image).toContain('<svg')
    expect(image).toContain('Why the test failed')
    expect(image).toContain('分享的对话')
    expect(image).toContain('#54b8ff')
    expect(image).toContain('data:image/png;base64,AA==')
    expect(image).not.toContain('super-secret-token-value')
    expect(listConversationShares('thread-1', databasePath)).toHaveLength(1)
  })

  it('expires and revokes links without changing the source snapshot', () => {
    const created = createConversationShare({
      threadId: 'thread-1', snapshot: snapshot(), expiresInDays: 7, databasePath,
      now: new Date('2026-08-01T00:00:00.000Z'),
    })
    const token = created.summary.publicPath.split('/').pop() ?? ''
    expect(lookupConversationShare(token, databasePath, new Date('2026-08-08T00:00:00.001Z')).status).toBe('expired')

    const permanent = createConversationShare({ threadId: 'thread-1', snapshot: snapshot(), expiresInDays: null, databasePath })
    const permanentToken = permanent.summary.publicPath.split('/').pop() ?? ''
    expect(revokeConversationShare(permanent.summary.id, databasePath)).toBe(true)
    expect(lookupConversationShare(permanentToken, databasePath).status).toBe('revoked')
    expect(listConversationShares('thread-1', databasePath, new Date('2026-08-09T00:00:00.000Z'))).toHaveLength(0)
  })
})
