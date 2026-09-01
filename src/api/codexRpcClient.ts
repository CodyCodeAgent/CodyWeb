import type { RpcMethodCatalog } from '../types/codex'
import {
  fetchCodexJson,
} from './codexHttpClient'

export async function fetchRpcMethodCatalog(): Promise<string[]> {
  const { payload } = await fetchCodexJson('/codex-api/meta/methods', {
    method: 'meta/methods',
    networkErrorMessage: 'Method catalog failed before request was sent',
    httpErrorMessage: 'Method catalog failed',
  })
  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}

export async function fetchRpcNotificationCatalog(): Promise<string[]> {
  const { payload } = await fetchCodexJson('/codex-api/meta/notifications', {
    method: 'meta/notifications',
    networkErrorMessage: 'Notification catalog failed before request was sent',
    httpErrorMessage: 'Notification catalog failed',
  })
  const catalog = payload as RpcMethodCatalog
  return Array.isArray(catalog.data) ? catalog.data : []
}
