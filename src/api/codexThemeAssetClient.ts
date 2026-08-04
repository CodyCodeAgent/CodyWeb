import { CodexApiError } from './codexErrors'
import { asRecord, fetchCodexResultRecord, jsonPostInit } from './codexHttpClient'

export type UploadedThemeAsset = {
  id: string
  url: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
}

export async function uploadThemeAsset(dataUrl: string): Promise<UploadedThemeAsset> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/theme-assets', {
    init: jsonPostInit({ dataUrl }),
    method: 'theme-assets/upload',
    networkErrorMessage: 'Theme image upload failed before it was sent',
    httpErrorMessage: 'Theme image upload failed',
    malformedMessage: 'Theme image upload returned malformed response',
  })
  const asset = asRecord(result.asset)
  if (
    !asset || typeof asset.id !== 'string' || typeof asset.url !== 'string' ||
    (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg' && asset.mimeType !== 'image/webp') ||
    typeof asset.byteSize !== 'number'
  ) {
    throw new CodexApiError('Theme image upload returned malformed response', {
      code: 'invalid_response', method: 'theme-assets/upload', status,
    })
  }
  return asset as UploadedThemeAsset
}
