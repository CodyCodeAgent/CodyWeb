// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ThreadConversation from './ThreadConversation.vue'
import type { UiLiveOverlay, UiMessage } from '../../types/codex'
import { useTheme } from '../../theme/useTheme'

const settingsClientMock = vi.hoisted(() => ({
  fetchUserSetting: vi.fn().mockResolvedValue(null),
  writeUserSetting: vi.fn().mockResolvedValue({ key: '', value: null, updatedAtIso: '' }),
}))
const tokenUsageClientMock = vi.hoisted(() => ({
  fetchDailyTokenUsage: vi.fn().mockResolvedValue({
    cwd: '', repoRoot: '', generatedAtIso: '2026-08-02T12:00:00.000Z', date: '2026-08-02', timezoneOffsetMinutes: -480,
    inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000, tokenUsageEventCount: 1,
    threadCount: 1, turnCount: 1, costUsd: null, costEventCount: 0,
    source: 'reconciled-rollouts', lastReconciledAtIso: '2026-08-02T12:00:00.000Z',
  }),
}))

vi.mock('../../api/codexSettingsClient', () => settingsClientMock)
vi.mock('../../api/codexTokenUsageClient', () => tokenUsageClientMock)

function message(index: number, overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: `message-${String(index)}`,
    role: 'assistant',
    text: `Message ${String(index)}`,
    ...overrides,
  }
}

