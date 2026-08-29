import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VISIBLE_MESSAGE_COUNT,
  buildConversationScrollMetrics,
  buildConversationScrollState,
  hiddenMessageCount,
  nextVisibleMessageCount,
  normalizedConversationBottomLockFrames,
  normalizedVisibleMessageCount,
  preservedConversationScrollTop,
  restoredConversationScrollTop,
  shouldLockConversationToBottom,
  shouldPreserveConversationViewport,
  shouldRestoreConversationToBottom,
  visibleMessageStartIndex,
} from '@codycodeagent/cody-web-core/conversation'
import type { UiMessage, UiServerRequest, UiToolTimelineEntry } from '../types/codex'
import {
  buildApprovalDecisionReply,
  buildApprovalScopeReply,
  buildConversationRequestCards,
  buildCopyText,
  buildCopyTextAt,
  buildEmptyServerRequestReply,
  buildRejectedServerRequestReply,
  buildToolCallFailureReply,
  buildToolCallSuccessReply,
  buildToolCopyText,
  buildToolUserInputReply,
  conversationRequestActionKeyPrefix,
  conversationRequestKind,
  hasLiveOverlayDetails,
  historyPageButtonLabel,
  isConversationApprovalRequestKind,
  isCopyableMessage,
  liveOverlayDetailsToggleLabel,
  messageCopyAriaLabel,
  messageCopyTitle,
  readToolQuestionAnswer,
  readToolQuestionOtherAnswer,
  readToolQuestions,
  shouldShowBlockingConversationLoadError,
  shouldShowBlockingConversationLoading,
  shouldShowConversationRefreshStatus,
  shouldShowInlineConversationLoadError,
  shouldShowCopyButton,
  shouldShowScrollToBottomButton,
  shouldShowToolQuestionText,
  toolQuestionKey,
  toolQuestionTitle,
  visibleMessageWindowSummary,
} from './threadConversationRules'

function tool(overrides: Partial<UiToolTimelineEntry> = {}): UiToolTimelineEntry {
  return {
    kind: 'command',
    title: 'Shell command',
    status: 'completed',
    summary: 'npm test',
    details: ['cwd: /repo', 'exit: 0'],
    outputLabel: 'Output',
    output: 'Tests passed',
    ...overrides,
  }
}

function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    text: 'Answer',
    ...overrides,
  }
}

function serverRequest(overrides: Partial<UiServerRequest> = {}): UiServerRequest {
  return {
    id: 42,
    method: 'item/tool/requestUserInput',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    receivedAtIso: '2026-07-07T12:00:00.000Z',
    params: {},
    ...overrides,
  }
}

