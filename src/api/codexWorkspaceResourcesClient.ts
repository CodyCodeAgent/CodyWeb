import type {
  UiDefaultWorkspace,
  UiPortsSnapshot,
  UiPreviewProbe,
  UiPreviewScreenshot,
  UiToolingDiffSnapshot,
  UiWorkspaceFileContent,
  UiWorkspaceFileList,
  UiWorkspaceFileWriteResult,
  UiWorkspaceSearchResult,
  UiWorkspaceSearchScope,
  UiWorkspaceSecuritySnapshot,
  UiWorkspaceSnapshot,
  UiWorkspaceValidationRunHistory,
} from '../types/codex'
import { CodexApiError } from './codexErrors'
import {
  asRecord,
  fetchCodexResultRecord,
  jsonPostInit,
  queryPath,
} from './codexHttpClient'

export async function fetchWorkspaceSnapshot(cwd: string): Promise<UiWorkspaceSnapshot> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/workspace-snapshot', { cwd }), {
    method: 'tooling/workspace-snapshot',
    networkErrorMessage: 'Workspace snapshot failed before request was sent',
    httpErrorMessage: 'Workspace snapshot failed',
    malformedMessage: 'Workspace snapshot returned malformed response',
  })
  const gitStatus = asRecord(result?.gitStatus)

  if (typeof result.cwd !== 'string' || typeof result.repoRoot !== 'string' || !gitStatus) {
    throw new CodexApiError('Workspace snapshot returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-snapshot',
      status,
    })
  }

  return result as UiWorkspaceSnapshot
}

export async function fetchWorkspaceSecuritySnapshot(cwd: string): Promise<UiWorkspaceSecuritySnapshot> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/workspace-security', { cwd }), {
    method: 'tooling/workspace-security',
    networkErrorMessage: 'Workspace security scan failed before request was sent',
    httpErrorMessage: 'Workspace security scan failed',
    malformedMessage: 'Workspace security scan returned malformed response',
  })
  if (!Array.isArray(result.findings) || typeof result.generatedAtIso !== 'string') {
    throw new CodexApiError('Workspace security scan returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-security',
      status,
    })
  }

  return result as UiWorkspaceSecuritySnapshot
}

export async function fetchWorkspaceDiff(cwd: string): Promise<UiToolingDiffSnapshot> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/diff', { cwd }), {
    method: 'tooling/diff',
    networkErrorMessage: 'Workspace diff failed before request was sent',
    httpErrorMessage: 'Workspace diff failed',
    malformedMessage: 'Workspace diff returned malformed response',
  })
  if (
    typeof result.cwd !== 'string' ||
    typeof result.repoRoot !== 'string' ||
    typeof result.status !== 'string' ||
    typeof result.patch !== 'string'
  ) {
    throw new CodexApiError('Workspace diff returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/diff',
      status,
    })
  }

  return result as UiToolingDiffSnapshot
}

export async function fetchDefaultWorkspace(): Promise<UiDefaultWorkspace> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/tooling/default-workspace', {
    method: 'tooling/default-workspace',
    networkErrorMessage: 'Default workspace failed before request was sent',
    httpErrorMessage: 'Default workspace failed',
    malformedMessage: 'Default workspace returned malformed response',
  })
  if (typeof result.cwd !== 'string') {
    throw new CodexApiError('Default workspace returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/default-workspace',
      status,
    })
  }

  return result as UiDefaultWorkspace
}

export async function fetchWorkspacePorts(cwd: string): Promise<UiPortsSnapshot> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/ports', { cwd }), {
    method: 'tooling/ports',
    networkErrorMessage: 'Ports snapshot failed before request was sent',
    httpErrorMessage: 'Ports snapshot failed',
    malformedMessage: 'Ports snapshot returned malformed response',
  })
  if (!Array.isArray(result.ports)) {
    throw new CodexApiError('Ports snapshot returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/ports',
      status,
    })
  }

  return result as UiPortsSnapshot
}

export async function probeWorkspacePreview(cwd: string, url: string): Promise<UiPreviewProbe> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/tooling/preview-probe', {
    init: jsonPostInit({ cwd, url }),
    method: 'tooling/preview-probe',
    networkErrorMessage: 'Preview probe failed before request was sent',
    httpErrorMessage: 'Preview probe failed',
    malformedMessage: 'Preview probe returned malformed response',
  })
  if (typeof result.url !== 'string' || typeof result.status !== 'string') {
    throw new CodexApiError('Preview probe returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/preview-probe',
      status,
    })
  }

  return result as UiPreviewProbe
}

