import type { UiConversationShareMessage, UiConversationShareThemeSnapshot } from '../types/codex'

const INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/iu
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_SINGLE_IMAGE_BYTES = 900_000
const MAX_INLINE_ASSET_BYTES = 3_200_000

function estimatedDataUrlBytes(value: string): number {
  const encoded = value.slice(value.indexOf(',') + 1)
  return Math.ceil(encoded.length * 0.75)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function inlineImage(
  value: string,
  remainingBytes: number,
  fetcher: typeof fetch,
): Promise<{ dataUrl: string; bytes: number } | null> {
  if (INLINE_IMAGE_PATTERN.test(value)) {
    const bytes = estimatedDataUrlBytes(value)
    return bytes <= MAX_SINGLE_IMAGE_BYTES && bytes <= remainingBytes ? { dataUrl: value, bytes } : null
  }
  if (!value || remainingBytes <= 0) return null
  try {
    const response = await fetcher(value, { credentials: 'same-origin' })
    if (!response.ok) return null
    const blob = await response.blob()
    const mimeType = blob.type.toLowerCase().split(';')[0]?.trim() ?? ''
    if (!ALLOWED_IMAGE_TYPES.has(mimeType) || blob.size > MAX_SINGLE_IMAGE_BYTES || blob.size > remainingBytes) return null
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
    return { dataUrl, bytes: blob.size }
  } catch {
    return null
  }
}

export async function materializeConversationShareAssets(
  messages: UiConversationShareMessage[],
  theme: UiConversationShareThemeSnapshot,
  fetcher: typeof fetch = fetch,
): Promise<{
  messages: UiConversationShareMessage[]
  theme: UiConversationShareThemeSnapshot
  omittedImageCount: number
}> {
  let remainingBytes = MAX_INLINE_ASSET_BYTES
  let omittedImageCount = 0
  const assets: UiConversationShareThemeSnapshot['assets'] = {}

  for (const key of ['background', 'assistantAvatar', 'userAvatar'] as const) {
    const source = theme.assets[key]
    if (!source) continue
    const inlined = await inlineImage(source, remainingBytes, fetcher)
    if (!inlined) continue
    assets[key] = inlined.dataUrl
    remainingBytes -= inlined.bytes
  }

  const materializedMessages: UiConversationShareMessage[] = []
  for (const message of messages) {
    const images: string[] = []
    for (const source of message.images ?? []) {
      const inlined = await inlineImage(source, remainingBytes, fetcher)
      if (!inlined) {
        omittedImageCount += 1
        continue
      }
      images.push(inlined.dataUrl)
      remainingBytes -= inlined.bytes
    }
    materializedMessages.push({ ...message, images })
  }

  return {
    messages: materializedMessages,
    theme: { ...theme, assets },
    omittedImageCount,
  }
}
