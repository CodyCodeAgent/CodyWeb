import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readThemeAsset, readThemeAssetBytesForTest, saveThemeAsset } from './themeAssetStore'

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
let previousDbPath: string | undefined
let tempDir = ''

beforeEach(async () => {
  previousDbPath = process.env.CODY_WEB_UI_SETTINGS_DB
  tempDir = await mkdtemp(join(tmpdir(), 'cody-theme-assets-'))
  process.env.CODY_WEB_UI_SETTINGS_DB = join(tempDir, 'settings.sqlite3')
})

afterEach(async () => {
  if (previousDbPath === undefined) delete process.env.CODY_WEB_UI_SETTINGS_DB
  else process.env.CODY_WEB_UI_SETTINGS_DB = previousDbPath
  await rm(tempDir, { recursive: true, force: true })
})

describe('theme asset store', () => {
  it('persists content-addressed assets beside the sqlite database', async () => {
    const first = await saveThemeAsset(`data:image/png;base64,${ONE_PIXEL_PNG}`)
    const second = await saveThemeAsset(`data:image/png;base64,${ONE_PIXEL_PNG}`)

    expect(first.id).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.id).toBe(first.id)
    expect(first.url).toBe(`/codex-api/theme-assets/${first.id}`)
    await expect(readThemeAsset(first.id)).resolves.toMatchObject({ mimeType: 'image/png', byteSize: 68 })
    await expect(readThemeAssetBytesForTest(first.id)).resolves.toEqual(Buffer.from(ONE_PIXEL_PNG, 'base64'))
  })

  it('rejects spoofed and oversized image payloads', async () => {
    await expect(saveThemeAsset('data:image/png;base64,aGVsbG8=')).rejects.toThrow('does not match')
    await expect(saveThemeAsset('https://example.com/picture.png')).rejects.toThrow('data URL')
  })
})
