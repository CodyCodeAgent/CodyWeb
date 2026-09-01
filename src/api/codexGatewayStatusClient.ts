import type {
  UiApprovalGrantList,
  UiAuthSessionSnapshot,
  UiGatewayDiagnostics,
  UiSecurityAccessSnapshot,
  UiTrustedDeviceActionResult,
  UiTrustedDeviceList,
} from '../types/codex'
import { CodexApiError } from './codexErrors'
import {
  asRecord,
  fetchCodexJson,
  jsonPostInit,
  queryPath,
  readEnvelopeResultRecord,
  readRpcResult,
} from './codexHttpClient'

export async function fetchGatewayDiagnostics(): Promise<UiGatewayDiagnostics> {
  const { payload, status } = await fetchCodexJson('/codex-api/meta/diagnostics', {
    method: 'meta/diagnostics',
    networkErrorMessage: 'Gateway diagnostics failed before request was sent',
    httpErrorMessage: 'Gateway diagnostics failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'meta/diagnostics', 'Gateway diagnostics returned malformed response')
  const appServer = asRecord(result?.appServer)
  const methodCatalog = asRecord(result?.methodCatalog)
  if (
    !appServer ||
    !methodCatalog ||
    typeof result.generatedAtIso !== 'string' ||
    !Array.isArray(appServer.mcpServers) ||
    !Array.isArray(methodCatalog.methods) ||
    !Array.isArray(methodCatalog.notifications)
  ) {
    throw new CodexApiError('Gateway diagnostics returned malformed response', {
      code: 'invalid_response',
      method: 'meta/diagnostics',
      status,
    })
  }

  return result as UiGatewayDiagnostics
}

export async function fetchSecurityAccessSnapshot(): Promise<UiSecurityAccessSnapshot> {
  const { payload, status } = await fetchCodexJson('/codex-api/meta/access-security', {
    method: 'meta/access-security',
    networkErrorMessage: 'Security access status failed before request was sent',
    httpErrorMessage: 'Security access status failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'meta/access-security', 'Security access status returned malformed response')
  const auth = asRecord(result?.auth)
  const network = asRecord(result?.network)
  if (
    !auth ||
    !network ||
    typeof result.generatedAtIso !== 'string' ||
    typeof auth.enabled !== 'boolean' ||
    !Array.isArray(result.risks) ||
    !Array.isArray(result.recommendations)
  ) {
    throw new CodexApiError('Security access status returned malformed response', {
      code: 'invalid_response',
      method: 'meta/access-security',
      status,
    })
  }

  return result as UiSecurityAccessSnapshot
}

export async function fetchAuthSessionSnapshot(): Promise<UiAuthSessionSnapshot> {
  const { payload, status } = await fetchCodexJson('/auth/session', {
    acceptedStatuses: [401],
    method: 'auth/session',
    networkErrorMessage: 'Auth session status failed before request was sent',
    httpErrorMessage: 'Auth session status failed',
  })

  if (status === 401) {
    return { authenticated: false }
  }

  const result = asRecord(payload)
  if (!result || typeof result.authenticated !== 'boolean') {
    throw new CodexApiError('Auth session status returned malformed response', {
      code: 'invalid_response',
      method: 'auth/session',
      status,
    })
  }

  return result as UiAuthSessionSnapshot
}

export async function fetchApprovalGrants(cwd: string): Promise<UiApprovalGrantList> {
  const { payload, status } = await fetchCodexJson(queryPath('/codex-api/tooling/approval-grants', { cwd }), {
    method: 'tooling/approval-grants',
    networkErrorMessage: 'Approval grants failed before request was sent',
    httpErrorMessage: 'Approval grants failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'tooling/approval-grants', 'Approval grants returned malformed response')
  if (!Array.isArray(result.grants)) {
    throw new CodexApiError('Approval grants returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/approval-grants',
      status,
    })
  }

  return result as UiApprovalGrantList
}

export async function revokeApprovalGrant(cwd: string, grantId: string): Promise<UiApprovalGrantList> {
  const { payload, status } = await fetchCodexJson('/codex-api/tooling/approval-grants/revoke', {
    init: jsonPostInit({ cwd, grantId }),
    method: 'tooling/approval-grants/revoke',
    networkErrorMessage: 'Approval grant revoke failed before request was sent',
    httpErrorMessage: 'Approval grant revoke failed',
  })
  const result = readEnvelopeResultRecord(payload, status, 'tooling/approval-grants/revoke', 'Approval grant revoke returned malformed response')
  if (!Array.isArray(result.grants)) {
    throw new CodexApiError('Approval grant revoke returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/approval-grants/revoke',
      status,
    })
  }

  return result as UiApprovalGrantList
}

export async function fetchTrustedDevices(): Promise<UiTrustedDeviceList> {
  const { payload, status } = await fetchCodexJson('/auth/devices', {
    method: 'auth/devices',
    networkErrorMessage: 'Trusted devices failed before request was sent',
    httpErrorMessage: 'Trusted devices failed',
  })
  const result = asRecord(payload)
  if (!result || !Array.isArray(result.devices)) {
    throw new CodexApiError('Trusted devices returned malformed response', {
      code: 'invalid_response',
      method: 'auth/devices',
      status,
    })
  }

  return result as UiTrustedDeviceList
}

async function postDeviceTrustAction(path: string, method: string): Promise<UiTrustedDeviceActionResult> {
  const { payload, status } = await fetchCodexJson(path, {
    init: { method: 'POST' },
    method,
    networkErrorMessage: `${method} failed before request was sent`,
    httpErrorMessage: `${method} failed`,
  })
  const result = asRecord(payload)
  if (!result || typeof result.ok !== 'boolean' || typeof result.deviceId !== 'string') {
    throw new CodexApiError(`${method} returned malformed response`, {
      code: 'invalid_response',
      method,
      status,
    })
  }

  return result as UiTrustedDeviceActionResult
}

export async function trustCurrentDevice(): Promise<UiTrustedDeviceActionResult> {
  return postDeviceTrustAction('/auth/device/trust', 'auth/device/trust')
}

export async function revokeCurrentDeviceTrust(): Promise<UiTrustedDeviceActionResult> {
  return postDeviceTrustAction('/auth/device/revoke', 'auth/device/revoke')
}

export async function reloadMcpServers(): Promise<void> {
  const { payload, status } = await fetchCodexJson('/codex-api/runtime/mcp/reload', {
    init: jsonPostInit({}),
    method: 'config/mcpServer/reload',
    networkErrorMessage: 'MCP reload failed before request was sent',
    httpErrorMessage: 'MCP reload failed',
  })
  readRpcResult<unknown>(
    payload,
    status,
    'config/mcpServer/reload',
    'MCP reload returned malformed envelope',
  )
}
