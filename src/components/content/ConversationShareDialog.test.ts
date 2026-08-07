// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiMessage } from '../../types/codex'
import { useLocale } from '../../composables/useLocale'
import ConversationShareDialog from './ConversationShareDialog.vue'

const shareClient = vi.hoisted(() => ({
  createConversationShare: vi.fn(),
  fetchConversationShares: vi.fn(),
  revokeConversationShare: vi.fn(),
}))
const shareImageClient = vi.hoisted(() => ({ downloadConversationSharePng: vi.fn() }))

vi.mock('../../api/codexConversationShareClient', () => shareClient)
vi.mock('../../api/conversationShareImageClient', () => shareImageClient)
vi.mock('../../api/codexSettingsClient', () => ({
  fetchUserSetting: vi.fn().mockResolvedValue(null),
  writeUserSetting: vi.fn().mockResolvedValue(undefined),
}))

const messages: UiMessage[] = [
  { id: 'u1', turnId: 'turn-1', role: 'user', text: 'First question' },
  { id: 'a1', turnId: 'turn-1', role: 'assistant', text: 'First answer' },
  { id: 'u2', turnId: 'turn-2', role: 'user', text: 'Second question' },
  { id: 'a2', turnId: 'turn-2', role: 'assistant', text: 'Second answer' },
  { id: 'u3', turnId: 'turn-3', role: 'user', text: 'Third question' },
  { id: 'a3', turnId: 'turn-3', role: 'assistant', text: 'Third answer' },
]

beforeEach(() => {
  vi.clearAllMocks()
  useLocale().setLocale('en')
  shareClient.createConversationShare.mockResolvedValue({
    id: 'share-1', title: 'Shared thread', threadId: 'thread-1', publicPath: '/share/public-token',
    createdAtIso: '2026-08-07T00:00:00.000Z', expiresAtIso: null, messageCount: 4, turnCount: 2,
  })
  shareClient.fetchConversationShares.mockResolvedValue([])
  shareClient.revokeConversationShare.mockResolvedValue(undefined)
  shareImageClient.downloadConversationSharePng.mockResolvedValue(undefined)
})

describe('ConversationShareDialog', () => {
  it('selects non-contiguous turns and creates a public snapshot', async () => {
    const wrapper = mount(ConversationShareDialog, {
      props: { threadId: 'thread-1', threadTitle: 'Shared thread', projectName: 'project', messages },
    })
    await flushPromises()

    const options = wrapper.findAll('.share-turn-option input')
    expect(options).toHaveLength(3)
    await options[0]?.setValue(true)
    await options[2]?.setValue(true)
    await wrapper.get('.share-config').trigger('submit')
    await flushPromises()

    expect(shareClient.createConversationShare).toHaveBeenCalledTimes(1)
    const request = shareClient.createConversationShare.mock.calls.at(-1)?.[0]
    expect(request.expiresInDays).toBe(30)
    expect(request.snapshot.locale).toBe('en')
    expect(request.snapshot.selectedTurnIds).toEqual(['turn-1', 'turn-3'])
    expect(request.snapshot.messages.map((row: UiMessage) => row.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
    expect(wrapper.text()).toContain('Share link created')
    expect(wrapper.get('.share-link-field input').attributes('value')).toContain('/share/public-token')
    await wrapper.get('.share-success-actions button').trigger('click')
    await flushPromises()
    expect(shareImageClient.downloadConversationSharePng).toHaveBeenCalledWith('/share/public-token', 'Shared thread')
  })

  it('lists and revokes active shares with an explicit confirmation step', async () => {
    shareClient.fetchConversationShares.mockResolvedValue([{
      id: 'share-1', title: 'Existing share', threadId: 'thread-1', publicPath: '',
      createdAtIso: '2026-08-07T00:00:00.000Z', expiresAtIso: null, messageCount: 2, turnCount: 1,
    }])
    const wrapper = mount(ConversationShareDialog, {
      props: { threadId: 'thread-1', threadTitle: 'Shared thread', projectName: 'project', messages },
    })
    await flushPromises()

    await wrapper.findAll('.share-dialog-tabs button')[1]?.trigger('click')
    expect(wrapper.text()).toContain('Existing share')
    await wrapper.get('.share-manage-list button').trigger('click')
    expect(wrapper.text()).toContain('Confirm revoke')
    await wrapper.get('.share-revoke-confirm').trigger('click')
    await flushPromises()

    expect(shareClient.revokeConversationShare).toHaveBeenCalledWith('share-1')
    expect(wrapper.find('.share-manage-list').exists()).toBe(false)
  })

  it('creates a Chinese snapshot when the interface language is Chinese', async () => {
    useLocale().setLocale('zh-CN')
    const wrapper = mount(ConversationShareDialog, {
      props: { threadId: 'thread-1', threadTitle: '共享会话', projectName: 'project', messages },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('分享这个 Session')
    await wrapper.findAll('.share-turn-option input')[0]?.setValue(true)
    await wrapper.get('.share-config').trigger('submit')
    await flushPromises()

    const request = shareClient.createConversationShare.mock.calls.at(-1)?.[0]
    expect(request.snapshot.locale).toBe('zh-CN')
    expect(wrapper.text()).toContain('下载分享长图')
  })
})
