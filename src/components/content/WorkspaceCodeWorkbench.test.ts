// @vitest-environment happy-dom
import { shallowMount, flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceCodeWorkbench from './WorkspaceCodeWorkbench.vue'

const { fetchWorkspaceDiff, fetchWorkspaceFile, fetchWorkspaceFiles, searchWorkspace } = vi.hoisted(() => ({
  fetchWorkspaceDiff: vi.fn(),
  fetchWorkspaceFile: vi.fn(),
  fetchWorkspaceFiles: vi.fn(),
  searchWorkspace: vi.fn(),
}))

vi.mock('../../api/codexWorkspaceResourcesClient', () => ({
  fetchWorkspaceDiff,
  fetchWorkspaceFile,
  fetchWorkspaceFiles,
  searchWorkspace,
}))

vi.mock('./WorkspaceMonacoEditor.vue', () => ({
  default: { name: 'WorkspaceMonacoEditor', template: '<div class="monaco-stub" />' },
  __isTeleport: false,
  __isSuspense: false,
}))

describe('WorkspaceCodeWorkbench', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchWorkspaceFiles.mockResolvedValue({ cwd: '/repo', root: '/repo', path: '', parentPath: '', entries: [], truncated: false })
    fetchWorkspaceFile.mockResolvedValue({ cwd: '/repo', root: '/repo', path: 'src/app.ts', name: 'app.ts', sizeBytes: 24, modifiedAtIso: '2026-08-07T00:00:00.000Z', content: 'const answer = 42\n', truncated: false, isBinary: false })
    fetchWorkspaceDiff.mockResolvedValue({ cwd: '/repo', repoRoot: '/repo', status: '', patch: '' })
    searchWorkspace.mockResolvedValue({ cwd: '/repo', root: '/repo', query: '', scope: 'files', path: '', items: [], truncated: false })
    sessionStorage.clear()
  })

  it('opens task changes inside the current thread route', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/thread/:threadId', name: 'thread', component: { template: '<div />' } }],
    })
    await router.push('/thread/thread-1?view=code')
    await router.isReady()
    const wrapper = shallowMount(WorkspaceCodeWorkbench, {
      props: {
        cwd: '/repo', threadId: 'thread-1',
        messages: [{
          id: 'change-1', role: 'system', text: '',
          tool: {
            kind: 'fileChange', title: 'Changed', status: 'completed', summary: '1 file changed', details: ['modified: src/app.ts'],
            output: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const answer = 1\n+const answer = 42',
          },
        }],
      },
      global: { plugins: [router] },
    })

    await flushPromises()
    expect(fetchWorkspaceFile).toHaveBeenCalledWith('/repo', 'src/app.ts', expect.any(AbortSignal))
    expect(wrapper.text()).toContain('app.ts')
    expect(router.currentRoute.value.query).toMatchObject({ view: 'code', path: 'src/app.ts' })
  })
})