export async function captureWorkspacePreviewScreenshot(
  cwd: string,
  url: string,
  options: { width?: number; height?: number } = {},
): Promise<UiPreviewScreenshot> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/tooling/preview-screenshot', {
    init: jsonPostInit({
      cwd,
      url,
      width: options.width,
      height: options.height,
    }),
    method: 'tooling/preview-screenshot',
    networkErrorMessage: 'Preview screenshot failed before request was sent',
    httpErrorMessage: 'Preview screenshot failed',
    malformedMessage: 'Preview screenshot returned malformed response',
  })
  if (typeof result.url !== 'string' || typeof result.dataUrl !== 'string' || typeof result.source !== 'string') {
    throw new CodexApiError('Preview screenshot returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/preview-screenshot',
      status,
    })
  }

  return result as UiPreviewScreenshot
}

export async function fetchWorkspaceValidationRuns(cwd: string, limit = 10): Promise<UiWorkspaceValidationRunHistory> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/validation-runs', {
    cwd,
    limit: Math.max(1, Math.min(limit, 50)),
  }), {
    method: 'tooling/validation-runs',
    networkErrorMessage: 'Validation runs failed before request was sent',
    httpErrorMessage: 'Validation runs failed',
    malformedMessage: 'Validation runs returned malformed response',
  })
  if (!Array.isArray(result.runs) || typeof result.generatedAtIso !== 'string') {
    throw new CodexApiError('Validation runs returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/validation-runs',
      status,
    })
  }

  return result as UiWorkspaceValidationRunHistory
}

export async function fetchWorkspaceFiles(cwd: string, path = ''): Promise<UiWorkspaceFileList> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/workspace-files', {
    cwd,
    path: path || undefined,
  }), {
    method: 'tooling/workspace-files',
    networkErrorMessage: 'Workspace files failed before request was sent',
    httpErrorMessage: 'Workspace files failed',
    malformedMessage: 'Workspace files returned malformed response',
  })
  if (typeof result.root !== 'string' || !Array.isArray(result.entries)) {
    throw new CodexApiError('Workspace files returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-files',
      status,
    })
  }

  return result as UiWorkspaceFileList
}

export async function fetchWorkspaceFile(cwd: string, path: string, signal?: AbortSignal): Promise<UiWorkspaceFileContent> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/workspace-file', { cwd, path }), {
    init: signal ? { signal } : undefined,
    method: 'tooling/workspace-file',
    networkErrorMessage: 'Workspace file failed before request was sent',
    httpErrorMessage: 'Workspace file failed',
    malformedMessage: 'Workspace file returned malformed response',
  })
  if (typeof result.path !== 'string' || typeof result.content !== 'string') {
    throw new CodexApiError('Workspace file returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-file',
      status,
    })
  }

  return result as UiWorkspaceFileContent
}

export async function searchWorkspace(
  cwd: string,
  query: string,
  scope: UiWorkspaceSearchScope,
  path = '',
  limit = 80,
  signal?: AbortSignal,
): Promise<UiWorkspaceSearchResult> {
  const { result, status } = await fetchCodexResultRecord(queryPath('/codex-api/tooling/workspace-search', {
    cwd,
    q: query,
    scope,
    path: path || undefined,
    limit: Math.max(1, Math.min(limit, 200)),
  }), {
    init: signal ? { signal } : undefined,
    method: 'tooling/workspace-search',
    networkErrorMessage: 'Workspace search failed before request was sent',
    httpErrorMessage: 'Workspace search failed',
    malformedMessage: 'Workspace search returned malformed response',
  })
  if (!Array.isArray(result.items) || typeof result.query !== 'string' || typeof result.scope !== 'string') {
    throw new CodexApiError('Workspace search returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-search',
      status,
    })
  }
  return result as UiWorkspaceSearchResult
}

export async function saveWorkspaceFile(
  cwd: string,
  path: string,
  content: string,
): Promise<UiWorkspaceFileWriteResult> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/tooling/workspace-file', {
    init: jsonPostInit({ cwd, path, content }),
    method: 'tooling/workspace-file:write',
    networkErrorMessage: 'Workspace file save failed before request was sent',
    httpErrorMessage: 'Workspace file save failed',
    malformedMessage: 'Workspace file save returned malformed response',
  })
  const file = asRecord(result?.file)
  const checkpoint = asRecord(result?.checkpoint)
  if (!file || !checkpoint || typeof file.path !== 'string' || typeof checkpoint.id !== 'string') {
    throw new CodexApiError('Workspace file save returned malformed response', {
      code: 'invalid_response',
      method: 'tooling/workspace-file:write',
      status,
    })
  }

  return result as UiWorkspaceFileWriteResult
}
