import { contrastRatio } from './themeRegistry'
import { DEFAULT_SKIN_RECIPES, SKIN_API_VERSION } from './tokens'
import type { ResolvedThemeColorMode, SkinPack, ThemeTokens } from './tokens'

const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024
// Keep generated backgrounds small enough to embed in a portable .cody-skin
// package while still looking crisp after the intentional blur treatment.
const MAX_STORED_IMAGE_BYTES = 480_000
const DEFAULT_ACCENT = '#2563eb'

type Rgb = { r: number; g: number; b: number }
type Hsl = { h: number; s: number; l: number }

export type ProcessedThemeImage = {
  dataUrl: string
  palette: string[]
  width: number
  height: number
  byteSize: number
}

export type ImageSkinOptions = {
  name: string
  backgroundUrl: string
  palette: string[]
  blur: number
  dim: number
  saturation: number
  position: string
  defaultColorMode?: ResolvedThemeColorMode
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function byteToHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')
}

function rgbToHex(color: Rgb): string {
  return `#${byteToHex(color.r)}${byteToHex(color.g)}${byteToHex(color.b)}`
}

function hexToRgb(value: string): Rgb | null {
  const normalized = value.replace('#', '')
  if (!/^[a-f0-9]{6}$/iu.test(normalized)) return null
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  const lightness = (maximum + minimum) / 2
  if (delta === 0) return { h: 215, s: 0, l: lightness * 100 }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = maximum === red
    ? ((green - blue) / delta) % 6
    : maximum === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4
  hue = Math.round(hue * 60)
  if (hue < 0) hue += 360
  return { h: hue, s: saturation * 100, l: lightness * 100 }
}

function hslToHex({ h, s, l }: Hsl): string {
  const saturation = clamp(s, 0, 100) / 100
  const lightness = clamp(l, 0, 100) / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = ((h % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs((section % 2) - 1))
  const [r1, g1, b1] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x]
  const match = lightness - chroma / 2
  return rgbToHex({ r: (r1 + match) * 255, g: (g1 + match) * 255, b: (b1 + match) * 255 })
}

function colorDistance(first: Rgb, second: Rgb): number {
  return Math.hypot(first.r - second.r, first.g - second.g, first.b - second.b)
}

export function extractPaletteFromPixels(pixels: Uint8ClampedArray, limit = 6): string[] {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 160) continue
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
  }
  const candidates = [...buckets.values()]
    .sort((first, second) => second.count - first.count)
    .map((bucket) => ({
      count: bucket.count,
      color: { r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count },
    }))
  const selected: Rgb[] = []
  for (const candidate of candidates) {
    if (selected.every((color) => colorDistance(color, candidate.color) >= 42)) selected.push(candidate.color)
    if (selected.length >= limit) break
  }
  if (selected.length === 0) return [DEFAULT_ACCENT]
  return selected.map(rgbToHex)
}

export function choosePaletteAccent(palette: string[]): string {
  const candidates = palette
    .map((value) => ({ value, rgb: hexToRgb(value) }))
    .filter((entry): entry is { value: string; rgb: Rgb } => entry.rgb !== null)
    .map((entry) => ({ ...entry, hsl: rgbToHsl(entry.rgb) }))
    .filter((entry) => entry.hsl.s >= 18 && entry.hsl.l >= 16 && entry.hsl.l <= 84)
    .sort((first, second) => {
      const firstScore = first.hsl.s * (1 - Math.abs(first.hsl.l - 50) / 65)
      const secondScore = second.hsl.s * (1 - Math.abs(second.hsl.l - 50) / 65)
      return secondScore - firstScore
    })
  return candidates[0]?.value ?? DEFAULT_ACCENT
}

function readableMutedColor(candidate: string, background: string, fallback: string): string {
  return contrastRatio(candidate, background) >= 4.5 ? candidate : fallback
}

