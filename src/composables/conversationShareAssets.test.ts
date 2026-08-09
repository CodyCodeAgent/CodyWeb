import { describe, expect, it, vi } from 'vitest'
import type { UiConversationShareMessage, UiConversationShareThemeSnapshot } from '../types/codex'
import { materializeConversationShareAssets } from './conversationShareAssets'

const theme: UiConversationShareThemeSnapshot = {
  skinId: 'test', skinName: 'Test', colorMode: 'dark',
  colors: {
    background: '#000000', surface: '#111111', panel: '#111111', elevated: '#222222',
    text: '#ffffff', textMuted: '#aaaaaa', border: '#333333', accent: '#55aaff', codeBackground: '#050505',
  },
  fonts: { sans: 'Arial, sans-serif', mono: 'Consolas, monospace' },
  radii: { sm: '8px', md: '12px', lg: '18px' },
  recipes: { message: 'bubble', identity: 'avatars', panel: 'glass', backdrop: 'image' },
  background: { type: 'image', fit: 'cover', position: 'center', blur: 8, dim: 40, saturation: 100 },
  assets: { background: '/skin-assets/test.png' },
}

const messages: UiConversationShareMessage[] = [{
  id: 'message-1', turnId: 'turn-1', role: 'assistant', text: 'Done', messageType: 'agentMessage',
  imageCount: 1, images: ['/codex-api/local-image?id=1'], tool: null,
}]

describe('conversation share assets', () => {
  it('freezes theme and message images as portable data URLs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(
      new Blob([String(input).includes('skin-assets') ? 'skin' : 'message'], { type: 'image/png' }),
      { status: 200 },
    )) as unknown as typeof fetch
    const result = await materializeConversationShareAssets(messages, theme, fetcher)

    expect(result.theme.assets.background).toMatch(/^data:image\/png;base64,/u)
    expect(result.messages[0]?.images?.[0]).toMatch(/^data:image\/png;base64,/u)
    expect(result.omittedImageCount).toBe(0)
  })

  it('drops unsafe image types without failing share creation', async () => {
    const fetcher = vi.fn(async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })) as unknown as typeof fetch
    const result = await materializeConversationShareAssets(messages, theme, fetcher)

    expect(result.theme.assets.background).toBeUndefined()
    expect(result.messages[0]?.images).toEqual([])
    expect(result.omittedImageCount).toBe(1)
  })
})
