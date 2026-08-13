import type { UiConversationShareMessage, UiConversationShareThemeSnapshot } from '../types/codex'

const INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/iu
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_SINGLE_IMAGE_BYTES = 720_000
const MAX_MESSAGE_ASSET_BYTES = 4_800_000
const MAX_THEME_ASSET_BYTES = 500_000
const MAX_IMAGE_DIMENSION = 2_048

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

function inlineImageBlob(value: string): Blob | null {
  const separator = value.indexOf(',')
  const mimeType = value.slice(5, separator).split(';')[0]?.toLowerCase().trim() ?? ''
  if (separator < 0 || !ALLOWED_IMAGE_TYPES.has(mimeType)) return null
  try {
    const binary = atob(value.slice(separator + 1))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mimeType })
  } catch {
    return null
  }
}

async function blobDataUrl(blob: Blob): Promise<string | null> {
  const mimeType = blob.type.toLowerCase().split(';')[0]?.trim() ?? ''
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) return null
  return `data:${mimeType};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality))
}

async function compressImageBlob(blob: Blob, targetBytes: number): Promise<Blob | null> {
  if (blob.size <= targetBytes) return blob
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function' || targetBytes < 32_000) return null

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const dimensionScale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const scaleSteps = [dimensionScale, dimensionScale * 0.82, dimensionScale * 0.66]
    const qualitySteps = [0.82, 0.68, 0.54]
    let smallest: Blob | null = null

    for (const scale of scaleSteps) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      for (const quality of qualitySteps) {
        const candidate = await canvasToBlob(canvas, 'image/webp', quality)
        if (!candidate) continue
        if (!smallest || candidate.size < smallest.size) smallest = candidate
        if (candidate.size <= targetBytes) return candidate
      }
    }
    return smallest && smallest.size <= targetBytes ? smallest : null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

async function inlineImage(
  value: string,
  targetBytes: number,
  fetcher: typeof fetch,
): Promise<{ dataUrl: string; bytes: number } | null> {
  if (INLINE_IMAGE_PATTERN.test(value)) {
    const bytes = estimatedDataUrlBytes(value)
    if (bytes <= targetBytes) return { dataUrl: value, bytes }
    const sourceBlob = inlineImageBlob(value)
    const portableBlob = sourceBlob ? await compressImageBlob(sourceBlob, targetBytes) : null
    const dataUrl = portableBlob ? await blobDataUrl(portableBlob) : null
    return portableBlob && dataUrl ? { dataUrl, bytes: portableBlob.size } : null
  }
  if (!value || targetBytes <= 0) return null
  try {
    const response = await fetcher(value, { credentials: 'same-origin' })
    if (!response.ok) return null
    const blob = await response.blob()
    const mimeType = blob.type.toLowerCase().split(';')[0]?.trim() ?? ''
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) return null
    const portableBlob = await compressImageBlob(blob, targetBytes)
    if (!portableBlob) return null
    const dataUrl = await blobDataUrl(portableBlob)
    if (!dataUrl) return null
    return { dataUrl, bytes: portableBlob.size }
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
  let remainingThemeBytes = MAX_THEME_ASSET_BYTES
  let remainingMessageBytes = MAX_MESSAGE_ASSET_BYTES
  let omittedImageCount = 0
  const assets: UiConversationShareThemeSnapshot['assets'] = {}
  const themeSources = (['background', 'assistantAvatar', 'userAvatar'] as const).filter((key) => Boolean(theme.assets[key]))

  for (const [index, key] of themeSources.entries()) {
    const source = theme.assets[key]
    if (!source) continue
    const sourcesLeft = themeSources.length - index
    const targetBytes = Math.min(MAX_SINGLE_IMAGE_BYTES, Math.floor(remainingThemeBytes / sourcesLeft))
    const inlined = await inlineImage(source, targetBytes, fetcher)
    if (!inlined) continue
    assets[key] = inlined.dataUrl
    remainingThemeBytes -= inlined.bytes
  }

  let remainingImageSources = messages.reduce((total, message) => total + (message.images?.length ?? 0), 0)
  const materializedMessages: UiConversationShareMessage[] = []
  for (const message of messages) {
    const images: string[] = []
    for (const source of message.images ?? []) {
      const targetBytes = Math.min(
        MAX_SINGLE_IMAGE_BYTES,
        Math.floor(remainingMessageBytes / Math.max(1, remainingImageSources)),
      )
      const inlined = await inlineImage(source, targetBytes, fetcher)
      remainingImageSources -= 1
      if (!inlined) {
        omittedImageCount += 1
        continue
      }
      images.push(inlined.dataUrl)
      remainingMessageBytes -= inlined.bytes
    }
    materializedMessages.push({ ...message, images })
  }

  return {
    messages: materializedMessages,
    theme: { ...theme, assets },
    omittedImageCount,
  }
}
