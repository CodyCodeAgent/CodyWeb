import { describe, expect, it } from 'vitest'
import {
  appContentTitle,
  autoRefreshLabel,
  basenameFromPath,
  buildNewThreadFolderOptions,
  composerThreadContextId,
  directoryPickerInitialPath,
  filterAppConversationMessages,
  findNewThreadWorkspaceGroup,
  homeComposerBusyLabel,
  knownThreadIds,
  newThreadProjectLabel,
  normalizeAppMessageType,
  shouldShowThreadWorkLogAction,
  threadComposerBusyLabel,
} from './appShellRules'
import type { UiMessage, UiProjectGroup, UiThread } from '../types/codex'

function thread(overrides: Partial<UiThread> = {}): UiThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    projectName: 'project',
    cwd: '/workspace/project',
    createdAtIso: '2026-07-07T00:00:00.000Z',
    updatedAtIso: '2026-07-07T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
    ...overrides,
  }
}

function group(overrides: Partial<UiProjectGroup> = {}): UiProjectGroup {
  return {
    projectName: '/workspace/project',
    cwd: '/workspace/project',
    threads: [thread()],
    ...overrides,
  }
}

function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    text: 'hello',
    ...overrides,
  }
}

describe('app shell rules', () => {
  it('formats route and composer labels', () => {
    expect(appContentTitle({ isHomeRoute: true, selectedThread: thread({ title: 'Ignored' }) })).toBe('New thread')
    expect(appContentTitle({ isHomeRoute: false, isSettingsRoute: true, selectedThread: thread({ title: 'Ignored' }) })).toBe('Settings')
    expect(appContentTitle({ isHomeRoute: false, selectedThread: thread({ title: 'Active' }) })).toBe('Active')
    expect(appContentTitle({ isHomeRoute: false, selectedThread: null })).toBe('Choose a thread')
    expect(autoRefreshLabel({ isEnabled: true, secondsLeft: 3 })).toBe('Auto refresh in 3s')
    expect(autoRefreshLabel({ isEnabled: false, secondsLeft: 0 })).toBe('Enable 4s refresh')
    expect(composerThreadContextId({ isHomeRoute: true, selectedThreadId: 'thread-1' })).toBe('__new-thread__')
    expect(composerThreadContextId({ isHomeRoute: false, selectedThreadId: 'thread-1' })).toBe('thread-1')
    expect(shouldShowThreadWorkLogAction({
      isHomeRoute: false,
      isSettingsRoute: false,
      selectedThreadId: 'thread-1',
    })).toBe(true)
    expect(shouldShowThreadWorkLogAction({
      isHomeRoute: true,
      isSettingsRoute: false,
      selectedThreadId: 'thread-1',
    })).toBe(false)
    expect(shouldShowThreadWorkLogAction({
      isHomeRoute: false,
      isSettingsRoute: true,
      selectedThreadId: 'thread-1',
    })).toBe(false)
    expect(shouldShowThreadWorkLogAction({
      isHomeRoute: false,
      isSettingsRoute: false,
      selectedThreadId: '',
    })).toBe(false)
    expect(homeComposerBusyLabel(true)).toBe('Creating thread...')
    expect(threadComposerBusyLabel({ isSendingMessage: false, isSelectedThreadInProgress: true })).toBe('')
    expect(threadComposerBusyLabel({ isSendingMessage: true, isSelectedThreadInProgress: true })).toBe('Sending guidance...')
    expect(threadComposerBusyLabel({ isSendingMessage: true, isSelectedThreadInProgress: false })).toBe('Starting response...')
  })

  it('filters internal live activity messages from the conversation', () => {
    expect(normalizeAppMessageType(undefined, 'assistant')).toBe('assistant')
    expect(normalizeAppMessageType(' plan.live ', 'assistant')).toBe('plan.live')

    const visible = filterAppConversationMessages([
      message({ id: 'answer', messageType: 'agentMessage.live' }),
      message({ id: 'worked', messageType: 'worked' }),
      message({ id: 'activity', messageType: 'turnActivity.live' }),
      message({ id: 'reasoning', messageType: 'agentReasoning.live' }),
      message({ id: 'error', messageType: 'turnError.live' }),
      message({
        id: 'failed-outbox',
        role: 'user',
        messageType: 'userMessage.outbox.failed',
        outbox: { status: 'failed', lastError: 'request failed' },
      }),
    ])

    expect(visible.map((item) => item.id)).toEqual(['answer', 'worked'])
  })

  it('keeps queued and sending optimistic messages in the transcript', () => {
    const visible = filterAppConversationMessages([
      message({ id: 'queued', role: 'user', outbox: { status: 'queued' } }),
      message({ id: 'sending', role: 'user', outbox: { status: 'sending' } }),
    ])

    expect(visible.map((item) => item.id)).toEqual(['queued', 'sending'])
  })

  it('builds known thread ids and new-thread folder options', () => {
    const groups = [
      group({
        projectName: '/workspace/project-a',
        cwd: '/workspace/project-a',
        threads: [thread({ id: 'a', cwd: '/workspace/project-a' })],
      }),
      group({
        projectName: '/workspace/project-a-copy',
        cwd: '/workspace/project-a-copy',
        threads: [thread({ id: 'duplicate-cwd', cwd: '/workspace/project-a' })],
      }),
      group({
        projectName: '/workspace/project-b',
        cwd: '/workspace/project-b',
        threads: [thread({ id: 'b', cwd: '/workspace/project-b' })],
      }),
    ]

    expect(Array.from(knownThreadIds(groups)).sort()).toEqual(['a', 'b', 'duplicate-cwd'])
    expect(buildNewThreadFolderOptions({
      groups,
      projectDisplayNameById: {
        '/workspace/project-a': 'Project A',
        '/custom/project-c': 'Project C',
      },
      selectedCwd: '/custom/project-c',
    })).toEqual([
      { value: '/custom/project-c', label: 'Project C' },
      { value: '/workspace/project-a', label: 'Project A' },
      { value: '/workspace/project-b', label: 'project-b' },
    ])
  })

  it('finds workspace labels and directory initial paths', () => {
    const projectGroup = group({
      projectName: '/workspace/project-a',
      cwd: '/workspace/project-a',
      threads: [thread({ cwd: '/workspace/project-a/worktree' })],
    })

    expect(basenameFromPath('/workspace/project-a')).toBe('project-a')
    expect(directoryPickerInitialPath({
      newThreadCwd: '',
      selectedThread: thread({ cwd: '/workspace/current' }),
    })).toBe('/workspace/current')
    expect(findNewThreadWorkspaceGroup([projectGroup], '/workspace/project-a/worktree')).toBe(projectGroup)
    expect(newThreadProjectLabel({
      group: projectGroup,
      newThreadCwd: '/workspace/project-a/worktree',
      projectDisplayNameById: { '/workspace/project-a': 'Project A' },
    })).toBe('Project A')
    expect(newThreadProjectLabel({
      group: null,
      newThreadCwd: '/workspace/loose',
      projectDisplayNameById: {},
    })).toBe('loose')
  })
})
