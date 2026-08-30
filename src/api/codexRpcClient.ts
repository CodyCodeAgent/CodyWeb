import type { RpcMethodCatalog } from '../types/codex'
import {
  fetchCodexJson,
  jsonPostInit,
  readRpcResult,
} from './codexHttpClient'

type RpcRequestBody = {
  method: string
  params?: unknown
}

const DEFAULT_RPC_TIMEOUT_MS = 25_000

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const body: RpcRequestBody = { method, params: params ?? null }
  const { payload, status } = await fetchCodexJson('/codex-api/rpc', {
    init: jsonPostInit(body),
    method,
    networkErrorMessage: `RPC ${method} failed before request was sent`,
    httpErrorMessage: `RPC ${method} failed`,
    timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
  })
  return readRpcResult<T>(payload, status, method, `RPC ${method} returned malformed envelope`)
}

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
