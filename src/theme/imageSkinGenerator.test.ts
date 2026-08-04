import { describe, expect, it } from 'vitest'
import { contrastRatio, parseSkinPack } from './themeRegistry'
import { choosePaletteAccent, createImageSkinPack, extractPaletteFromPixels } from './imageSkinGenerator'

describe('image skin generator', () => {
  it('extracts distinct dominant colors without transparent pixels', () => {
    const pixels = new Uint8ClampedArray([
      240, 30, 40, 255,
      242, 32, 42, 255,
      20, 80, 230, 255,
      0, 255, 0, 0,
    ])
    const palette = extractPaletteFromPixels(pixels)
    expect(palette).toHaveLength(2)
    expect(palette[0]).toMatch(/^#[a-f0-9]{6}$/u)
  })

  it('prefers a vivid usable accent and falls back for grayscale images', () => {
    expect(choosePaletteAccent(['#d0d0d0', '#e11d48', '#111111'])).toBe('#e11d48')
    expect(choosePaletteAccent(['#eeeeee', '#111111'])).toBe('#2563eb')
  })

  it('creates validated readable light and dark skin variants', () => {
    const skin = createImageSkinPack({
      name: 'Mountain glass',
      backgroundUrl: `/codex-api/theme-assets/${'a'.repeat(64)}`,
      palette: ['#315f77', '#d8894b', '#abc2cc'],
      blur: 24,
      dim: 38,
      saturation: 108,
      position: 'center top',
    })
    const parsed = parseSkinPack(JSON.stringify(skin))
    expect(parsed).toMatchObject({
      name: 'Mountain glass',
      defaultColorMode: 'dark',
      recipes: { backdrop: 'image', panel: 'glass', composer: 'glass' },
      assets: { background: `/codex-api/theme-assets/${'a'.repeat(64)}` },
    })
    expect(parsed.variants.dark?.background).toMatchObject({ blur: 24, dim: 38, saturation: 108 })
    for (const variant of [parsed.variants.light, parsed.variants.dark]) {
      expect(variant).toBeDefined()
      expect(contrastRatio(variant!.tokens.color.text, variant!.tokens.color.panel)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(variant!.tokens.color.textMuted, variant!.tokens.color.panel)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
