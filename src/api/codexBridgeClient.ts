import type { ApprovalDecisionScope } from '@codycodeagent/cody-web-core/presentation'
import type { UiDirectoryListing } from '../types/codex'
import { CodexApiError } from './codexErrors'
import {
  asRecord,
  fetchCodexJson,
  jsonPostInit,
  queryPath,
  readEnvelopeResultRecord,
} from './codexHttpClient'

export type ServerRequestReplyBody = {
  id: number
  approvalScope?: ApprovalDecisionScope
  result?: unknown
  error?: {
    code?: number
    message: string
  }
}

export type UploadedLocalImage = {
  id: string
  name: string
  path: string
  url: string
  mimeType: string
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Image file could not be read'))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('Image file could not be read'))
    }
    reader.readAsDataURL(file)
  })
}

export async function respondServerRequest(body: ServerRequestReplyBody): Promise<void> {
  await fetchCodexJson('/codex-api/server-requests/respond', {
    init: jsonPostInit(body),
    method: 'server-requests/respond',
    networkErrorMessage: 'Failed to reply to server request',
    httpErrorMessage: 'Server request reply failed',
  })
}

export async function fetchPendingServerRequests(): Promise<unknown[]> {
  const { payload } = await fetchCodexJson('/codex-api/server-requests/pending', {
    method: 'server-requests/pending',
    networkErrorMessage: 'Pending server requests failed before request was sent',
    httpErrorMessage: 'Pending server requests failed',
  })
  const record = asRecord(payload)
  const data = record?.data
  return Array.isArray(data) ? data : []
}

export async function fetchDirectoryListing(path: string): Promise<UiDirectoryListing> {
  const normalizedPath = path.trim()

  const { payload, status } = await fetchCodexJson(queryPath('/codex-api/fs/directories', {
    path: normalizedPath || undefined,
  }), {
    method: 'fs/directories',
    networkErrorMessage: 'Directory listing failed before request was sent',
    httpErrorMessage: 'Directory listing failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'fs/directories', 'Directory listing returned malformed response')
  const directories = Array.isArray(result?.directories) ? result.directories : []
  const pathValue = typeof result?.path === 'string' ? result.path : ''
  const parentPath = typeof result?.parentPath === 'string' ? result.parentPath : pathValue

  return {
    path: pathValue,
    parentPath,
    directories: directories
      .map((entry) => {
        const record = asRecord(entry)
        const name = typeof record?.name === 'string' ? record.name : ''
        const entryPath = typeof record?.path === 'string' ? record.path : ''
        return name && entryPath ? { name, path: entryPath } : null
      })
      .filter((entry): entry is { name: string; path: string } => entry !== null),
  }
}

export async function uploadLocalImage(file: File): Promise<UploadedLocalImage> {
  const dataUrl = await readFileAsDataUrl(file)

  const { payload, status } = await fetchCodexJson('/codex-api/uploads/images', {
    init: jsonPostInit({
      name: file.name,
      mimeType: file.type,
      dataUrl,
    }),
    method: 'uploads/images',
    networkErrorMessage: 'Image upload failed before request was sent',
    httpErrorMessage: 'Image upload failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'uploads/images', 'Image upload returned malformed response')
  const id = typeof result?.id === 'string' ? result.id : ''
  const name = typeof result?.name === 'string' ? result.name : file.name
  const imagePath = typeof result?.path === 'string' ? result.path : ''
  const url = typeof result?.url === 'string' ? result.url : ''
  const mimeType = typeof result?.mimeType === 'string' ? result.mimeType : file.type

  if (!id || !imagePath || !url) {
    throw new CodexApiError('Image upload returned malformed response', {
      code: 'invalid_response',
      method: 'uploads/images',
      status,
    })
  }

  return { id, name, path: imagePath, url, mimeType }
}
