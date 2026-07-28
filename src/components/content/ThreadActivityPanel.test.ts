// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ThreadActivityPanel from './ThreadActivityPanel.vue'
import { useLocale } from '../../composables/useLocale'
import type { UiMessage, UiServerRequest, UiServerRequestReply, UiToolingRollbackFileResult } from '../../types/codex'

const patchOutput = [
  'diff --git a/src/components/OldWidget.vue b/src/components/Widget.vue',
  'similarity index 80%',
  'rename from src/components/OldWidget.vue',
  'rename to src/components/Widget.vue',
  '--- a/src/components/OldWidget.vue',
  '+++ b/src/components/Widget.vue',
  '@@ -1,3 +1,4 @@',
  ' <template>',
  '-  <p>Old</p>',
  '+  <p>New</p>',
  '+  <button>Open</button>',
  ' </template>',
  'diff --git a/src/server/api.ts b/src/server/api.ts',
  '--- a/src/server/api.ts',
  '+++ b/src/server/api.ts',
  '@@ -10,3 +10,4 @@ export function load() {',
  '   return true',
  '+  // refreshed',
  ' }',
].join('\n')

function fileChangeMessage(): UiMessage {
  return {
    id: 'patch-1',
    role: 'system',
    text: '',
    tool: {
      kind: 'fileChange',
      title: 'File changes',
      status: 'completed',
      summary: '2 files changed',
      details: [
        'rename: src/components/OldWidget.vue -> src/components/Widget.vue',
        'update: src/server/api.ts',
      ],
      outputLabel: 'Diff',
      output: patchOutput,
    },
  }
}

function commandMessage(): UiMessage {
  return {
    id: 'cmd-1',
    role: 'system',
    text: '',
    tool: {
      kind: 'command',
      title: 'Command execution',
      status: 'completed',
      summary: 'npm test -- ThreadActivityPanel',
      details: ['cwd: /repo', 'exit: 0', 'duration: 1s'],
      outputLabel: 'Output',
      output: 'passed',
    },
  }
}

function approvalRequest(): UiServerRequest {
  return {
    id: 71,
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'cmd-approval',
    receivedAtIso: '2026-07-09T10:00:00.000Z',
    params: {
      command: 'npm test',
      cwd: '/repo',
      reason: 'Needs command approval',
    },
  }
}

function mountPanel(
  messages: UiMessage[] = [fileChangeMessage(), commandMessage()],
  pendingRequests: UiServerRequest[] = [],
): VueWrapper {
  return mount(ThreadActivityPanel, {
    attachTo: document.body,
    props: {
      messages,
      pendingRequests,
      cwd: '/repo',
      threadId: 'thread-1',
      onRespondServerRequest: (_payload: UiServerRequestReply) => undefined,
      onRollbackCompleted: (_result: UiToolingRollbackFileResult) => undefined,
    },
  })
}

beforeEach(() => {
  useLocale().setLocale('en')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ThreadActivityPanel', () => {
  it('keeps the work log collapsed behind the header trigger with a file-count badge', async () => {
    const wrapper = mountPanel()

    const trigger = wrapper.get('[data-testid="thread-work-log-trigger"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-label')).toBe('Open work log: 2 files · 1 command')
    expect(wrapper.get('[data-testid="thread-work-log-badge"]').text()).toBe('2')
    expect(wrapper.find('[data-testid="thread-work-log-panel"]').exists()).toBe(false)

    await trigger.trigger('click')

    expect(trigger.attributes('aria-expanded')).toBe('true')
    const panel = wrapper.get('[data-testid="thread-work-log-panel"]')
    expect(panel.text()).toContain('Work log')
    expect(panel.text()).toContain('2 changed files · 1 command')
    expect(panel.text()).toContain('2files')
    expect(panel.text()).toContain('1commands')
    expect(wrapper.findAll('[data-testid="thread-work-log-file"]')).toHaveLength(2)
  })

  it('surfaces long changed paths by filename, directory, search, and fullscreen diff', async () => {
    const wrapper = mountPanel()
    await wrapper.get('[data-testid="thread-work-log-trigger"]').trigger('click')

    const panel = wrapper.get('[data-testid="thread-work-log-panel"]')
    expect(panel.text()).toContain('Widget.vue')
    expect(panel.text()).toContain('src/components')

    await wrapper.get('[data-testid="thread-work-log-file-search"]').setValue('OldWidget')
    expect(wrapper.findAll('[data-testid="thread-work-log-file"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="thread-work-log-file"]').text()).toContain('Widget.vue')

    await wrapper.get('[data-testid="thread-work-log-fullscreen"]').trigger('click')
    const dialog = document.body.querySelector('[data-testid="thread-work-log-fullscreen-dialog"]')
    expect(dialog?.textContent).toContain('Widget.vue')
    expect(dialog?.textContent).toContain('src/components/Widget.vue')
  })

  it('emits scoped approval replies from action-required cards', async () => {
    const wrapper = mountPanel([], [approvalRequest()])
    const overlay = document.body.querySelector<HTMLElement>('[data-testid="thread-action-required-float"]')

    expect(overlay).not.toBeNull()
    expect(wrapper.element.contains(overlay)).toBe(false)
    expect(overlay?.textContent).toContain('Action required')
    expect(overlay?.textContent).toContain('Command approval')

    const workspaceButton = overlay?.querySelector<HTMLButtonElement>('[data-testid="thread-approval-scope"][data-scope="workspace"]')
    const declineButton = overlay?.querySelector<HTMLButtonElement>('[data-testid="thread-approval-decline"]')
    expect(workspaceButton).toBeTruthy()
    expect(declineButton).toBeTruthy()

    workspaceButton?.click()
    declineButton?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('respondServerRequest')).toEqual([
      [
        {
          id: 71,
          approvalScope: 'workspace',
          result: { decision: 'accept' },
        },
      ],
      [
        {
          id: 71,
          approvalScope: 'single',
          result: { decision: 'decline' },
        },
      ],
    ])
  })
})