function themeTokens(accentSource: string, mode: ResolvedThemeColorMode): ThemeTokens {
  const accentHsl = rgbToHsl(hexToRgb(accentSource) ?? hexToRgb(DEFAULT_ACCENT)!)
  const hue = accentHsl.h
  const saturation = clamp(accentHsl.s, 48, 88)
  const dark = mode === 'dark'
  const background = hslToHex({ h: hue, s: dark ? 24 : 28, l: dark ? 8 : 96 })
  const surface = hslToHex({ h: hue, s: dark ? 20 : 24, l: dark ? 12 : 99 })
  const panel = hslToHex({ h: hue, s: dark ? 18 : 20, l: dark ? 15 : 98 })
  const elevated = hslToHex({ h: hue, s: dark ? 18 : 22, l: dark ? 20 : 93 })
  const text = hslToHex({ h: hue, s: 18, l: dark ? 96 : 12 })
  const mutedCandidate = hslToHex({ h: hue, s: 14, l: dark ? 68 : 38 })
  const textMuted = readableMutedColor(mutedCandidate, panel, dark ? '#b6c0cc' : '#4b5563')
  const border = hslToHex({ h: hue, s: dark ? 20 : 22, l: dark ? 31 : 80 })
  const accent = hslToHex({ h: hue, s: saturation, l: dark ? 66 : 38 })
  const codeBackground = hslToHex({ h: hue, s: 28, l: dark ? 5 : 10 })
  return {
    color: {
      background,
      surface,
      panel,
      elevated,
      text,
      textMuted,
      border,
      accent,
      danger: dark ? '#fb7185' : '#be123c',
      warning: dark ? '#fbbf24' : '#a16207',
      success: dark ? '#4ade80' : '#15803d',
      info: dark ? '#38bdf8' : '#0369a1',
      codeBackground,
      terminalBackground: codeBackground,
    },
    font: {
      sans: 'Inter, "IBM Plex Sans", "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
      mono: '"IBM Plex Mono", "Cascadia Code", "SFMono-Regular", ui-monospace, monospace',
    },
    spacing: { xs: '0.25rem', sm: '0.625rem', md: '0.875rem', lg: '1.25rem' },
    radius: { sm: '0.5rem', md: '0.85rem', lg: '1.15rem' },
    shadow: {
      panel: dark ? '0 18px 48px rgb(0 0 0 / 0.24)' : '0 18px 48px rgb(15 23 42 / 0.12)',
      floating: dark ? '0 28px 72px rgb(0 0 0 / 0.5)' : '0 28px 72px rgb(15 23 42 / 0.2)',
      focus: `0 0 0 3px ${accent}38`,
    },
    motion: { fast: '120ms', normal: '180ms', slow: '280ms' },
    density: 'comfortable',
  }
}

export function createImageSkinPack(options: ImageSkinOptions): SkinPack {
  const accentSource = choosePaletteAccent(options.palette)
  const background = {
    type: 'image' as const,
    fit: 'cover' as const,
    position: options.position,
    blur: clamp(options.blur, 0, 48),
    dim: clamp(options.dim, 0, 80),
    saturation: clamp(options.saturation, 50, 160),
  }
  const lightTokens = themeTokens(accentSource, 'light')
  const darkTokens = themeTokens(accentSource, 'dark')
  const safeName = options.name.trim().slice(0, 80) || 'Image skin'
  const slug = safeName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 28) || 'image'
  const fingerprint = options.backgroundUrl.match(/[a-f0-9]{8}/u)?.[0] ?? Date.now().toString(36)
  const shared = {
    background,
    chartPalette: [lightTokens.color.accent, ...options.palette.slice(0, 5)],
  }
  return {
    manifest: { schemaVersion: SKIN_API_VERSION, version: '1.0.0', author: 'CodyWeb image studio' },
    id: `image-${slug}-${fingerprint}`.slice(0, 64).replace(/-$/u, ''),
    name: safeName,
    description: 'Generated locally from an uploaded image.',
    defaultColorMode: options.defaultColorMode ?? 'dark',
    recipes: {
      ...DEFAULT_SKIN_RECIPES,
      panel: 'glass',
      composer: 'glass',
      backdrop: 'image',
    },
    assets: { background: options.backgroundUrl },
    variants: {
      light: {
        ...shared,
        tokens: lightTokens,
        syntaxTheme: 'light',
        terminalTheme: { background: lightTokens.color.terminalBackground, foreground: '#f8fafc' },
      },
      dark: {
        ...shared,
        tokens: darkTokens,
        syntaxTheme: 'dark',
        terminalTheme: { background: darkTokens.color.terminalBackground, foreground: '#f8fafc' },
      },
    },
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the processed image.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the theme image.')), 'image/webp', quality)
  })
}

export async function processThemeImage(file: File): Promise<ProcessedThemeImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.')
  if (file.size === 0 || file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error('Image must be between 1 byte and 15 MB.')
  const bitmap = await createImageBitmap(file)
  try {
    const analysisCanvas = document.createElement('canvas')
    analysisCanvas.width = 56
    analysisCanvas.height = 56
    const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true })
    if (!analysisContext) throw new Error('Image analysis is unavailable in this browser.')
    analysisContext.drawImage(bitmap, 0, 0, analysisCanvas.width, analysisCanvas.height)
    const palette = extractPaletteFromPixels(analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height).data)

    const attempts = [
      { maxDimension: 1600, quality: 0.82 },
      { maxDimension: 1280, quality: 0.72 },
      { maxDimension: 1024, quality: 0.64 },
      { maxDimension: 900, quality: 0.56 },
    ]
    let encoded: Blob | null = null
    let outputWidth = bitmap.width
    let outputHeight = bitmap.height
    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.maxDimension / Math.max(bitmap.width, bitmap.height))
      outputWidth = Math.max(1, Math.round(bitmap.width * scale))
      outputHeight = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = outputWidth
      canvas.height = outputHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image processing is unavailable in this browser.')
      context.drawImage(bitmap, 0, 0, outputWidth, outputHeight)
      encoded = await canvasBlob(canvas, attempt.quality)
      if (encoded.size <= MAX_STORED_IMAGE_BYTES) break
    }
    if (!encoded || encoded.size > MAX_STORED_IMAGE_BYTES) throw new Error('The optimized image is still too large for a portable skin. Choose a smaller image.')
    return {
      dataUrl: await blobToDataUrl(encoded),
      palette,
      width: outputWidth,
      height: outputHeight,
      byteSize: encoded.size,
    }
  } finally {
    bitmap.close()
  }
}