describe('thread conversation rules', () => {
  it('builds copy text from tool, message, skills, and images', () => {
    expect(buildToolCopyText(tool())).toBe([
      'Shell command: npm test',
      'Status: Completed',
      'cwd: /repo\nexit: 0',
      'Output:\nTests passed',
    ].join('\n'))

    expect(buildCopyText(message({
      text: '  Answer body  ',
      tool: tool({ output: '  ' }),
      skills: [
        { name: 'review', path: '/skills/review', description: '', displayName: 'Review' },
        { name: ' ', path: '/skills/skip', description: '', displayName: 'Skip' },
      ],
      images: [' image-a.png ', ''],
    }))).toBe([
      'Shell command: npm test\nStatus: Completed\ncwd: /repo\nexit: 0',
      'Answer body',
      '$review',
      ' image-a.png ',
    ].join('\n\n'))
  })

  it('excludes worked summaries and blank messages from copy actions', () => {
    expect(isCopyableMessage(message({ messageType: 'worked' }))).toBe(false)
    expect(isCopyableMessage(message({ text: ' ', images: [], skills: [] }))).toBe(false)
    expect(isCopyableMessage(message({ text: 'copy me' }))).toBe(true)
  })

  it('shows copy buttons only for the last adjacent assistant response', () => {
    const messages = [
      message({ id: 'user', role: 'user', text: 'Question' }),
      message({ id: 'tool', role: 'assistant', text: '', tool: tool() }),
      message({ id: 'assistant', role: 'assistant', text: 'Answer' }),
      message({ id: 'next-user', role: 'user', text: 'Next question' }),
    ]

    expect(shouldShowCopyButton(messages, messages[0], 0)).toBe(true)
    expect(shouldShowCopyButton(messages, messages[1], 1)).toBe(false)
    expect(shouldShowCopyButton(messages, messages[2], 2)).toBe(true)
    expect(shouldShowCopyButton(messages, messages[3], 3)).toBe(true)
    expect(messageCopyAriaLabel(false)).toBe('Copy message')
    expect(messageCopyAriaLabel(true)).toBe('Copied message')
    expect(messageCopyTitle(false)).toBe('Copy message')
    expect(messageCopyTitle(true)).toBe('Copied')
  })

  it('combines adjacent assistant messages when copying a response', () => {
    const messages = [
      message({ id: 'user', role: 'user', text: 'Question' }),
      message({ id: 'tool', role: 'assistant', text: '', tool: tool() }),
      message({ id: 'assistant', role: 'assistant', text: 'Answer' }),
    ]

    expect(buildCopyTextAt(messages, messages[0], 0)).toBe('Question')
    expect(buildCopyTextAt(messages, messages[2], 2)).toBe([
      buildCopyText(messages[1]),
      'Answer',
    ].join('\n\n'))
  })

  it('parses tool questions and reads saved answers by request/question key', () => {
    const request = serverRequest({
      params: {
        questions: [
          {
            id: 'choice',
            header: 'Mode',
            question: 'Pick one',
            isOther: true,
            options: [
              { label: 'Fast' },
              { label: '' },
              { name: 'missing-label' },
              { label: 'Careful' },
            ],
          },
          { id: '', question: 'skip me' },
          null,
        ],
      },
    })

    expect(readToolQuestions(request)).toEqual([
      {
        id: 'choice',
        header: 'Mode',
        question: 'Pick one',
        isOther: true,
        options: ['Fast', 'Careful'],
      },
    ])
    expect(toolQuestionTitle({ header: 'Mode', question: 'Pick one' })).toBe('Mode')
    expect(toolQuestionTitle({ header: '', question: 'Pick one' })).toBe('Pick one')
    expect(shouldShowToolQuestionText({ header: 'Mode', question: 'Pick one' })).toBe(true)
    expect(shouldShowToolQuestionText({ header: '', question: 'Pick one' })).toBe(false)
    expect(toolQuestionKey(42, 'choice')).toBe('42:choice')
    expect(readToolQuestionAnswer({ '42:choice': 'Careful' }, 42, 'choice', 'Fast')).toBe('Careful')
    expect(readToolQuestionAnswer({}, 42, 'choice', 'Fast')).toBe('Fast')
    expect(readToolQuestionOtherAnswer({ '42:choice': 'Custom' }, 42, 'choice')).toBe('Custom')
    expect(readToolQuestionOtherAnswer({}, 42, 'choice')).toBe('')
  })

  it('builds approval and tool request replies', () => {
    expect(conversationRequestKind('item/commandExecution/requestApproval')).toBe('command_approval')
    expect(conversationRequestKind('item/fileChange/requestApproval')).toBe('file_change_approval')
    expect(conversationRequestKind('item/tool/requestUserInput')).toBe('tool_user_input')
    expect(conversationRequestKind('item/tool/call')).toBe('tool_call')
    expect(conversationRequestKind('custom/request')).toBe('unknown')
    expect(isConversationApprovalRequestKind('command_approval')).toBe(true)
    expect(isConversationApprovalRequestKind('file_change_approval')).toBe(true)
    expect(isConversationApprovalRequestKind('tool_user_input')).toBe(false)
    expect(conversationRequestActionKeyPrefix('command_approval')).toBe('command')
    expect(conversationRequestActionKeyPrefix('file_change_approval')).toBe('file')
    expect(conversationRequestActionKeyPrefix('tool_call')).toBe('request')
    const requestCards = buildConversationRequestCards([
      serverRequest({
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      }),
      serverRequest({
        id: 2,
        method: 'item/tool/requestUserInput',
        params: {},
      }),
    ])
    expect(requestCards.map((card) => card.kind)).toEqual(['command_approval', 'tool_user_input'])
    expect(requestCards[0].request.id).toBe(1)
    expect(requestCards[0].summary.title).toBe('Command approval')

    expect(buildApprovalDecisionReply(7, 'acceptForSession')).toEqual({
      id: 7,
      approvalScope: 'session',
      result: { decision: 'acceptForSession' },
    })
    expect(buildApprovalScopeReply(7, 'workspace')).toEqual({
      id: 7,
      approvalScope: 'workspace',
      result: { decision: 'accept' },
    })
    expect(buildToolCallSuccessReply(8)).toEqual({
      id: 8,
      result: { success: true, contentItems: [] },
    })
    expect(buildToolCallFailureReply(8)).toEqual({
      id: 8,
      result: {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'Tool call rejected from CodyWeb UI.',
          },
        ],
      },
    })
    expect(buildEmptyServerRequestReply(9)).toEqual({ id: 9, result: {} })
    expect(buildRejectedServerRequestReply(9, 'Nope')).toEqual({
      id: 9,
      error: { code: -32000, message: 'Nope' },
    })
  })

  it('builds tool user input replies from selected and custom answers', () => {
    const request = serverRequest({
      params: {
        questions: [
          {
            id: 'size',
            question: 'Size?',
            options: [{ label: 'Small' }, { label: 'Large' }],
          },
          {
            id: 'note',
            question: 'Anything else?',
            isOther: true,
            options: [{ label: 'Other' }],
          },
        ],
      },
    })

    expect(buildToolUserInputReply({
      request,
      answersByKey: { '42:size': 'Large' },
      otherAnswersByKey: { '42:note': '  custom note  ' },
    })).toEqual({
      id: 42,
      result: {
        answers: {
          size: { answers: ['Large'] },
          note: { answers: ['Other', 'custom note'] },
        },
      },
    })
  })

  it('summarizes live overlay details and scroll-to-bottom visibility', () => {
    expect(hasLiveOverlayDetails(null)).toBe(false)
    expect(hasLiveOverlayDetails({
      activityLabel: 'Thinking',
      activityDetails: [],
      reasoningText: '   ',
      errorText: '',
    })).toBe(false)
    expect(hasLiveOverlayDetails({
      activityLabel: 'Thinking',
      activityDetails: ['reading files'],
      reasoningText: '',
      errorText: '',
    })).toBe(true)
    expect(hasLiveOverlayDetails({
      activityLabel: 'Thinking',
      activityDetails: [],
      reasoningText: 'reasoning',
      errorText: '',
    })).toBe(true)
    expect(liveOverlayDetailsToggleLabel(false)).toBe('Show details')
    expect(liveOverlayDetailsToggleLabel(true)).toBe('Hide details')

    expect(shouldShowScrollToBottomButton({
      activeThreadId: '',
      isLoading: false,
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
      scrollState: { scrollTop: 0, scrollRatio: 0, isAtBottom: false },
    })).toBe(false)
    expect(shouldShowScrollToBottomButton({
      activeThreadId: 'thread-1',
      isLoading: true,
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
      scrollState: { scrollTop: 0, scrollRatio: 0, isAtBottom: false },
    })).toBe(false)
    expect(shouldShowScrollToBottomButton({
      activeThreadId: 'thread-1',
      isLoading: false,
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
      scrollState: { scrollTop: 0, scrollRatio: 0, isAtBottom: false },
    })).toBe(false)
    expect(shouldShowScrollToBottomButton({
      activeThreadId: 'thread-1',
      isLoading: false,
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: true,
      scrollState: { scrollTop: 0, scrollRatio: 0, isAtBottom: false },
    })).toBe(true)
  })

  it('calculates conversation scroll metrics and restored positions', () => {
    expect(buildConversationScrollMetrics({
      scrollTop: 80,
      scrollHeight: 200,
      clientHeight: 100,
      bottomThresholdPx: 16,
    })).toEqual({
      maxScrollTop: 100,
      scrollRatio: 0.8,
      isAtBottom: false,
    })
    expect(buildConversationScrollMetrics({
      scrollTop: 85,
      scrollHeight: 200,
      clientHeight: 100,
      bottomThresholdPx: 16,
    }).isAtBottom).toBe(true)
    expect(buildConversationScrollMetrics({
      scrollTop: 20,
      scrollHeight: 80,
      clientHeight: 100,
      bottomThresholdPx: 16,
    })).toEqual({
      maxScrollTop: 0,
      scrollRatio: 1,
      isAtBottom: true,
    })

    expect(restoredConversationScrollTop({
      scrollTop: 500,
      scrollRatio: 0.25,
      isAtBottom: false,
    }, 200)).toBe(50)
    expect(restoredConversationScrollTop({
      scrollTop: -20,
      isAtBottom: false,
    }, 200)).toBe(0)
    expect(restoredConversationScrollTop({
      scrollTop: 500,
      isAtBottom: false,
    }, 200)).toBe(200)
    expect(preservedConversationScrollTop({
      scrollTop: 80,
      scrollRatio: 0.4,
      isAtBottom: false,
    }, 400)).toBe(80)
    expect(preservedConversationScrollTop({
      scrollTop: 500,
      isAtBottom: false,
    }, 200)).toBe(200)

    expect(buildConversationScrollState({
      scrollTop: 80,
      scrollHeight: 200,
      clientHeight: 100,
      bottomThresholdPx: 16,
    })).toEqual({
      scrollTop: 80,
      scrollRatio: 0.8,
      isAtBottom: false,
    })
  })

  it('locks live output to bottom only when the saved state is at bottom', () => {
    expect(shouldRestoreConversationToBottom(null)).toBe(true)
    expect(shouldRestoreConversationToBottom({ scrollTop: 0, scrollRatio: 0, isAtBottom: true })).toBe(true)
    expect(shouldRestoreConversationToBottom({ scrollTop: 0, scrollRatio: 0, isAtBottom: false })).toBe(false)
    expect(shouldPreserveConversationViewport({ scrollTop: 0, scrollRatio: 0, isAtBottom: false })).toBe(true)
    expect(shouldPreserveConversationViewport({ scrollTop: 0, scrollRatio: 0, isAtBottom: true })).toBe(false)
    expect(shouldPreserveConversationViewport(null)).toBe(false)
    expect(shouldLockConversationToBottom(null)).toBe(true)
    expect(shouldLockConversationToBottom({ scrollTop: 0, scrollRatio: 0, isAtBottom: true })).toBe(true)
    expect(shouldLockConversationToBottom({ scrollTop: 0, scrollRatio: 0, isAtBottom: false })).toBe(false)
    expect(normalizedConversationBottomLockFrames(6)).toBe(6)
    expect(normalizedConversationBottomLockFrames(1.8)).toBe(1)
    expect(normalizedConversationBottomLockFrames(0)).toBe(1)
    expect(normalizedConversationBottomLockFrames(-2)).toBe(1)
  })

  it('calculates visible message windows for long conversations', () => {
    expect(DEFAULT_VISIBLE_MESSAGE_COUNT).toBe(80)
    expect(normalizedVisibleMessageCount(40, 80)).toBe(40)
    expect(normalizedVisibleMessageCount(200, 20)).toBe(80)
    expect(normalizedVisibleMessageCount(200, 120)).toBe(120)
    expect(visibleMessageStartIndex(200, 80)).toBe(120)
    expect(hiddenMessageCount(200, 80)).toBe(120)
    expect(nextVisibleMessageCount(200, 80)).toBe(160)
    expect(nextVisibleMessageCount(120, 80)).toBe(120)
    expect(visibleMessageWindowSummary(0, 80)).toBe('No messages')
    expect(visibleMessageWindowSummary(40, 80)).toBe('Showing messages 1-40 of 40')
    expect(visibleMessageWindowSummary(200, 80)).toBe('Showing messages 121-200 of 200')
    expect(visibleMessageWindowSummary(200, 160)).toBe('Showing messages 41-200 of 200')
    expect(historyPageButtonLabel(0)).toBe('No earlier messages')
    expect(historyPageButtonLabel(120)).toBe('Show 80 earlier messages')
    expect(historyPageButtonLabel(1)).toBe('Show 1 earlier message')
    expect(historyPageButtonLabel(20, 80)).toBe('Show 20 earlier messages')
  })

  it('blocks the conversation only for empty initial message loads', () => {
    expect(shouldShowBlockingConversationLoading({
      isLoading: true,
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(true)
    expect(shouldShowConversationRefreshStatus({
      isLoading: true,
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)

    expect(shouldShowBlockingConversationLoading({
      isLoading: true,
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)
    expect(shouldShowConversationRefreshStatus({
      isLoading: true,
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(true)

    expect(shouldShowBlockingConversationLoading({
      isLoading: true,
      messageCount: 0,
      pendingRequestCount: 1,
      hasLiveOverlay: false,
    })).toBe(false)
    expect(shouldShowBlockingConversationLoading({
      isLoading: true,
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: true,
    })).toBe(false)
    expect(shouldShowConversationRefreshStatus({
      isLoading: false,
      messageCount: 10,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)
  })

  it('shows load errors as blocking only when no conversation content is available', () => {
    expect(shouldShowBlockingConversationLoadError({
      isLoading: false,
      loadError: 'thread/read timed out',
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(true)
    expect(shouldShowInlineConversationLoadError({
      isLoading: false,
      loadError: 'thread/read timed out',
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)

    expect(shouldShowBlockingConversationLoadError({
      isLoading: false,
      loadError: 'thread/read timed out',
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)
    expect(shouldShowInlineConversationLoadError({
      isLoading: false,
      loadError: 'thread/read timed out',
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(true)

    expect(shouldShowBlockingConversationLoadError({
      isLoading: true,
      loadError: 'thread/read timed out',
      messageCount: 0,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)
    expect(shouldShowInlineConversationLoadError({
      isLoading: false,
      loadError: '   ',
      messageCount: 1,
      pendingRequestCount: 0,
      hasLiveOverlay: false,
    })).toBe(false)
  })
})
