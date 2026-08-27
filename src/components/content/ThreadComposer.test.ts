// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ThreadComposer from './ThreadComposer.vue'

function mountComposer(overrides = {}) {
  return mount(ThreadComposer, {
    props: {
      activeThreadId: 'thread-1',
      models: ['gpt-5.5'],
      selectedModel: 'gpt-5.5',
      selectedReasoningEffort: 'high',
      collaborationModes: [
        {
          name: 'default',
          label: 'Default',
          mode: 'default',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          developerInstructions: null,
        },
      ],
      selectedCollaborationMode: 'default',
      selectedPermissionMode: 'current',
      selectedSubmitMode: 'queue',
      cwd: '/repo',
      ...overrides,
    },
    global: {
      stubs: {
        ComposerDropdown: true,
        IconTablerArrowUp: true,
        IconTablerPhoto: true,
        IconTablerPlayerStopFilled: true,
        IconTablerX: true,
      },
    },
  })
}

describe('ThreadComposer', () => {
  it('enables submit after typing and emits a normalized message payload', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="thread-composer-input"]')
    const submit = wrapper.get('[data-testid="thread-composer-submit"]')

    expect((submit.element as HTMLButtonElement).disabled).toBe(true)

    await input.setValue('  hello from composer  ')

    expect((submit.element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.get('[data-testid="thread-composer"]').trigger('submit')

    const emittedSubmit = wrapper.emitted('submit')
    expect(emittedSubmit?.[0]?.[0]).toEqual({
      text: 'hello from composer',
      images: [],
      skills: [],
      contexts: [],
    })
    expect((input.element as HTMLTextAreaElement).value).toBe('  hello from composer  ')
    const ack = emittedSubmit?.[0]?.[1] as { onAccepted: () => void }
    ack.onAccepted()
    await wrapper.vm.$nextTick()
    expect((input.element as HTMLTextAreaElement).value).toBe('')
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the composer disabled when no active thread is selected', async () => {
    const wrapper = mountComposer({ activeThreadId: '' })

    expect((wrapper.get('[data-testid="thread-composer-input"]').element as HTMLTextAreaElement).disabled).toBe(true)
    expect((wrapper.get('[data-testid="thread-composer-submit"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('emits submit and permission mode changes from the composer controls', async () => {
    const wrapper = mountComposer()
    const dropdowns = wrapper.findAllComponents({ name: 'ComposerDropdown' })

    await dropdowns[1]?.vm.$emit('update:modelValue', 'guide')
    await dropdowns[4]?.vm.$emit('update:modelValue', 'yolo')

    expect(wrapper.emitted('update:selected-submit-mode')).toEqual([['guide']])
    expect(wrapper.emitted('update:selected-permission-mode')).toEqual([['yolo']])
  })

  it('renders queued messages above the draft and emits queue actions', async () => {
    const wrapper = mountComposer({
      isTurnInProgress: true,
      queuedMessages: [
        {
          id: 'queued-1',
          threadId: 'thread-1',
          text: '比如这样',
          status: 'queued',
          createdAtIso: '2026-08-20T00:00:00.000Z',
        },
      ],
    })

    const item = wrapper.get('[data-testid="thread-composer-outbox-item"]')
    expect(item.text()).toContain('比如这样')
    expect(item.text()).toContain('Queued locally')
    expect(item.text()).toContain('Guide now')

    await item.find('.thread-composer-outbox-send').trigger('click')
    await item.find('.thread-composer-outbox-delete').trigger('click')

    expect(wrapper.emitted('sendQueuedMessageNow')).toEqual([[{ threadId: 'thread-1', messageId: 'queued-1' }]])
    expect(wrapper.emitted('deleteQueuedMessage')).toEqual([[{ threadId: 'thread-1', messageId: 'queued-1' }]])
  })

  it('places prompt library content into the draft without sending it', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="thread-composer-input"]')
    await input.setValue('Existing note')
    ;(input.element as HTMLTextAreaElement).setSelectionRange(13, 13)

    await wrapper.setProps({ promptInsertion: { id: 1, text: 'Reusable prompt', skills: [], mode: 'insert' } })

    expect((input.element as HTMLTextAreaElement).value).toBe('Existing note\n\nReusable prompt')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.setProps({ promptInsertion: { id: 2, text: 'Replacement', skills: [], mode: 'replace' } })
    expect((input.element as HTMLTextAreaElement).value).toBe('Replacement')
  })

  it('attaches a scenario package primary Skill to the next turn', async () => {
    const wrapper = mountComposer()
    const skill = {
      name: 'alert-triage', path: '/repo/.codex/skills/alert-triage/SKILL.md',
      displayName: 'Alert triage', description: 'Investigate structured alerts.',
    }
    await wrapper.setProps({ promptInsertion: {
      id: 1, text: 'Investigate the alert with evidence.', skills: [skill], mode: 'replace',
    } })
    await wrapper.get('[data-testid="thread-composer"]').trigger('submit')
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
      text: 'Investigate the alert with evidence.', skills: [skill],
    })
  })

  it('attaches an externally selected code range to the current thread composer', async () => {
    const wrapper = mountComposer()
    const context = {
      id: 'selection-1', kind: 'file' as const, label: '@file:src/app.ts#L1-L2', description: 'src/app.ts lines 1-2',
      content: 'Path: src/app.ts\nLines: 1-2\n\nconst answer = 42', createdAtIso: '2026-08-07T00:00:00.000Z',
      metadata: { path: 'src/app.ts', startLine: 1, endLine: 2 },
    }
    await wrapper.setProps({ contextInsertion: context })

    const submit = wrapper.get('[data-testid="thread-composer-submit"]')
    expect((submit.element as HTMLButtonElement).disabled).toBe(false)
    await wrapper.get('[data-testid="thread-composer"]').trigger('submit')
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ contexts: [context] })
  })

})
