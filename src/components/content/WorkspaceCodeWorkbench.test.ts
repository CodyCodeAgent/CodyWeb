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
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    fetchWorkspaceFiles.mockResolvedValue({ cwd: '/repo', root: '/repo', path: '', parentPath: '', entries: [], truncated: false })
    fetchWorkspaceFile.mockResolvedValue({ cwd: '/repo', root: '/repo', path: 'src/app.ts', name: 'app.ts', sizeBytes: 24, modifiedAtIso: '2026-08-07T00:00:00.000Z', content: 'const answer = 42\n', truncated: false, isBinary: false })
    fetchWorkspaceDiff.mockResolvedValue({ cwd: '/repo', repoRoot: '/repo', status: '', patch: '' })
    searchWorkspace.mockResolvedValue({ cwd: '/repo', root: '/repo', query: '', scope: 'files', path: '', items: [], truncated: false })
    sessionStorage.clear()
    localStorage.clear()
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

  it('opens conversation as a floating panel and lets the user dock it', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/thread/:threadId', name: 'thread', component: { template: '<div />' } }],
    })
    await router.push('/thread/thread-1?view=code')
    await router.isReady()
    const wrapper = shallowMount(WorkspaceCodeWorkbench, {
      props: { cwd: '/repo', threadId: 'thread-1', messages: [] },
      slots: { conversation: '<div class="conversation-slot">hello</div>' },
      global: { plugins: [router] },
    })
    await flushPromises()

    const trigger = wrapper.get('[aria-label="打开当前对话"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.code-chat-panel').exists()).toBe(false)

    await trigger.trigger('click')
    expect(wrapper.get('.code-chat-panel').attributes('data-mode')).toBe('floating')
    expect(wrapper.get('.conversation-slot').text()).toBe('hello')
    expect(wrapper.attributes('data-chat-open')).toBe('true')

    await wrapper.get('[aria-label="吸附到右侧"]').trigger('click')
    expect(wrapper.get('.code-chat-panel').attributes('data-mode')).toBe('docked')
    expect(wrapper.attributes('data-chat-mode')).toBe('docked')
    expect(localStorage.getItem('cody-code-chat-presentation')).toBe('docked')
  })

  it('closes only a floating conversation with Escape', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/thread/:threadId', name: 'thread', component: { template: '<div />' } }],
    })
    await router.push('/thread/thread-1?view=code')
    await router.isReady()
    const wrapper = shallowMount(WorkspaceCodeWorkbench, {
      props: { cwd: '/repo', threadId: 'thread-1', messages: [] },
      global: { plugins: [router] },
    })
    await flushPromises()
    await wrapper.get('[aria-label="打开当前对话"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.code-chat-panel').exists()).toBe(false)
  })

  it('restores the docked preference on desktop', async () => {
    localStorage.setItem('cody-code-chat-presentation', 'docked')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/thread/:threadId', name: 'thread', component: { template: '<div />' } }],
    })
    await router.push('/thread/thread-1?view=code')
    await router.isReady()
    const wrapper = shallowMount(WorkspaceCodeWorkbench, {
      props: { cwd: '/repo', threadId: 'thread-1', messages: [] },
      global: { plugins: [router] },
    })
    await flushPromises()

    await wrapper.get('[aria-label="打开当前对话"]').trigger('click')
    expect(wrapper.get('.code-chat-panel').attributes('data-mode')).toBe('docked')
    expect(wrapper.find('[aria-label="切换为浮窗"]').exists()).toBe(true)
  })

  it('uses a floating sheet on narrow screens even when docking is preferred', async () => {
    localStorage.setItem('cody-code-chat-presentation', 'docked')
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('1180px'), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/thread/:threadId', name: 'thread', component: { template: '<div />' } }],
    })
    await router.push('/thread/thread-1?view=code')
    await router.isReady()
    const wrapper = shallowMount(WorkspaceCodeWorkbench, {
      props: { cwd: '/repo', threadId: 'thread-1', messages: [] },
      global: { plugins: [router] },
    })
    await flushPromises()

    await wrapper.get('[aria-label="打开当前对话"]').trigger('click')
    expect(wrapper.get('.code-chat-panel').attributes('data-mode')).toBe('floating')
    expect(wrapper.find('[aria-label="吸附到右侧"]').exists()).toBe(false)
  })
})