function mountConversation(input: {
  messages?: UiMessage[]
  liveOverlay?: UiLiveOverlay | null
  isLoading?: boolean
  scrollState?: {
    scrollTop: number
    isAtBottom: boolean
    scrollRatio?: number
  } | null
} = {}) {
  return mount(ThreadConversation, {
    props: {
      messages: input.messages ?? [],
      pendingRequests: [],
      liveOverlay: input.liveOverlay ?? null,
      isLoading: input.isLoading ?? false,
      loadError: '',
      activeThreadId: 'thread-1',
      threadTitle: 'Loading state test',
      scrollState: input.scrollState ?? null,
    },
  })
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

describe('ThreadConversation', () => {
  it('renders one abstract identity avatar per consecutive speaker group for avatar skins', async () => {
    const theme = useTheme()
    theme.setSkin('qq-2007')
    try {
      const wrapper = mountConversation({
        messages: [
          message(1, { role: 'user', text: 'First' }),
          message(2, { role: 'user', text: 'Second' }),
          message(3, { role: 'assistant', text: 'Reply one' }),
          message(4, { role: 'system', text: 'Recorded', messageType: 'worked' }),
          message(5, { role: 'assistant', text: 'Reply two' }),
          message(6, {
            role: 'assistant',
            text: '',
            tool: { kind: 'command', title: 'Command', status: 'completed', summary: 'Done', details: [] },
          }),
        ],
      })

      expect(wrapper.findAll('.message-identity-user')).toHaveLength(1)
      expect(wrapper.findAll('.message-identity-assistant')).toHaveLength(1)
      expect(wrapper.get('.message-identity-assistant summary').attributes('aria-label')).toContain('Cody')

      const identityRows = wrapper.findAll('.message-row[data-identity-layout="avatars"]')
      expect(identityRows).toHaveLength(5)
      expect(wrapper.findAll('.message-identity-slot')).toHaveLength(5)
      expect(identityRows[0].element.children[0]?.classList.contains('message-stack')).toBe(true)
      expect(identityRows[0].element.children[1]?.classList.contains('message-identity-slot')).toBe(true)
      expect(identityRows[2].element.children[0]?.classList.contains('message-identity-slot')).toBe(true)
      expect(identityRows[2].element.children[1]?.classList.contains('message-stack')).toBe(true)
      expect(identityRows[4].find('.message-identity').exists()).toBe(false)
      expect(identityRows[4].get('.message-body').attributes('data-has-tool')).toBe('true')
    } finally {
      theme.setSkin('control-tower')
    }
  })

  it('groups consecutive file changes into one compact card on the assistant content lane', () => {
    const theme = useTheme()
    theme.setSkin('qq-2007')
    try {
      const fileChange = (id: string, count: number): UiMessage => ({
        id,
        role: 'system',
        text: '',
        tool: {
          kind: 'fileChange',
          title: 'File changes',
          status: 'completed',
          summary: `${String(count)} files changed`,
          details: ['status: completed', ...Array.from({ length: count }, (_, index) => `update: src/${id}-${String(index + 1)}.ts`)],
          output: `diff --git a/${id} b/${id}`,
          outputLabel: 'Diff',
        },
      })
      const wrapper = mountConversation({
        messages: [
          message(1, { text: 'Starting the focused change.' }),
          fileChange('change-one', 4),
          fileChange('change-two', 3),
          message(4, { text: 'Validation complete.' }),
        ],
      })

      const cards = wrapper.findAll('[data-testid="file-change-group-card"]')
      expect(cards).toHaveLength(1)
      expect(cards[0].attributes('data-update-count')).toBe('2')
      expect(cards[0].text()).toContain('Changed')
      expect(cards[0].text()).toContain('7 files')
      expect(cards[0].text()).toContain('2 updates')
      expect(cards[0].element.hasAttribute('open')).toBe(false)
      expect(cards[0].findAll('.file-change-group-update')).toHaveLength(2)
      expect(wrapper.findAll('[data-testid="conversation-message"]')).toHaveLength(3)

      const groupRow = wrapper.get('[data-message-id="change-one"] .message-row')
      expect(groupRow.attributes('data-identity-layout')).toBe('avatars')
      expect(groupRow.find('.message-identity-slot').exists()).toBe(true)
      expect(groupRow.find('.message-identity').exists()).toBe(false)
    } finally {
      theme.setSkin('control-tower')
    }
  })

  it('renders a dedicated accessible loading page before the first message snapshot arrives', () => {
    const wrapper = mountConversation({ isLoading: true })
    const loadingPage = wrapper.get('[data-testid="conversation-loading-page"]')

    expect(loadingPage.attributes('role')).toBe('status')
    expect(loadingPage.attributes('aria-busy')).toBe('true')
    expect(loadingPage.text()).toContain('Loading conversation')
    expect(loadingPage.text()).toContain('Loading state test')
    expect(wrapper.find('[data-testid="conversation-list"]').exists()).toBe(false)
  })

  it('renders context compaction history as a clear session divider', () => {
    const wrapper = mountConversation({
      messages: [
        message(1, {
          messageType: 'contextCompaction',
          tool: {
            kind: 'context',
            title: 'Context compaction',
            status: 'recorded',
            summary: 'Context was compacted',
            details: [],
          },
        }),
      ],
    })

    const divider = wrapper.get('[data-testid="context-compaction-divider"]')
    expect(divider.attributes('role')).toBe('status')
    expect(divider.text()).toContain('Context compacted')
    expect(divider.text()).toContain('Older context was summarized')
    expect(wrapper.find('.tool-timeline-card').exists()).toBe(false)
  })

  it('renders long threads in a recent-message window and expands earlier rows on demand', async () => {
    const messages = Array.from({ length: 120 }, (_, index) => message(index + 1))
    const wrapper = mountConversation({ messages })

    const renderedMessages = () => wrapper.findAll('[data-testid="conversation-message"]')
    expect(renderedMessages()).toHaveLength(80)
    expect(renderedMessages()[0].attributes('data-message-id')).toBe('message-41')
    expect(wrapper.get('[data-testid="conversation-history-button"]').text()).toContain('Show 40 earlier messages')

    await wrapper.get('[data-testid="conversation-history-button"]').trigger('click')

    expect(renderedMessages()).toHaveLength(120)
    expect(renderedMessages()[0].attributes('data-message-id')).toBe('message-1')
    expect(wrapper.find('[data-testid="conversation-history-button"]').exists()).toBe(false)
  })

  it('keeps copy affordance on the last assistant response when messages are windowed', () => {
    const messages = Array.from({ length: 120 }, (_, index) => message(index + 1))
    const wrapper = mountConversation({ messages })

    const copyButtons = wrapper.findAll('[data-testid="conversation-copy-button"]')

    expect(copyButtons).toHaveLength(1)
    expect(copyButtons[0].attributes('aria-label')).toBe('Copy message')
    expect(wrapper.find('[data-message-id="message-120"] [data-testid="conversation-copy-button"]').exists()).toBe(true)
  })

  it('keeps the newest message visible when a long thread receives another update', async () => {
    const messages = Array.from({ length: 120 }, (_, index) => message(index + 1))
    const wrapper = mountConversation({ messages })

    expect(wrapper.find('[data-message-id="message-120"]').exists()).toBe(true)
    expect(wrapper.find('[data-message-id="message-40"]').exists()).toBe(false)

    await wrapper.setProps({
      messages: [
        ...messages,
        message(121, { text: 'Latest persisted response' }),
      ],
    })
    await nextTick()

    const renderedMessages = wrapper.findAll('[data-testid="conversation-message"]')
    expect(renderedMessages).toHaveLength(80)
    expect(renderedMessages[0].attributes('data-message-id')).toBe('message-42')
    expect(renderedMessages.at(-1)?.attributes('data-message-id')).toBe('message-121')
    expect(wrapper.get('[data-testid="conversation-history-button"]').text()).toContain('41 hidden')
  })

  it('preserves the current viewport when new output arrives while reading history', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(index + 1))
    const wrapper = mountConversation({
      messages,
      scrollState: { scrollTop: 320, scrollRatio: 0.4, isAtBottom: false },
    })
    const list = wrapper.get('[data-testid="conversation-list"]').element as HTMLElement

    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      value: 1200,
    })
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      value: 400,
    })
    list.scrollTop = 320

    await wrapper.setProps({
      messages: [
        ...messages,
        message(21, { text: 'Streaming below the viewport' }),
      ],
    })
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      value: 1400,
    })
    await nextTick()
    await waitForAnimationFrame()

    expect(list.scrollTop).toBe(320)
  })

  it('stops following live output immediately after the user scrolls up', async () => {
    const wrapper = mountConversation({
      messages: Array.from({ length: 20 }, (_, index) => message(index + 1)),
      scrollState: { scrollTop: 800, scrollRatio: 1, isAtBottom: true },
    })
    const list = wrapper.get('[data-testid="conversation-list"]').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 })
    list.scrollTop = 300

    await wrapper.get('[data-testid="conversation-list"]').trigger('scroll')
    expect(wrapper.find('.conversation-scroll-bottom').exists()).toBe(true)

    await wrapper.setProps({
      liveOverlay: {
        activityLabel: 'Writing',
        activityDetails: [],
        reasoningText: 'More output below the viewport',
        errorText: '',
      },
    })
    await nextTick()
    await waitForAnimationFrame()
    await waitForAnimationFrame()

    expect(list.scrollTop).toBe(300)
  })

  it('auto-loads earlier messages when scrolling near the top of a long thread', async () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index + 1))
    const wrapper = mountConversation({ messages })
    const list = wrapper.get('[data-testid="conversation-list"]').element as HTMLElement

    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => wrapper.findAll('[data-testid="conversation-message"]').length >= 160 ? 3200 : 2000,
    })
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      value: 600,
    })
    list.scrollTop = 0

    expect(wrapper.findAll('[data-testid="conversation-message"]')).toHaveLength(80)
    expect(wrapper.find('[data-message-id="message-121"]').exists()).toBe(true)

    await wrapper.get('[data-testid="conversation-list"]').trigger('scroll')
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      value: 3200,
    })
    await nextTick()
    await nextTick()

    const renderedMessages = wrapper.findAll('[data-testid="conversation-message"]')
    expect(renderedMessages).toHaveLength(160)
    expect(renderedMessages[0].attributes('data-message-id')).toBe('message-41')
    expect(wrapper.get('[data-testid="conversation-history-button"]').text()).toContain('40 hidden')
    expect(list.scrollTop).toBe(1200)
  })

  it('resets the visible history window when switching threads', async () => {
    const firstThreadMessages = Array.from({ length: 120 }, (_, index) => message(index + 1, {
      id: `first-${String(index + 1)}`,
    }))
    const secondThreadMessages = Array.from({ length: 160 }, (_, index) => message(index + 1, {
      id: `second-${String(index + 1)}`,
    }))
    const wrapper = mountConversation({
      messages: firstThreadMessages,
    })

    await wrapper.get('[data-testid="conversation-history-button"]').trigger('click')
    expect(wrapper.findAll('[data-testid="conversation-message"]')).toHaveLength(120)

    await wrapper.setProps({
      activeThreadId: 'thread-2',
      messages: secondThreadMessages,
      scrollState: null,
    })
    await nextTick()

    const renderedMessages = wrapper.findAll('[data-testid="conversation-message"]')
    expect(renderedMessages).toHaveLength(80)
    expect(renderedMessages[0].attributes('data-message-id')).toBe('second-81')
    expect(wrapper.get('[data-testid="conversation-history-button"]').text()).toContain('Show 80 earlier messages')
  })

  it('shows initial live reasoning details without waiting for another realtime update', () => {
    const wrapper = mountConversation({
      liveOverlay: {
        activityLabel: 'Thinking',
        activityDetails: ['Reading repo files'],
        reasoningText: 'Inspecting the current implementation.',
        errorText: '',
      },
    })

    expect(wrapper.get('[data-testid="conversation-live-overlay-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="conversation-live-overlay-details"]').text()).toContain('Reading repo files')
    expect(wrapper.get('[data-testid="conversation-live-overlay-reasoning"]').text()).toBe('Inspecting the current implementation.')
  })
})
