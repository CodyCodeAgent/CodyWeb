// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import MessageMarkdown from './MessageMarkdown.vue'

describe('MessageMarkdown', () => {
  it('copies code and toggles wrapping from accessible controls', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mount(MessageMarkdown, { props: { text: '```ts\nconst answer = 42\n```' } })

    await wrapper.get('[data-markdown-action="copy-code"]').trigger('click')
    expect(writeText).toHaveBeenCalledOnce()

    await wrapper.get('[data-markdown-action="wrap-code"]').trigger('click')
    expect(wrapper.get('[data-markdown-action="wrap-code"]').attributes('aria-label')).toBe('Wrap')
  })

  it('renders workspace file references as focused controls and emits internal locations', async () => {
    const wrapper = mount(MessageMarkdown, { props: { text: '`src/main.ts:42`', cwd: '/repo' } })
    const link = wrapper.get('[data-markdown-action="open-file"]')
    expect(link.attributes('data-file-path')).toBe('src/main.ts')
    expect(link.attributes('title')).toContain('Open src/main.ts')
    await link.trigger('click')
    expect(wrapper.emitted('openFile')).toEqual([[{ path: 'src/main.ts', line: 42 }]])
  })

  it('expands and collapses code blocks longer than ten lines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const text = `\`\`\`ts\n${Array.from({ length: 11 }, (_, index) => `const line${String(index)} = ${String(index)}`).join('\n')}\n\`\`\``
    const wrapper = mount(MessageMarkdown, { props: { text } })
    const shell = wrapper.get('.markdown-code-shell')
    expect(shell.classes()).toContain('is-collapsed')
    await wrapper.get('.markdown-code-expand [data-markdown-action="toggle-code"]').trigger('click')
    expect(shell.classes()).not.toContain('is-collapsed')
    expect(wrapper.get('.markdown-code-collapse').attributes('aria-expanded')).toBe('true')
    await wrapper.get('[data-markdown-action="copy-code"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('const line10 = 10'))
  })

  it('rewrites workspace image links through the safe asset endpoint', async () => {
    const wrapper = mount(MessageMarkdown, {
      props: {
        text: '[runtime diagram](/home/gouchao/code/life-csr/docs/arch/runtime.svg)',
        cwd: '/home/gouchao/code/life-csr',
      },
    })
    await nextTick()
    await Promise.resolve()

    const link = wrapper.get('a')
    expect(link.attributes('href')).toContain('/codex-api/tooling/workspace-asset?')
    expect(decodeURIComponent(link.attributes('href') ?? '')).toContain('path=/home/gouchao/code/life-csr/docs/arch/runtime.svg')
    expect(link.attributes('target')).toBe('_blank')
  })
})
