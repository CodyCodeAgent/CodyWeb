import type { RpcEnvelope } from '../types/codex'
import { CodexApiError, extractErrorMessage } from './codexErrors'
import { asRecord } from './protocolValueReaders'

export { asRecord } from './protocolValueReaders'

export type CodexJsonResponse = {
  payload: unknown
  status: number
}

export type CodexResultRecordResponse = {
  result: Record<string, unknown>
  status: number
}

export type CodexJsonRequestOptions = {
  acceptedStatuses?: number[]
  init?: RequestInit
  method: string
  networkErrorMessage: string
  httpErrorMessage: string
  /**
   * Browser-side deadline. The app-server has its own deadline too, but the
   * client must never leave an outbox item in "sending" forever if a proxy or
   * a torn-down page connection fails to return that response.
   */
  timeoutMs?: number
}

export type CodexQueryParams = Record<string, string | number | boolean | null | undefined>

export function jsonPostInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

export function queryPath(path: string, params: CodexQueryParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    query.set(key, String(value))
  }

  const serialized = query.toString()
  return serialized ? `${path}?${serialized}` : path
}

export async function fetchCodexJson(
  path: string,
  options: CodexJsonRequestOptions,
): Promise<CodexJsonResponse> {
  const timeoutMs = options.timeoutMs
  const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null
  const callerSignal = options.init?.signal
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const abortFromCaller = () => controller?.abort(callerSignal?.reason)
  if (controller && callerSignal) {
    if (callerSignal.aborted) abortFromCaller()
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true })
  }
  if (controller && timeoutMs && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  let response: Response
  try {
    const requestInit = controller
      ? { ...options.init, signal: controller.signal }
      : options.init
    response = await fetch(path, requestInit)
  } catch (error) {
    if (timedOut) {
      throw new CodexApiError(
        `${options.method} timed out after ${String(timeoutMs)}ms`,
        { code: 'timeout_error', method: options.method },
      )
    }
    throw new CodexApiError(
      error instanceof Error ? error.message : options.networkErrorMessage,
      { code: 'network_error', method: options.method },
    )
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (controller && callerSignal) callerSignal.removeEventListener('abort', abortFromCaller)
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  const acceptedStatuses = new Set(options.acceptedStatuses ?? [])
  if (!response.ok && !acceptedStatuses.has(response.status)) {
    throw new CodexApiError(
      extractErrorMessage(payload, `${options.httpErrorMessage} with HTTP ${response.status}`),
      {
        code: 'http_error',
        method: options.method,
        status: response.status,
      },
    )
  }

  return {
    payload,
    status: response.status,
  }
}

export function readRpcResult<T>(
  payload: unknown,
  status: number,
  method: string,
  malformedMessage: string,
): T {
  const envelope = payload as RpcEnvelope<T> | null
  if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) {
    throw new CodexApiError(malformedMessage, {
      code: 'invalid_response',
      method,
      status,
    })
  }
  return envelope.result
}

export function readEnvelopeResultRecord(
  payload: unknown,
  status: number,
  method: string,
  malformedMessage: string,
): Record<string, unknown> {
  const envelope = asRecord(payload)
  const result = asRecord(envelope?.result)
  if (!result) {
    throw new CodexApiError(malformedMessage, {
      code: 'invalid_response',
      method,
      status,
    })
  }
  return result
}

export async function fetchCodexResultRecord(
  path: string,
  options: CodexJsonRequestOptions & {
    malformedMessage: string
  },
): Promise<CodexResultRecordResponse> {
  const { payload, status } = await fetchCodexJson(path, options)
  return {
    result: readEnvelopeResultRecord(payload, status, options.method, options.malformedMessage),
    status,
  }
}
