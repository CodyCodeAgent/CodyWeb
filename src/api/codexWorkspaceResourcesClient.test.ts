import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDefaultWorkspace,
  fetchWorkspaceDiff,
  fetchWorkspaceFiles,
  saveWorkspaceFile,
  searchWorkspace,
} from './codexWorkspaceResourcesClient'

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

describe('codex workspace resources client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the default workspace', async () => {
    mockFetch(new Response(JSON.stringify({
      result: { cwd: '/repo' },
    }), { status: 200 }))

    await expect(fetchDefaultWorkspace()).resolves.toEqual({ cwd: '/repo' })
  })

  it('loads workspace diffs and rejects malformed responses', async () => {
    mockFetch(new Response(JSON.stringify({
      result: {
        cwd: '/repo',
        repoRoot: '/repo',
        status: 'modified',
        patch: 'diff --git a/file b/file',
      },
    }), { status: 200 }))

    await expect(fetchWorkspaceDiff('/repo')).resolves.toMatchObject({
      cwd: '/repo',
      repoRoot: '/repo',
      patch: 'diff --git a/file b/file',
    })

    mockFetch(new Response(JSON.stringify({
      result: {
        cwd: '/repo',
        repoRoot: '/repo',
        status: 'modified',
      },
    }), { status: 200 }))

    await expect(fetchWorkspaceDiff('/repo')).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'invalid_response',
      method: 'tooling/diff',
    })
  })

  it('loads workspace file listings with optional paths', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({
      result: {
        root: '/repo',
        path: 'src',
        entries: [],
      },
    }), { status: 200 }))

    await expect(fetchWorkspaceFiles('/repo', 'src')).resolves.toMatchObject({
      root: '/repo',
      entries: [],
    })
    expect(fetchSpy).toHaveBeenCalledWith('/codex-api/tooling/workspace-files?cwd=%2Frepo&path=src', undefined)
  })

  it('saves workspace files through the tooling endpoint', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({
      result: {
        file: { path: 'src/app.ts' },
        checkpoint: { id: 'checkpoint-1' },
      },
    }), { status: 200 }))

    await expect(saveWorkspaceFile('/repo', 'src/app.ts', 'export {}')).resolves.toMatchObject({
      file: { path: 'src/app.ts' },
      checkpoint: { id: 'checkpoint-1' },
    })

    expect(fetchSpy).toHaveBeenCalledWith('/codex-api/tooling/workspace-file', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        cwd: '/repo',
        path: 'src/app.ts',
        content: 'export {}',
      }),
    }))
  })

  it('searches workspace files with a bounded read-only request', async () => {
    const fetchSpy = mockFetch(new Response(JSON.stringify({
      result: {
        cwd: '/repo', root: '/repo', query: 'needle', scope: 'content', path: '', truncated: false,
        items: [{ path: 'src/app.ts', line: 2, column: 4, preview: 'needle' }],
      },
    }), { status: 200 }))

    await expect(searchWorkspace('/repo', 'needle', 'content')).resolves.toMatchObject({
      query: 'needle',
      items: [expect.objectContaining({ path: 'src/app.ts', line: 2 })],
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/codex-api/tooling/workspace-search?cwd=%2Frepo&q=needle&scope=content&limit=80',
      undefined,
    )
  })
})
