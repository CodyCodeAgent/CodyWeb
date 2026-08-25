import { describe, expect, it } from 'vitest'
import {
  areMessageArraysEqual,
  areTurnActivitiesEqual,
  appendLiveReasoningDelta,
  appendLiveReasoningDeltaForThread,
  appendLiveReasoningSectionBreak,
  appendLiveReasoningSectionBreakForThread,
  buildDisplayedMessages,
  buildRollbackAuditMessage,
  buildLiveOverlay,
  buildTurnSummaryMessage,
  clearLiveReasoningTextForThread,
  finalizeLiveMessagesForTurn,
  formatTurnDuration,
  insertTurnSummaryMessage,
  mergeMessages,
  mergeTurnActivity,
  normalizeMessageText,
  removeDuplicateAdjacentUserMessages,
  removeLivePlanMessagesForTurn,
  removeMessageById,
  replaceMessageById,
  removeRedundantLiveAgentMessages,
  resolveTurnDurationMs,
  updateLiveReasoningTextForThread,
  updateMessagesForThread,
  upsertLiveAssistantDelta,
  upsertLiveAssistantDeltaForThread,
  upsertMessage,
  upsertMessages,
  updateTurnActivityState,
  updateTurnErrorState,
  updateTurnSummaryState,
} from './desktopMessageState'
import type { UiMessage, UiToolingRollbackFileResult } from '../types/codex'

function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    text: 'hello',
    ...overrides,
  }
}

function rollbackResult(overrides: Partial<UiToolingRollbackFileResult> = {}): UiToolingRollbackFileResult {
  return {
    cwd: '/workspace/app',
    repoRoot: '/workspace/app',
    filePath: 'src/app.ts',
    relativePath: 'src/app.ts',
    rollbackApplied: true,
    remainingStatus: '',
    checkpoint: {
      id: 'checkpoint-1',
      label: 'Before rollback',
      cwd: '/workspace/app',
      repoRoot: '/workspace/app',
      createdAtIso: '2026-07-07T00:00:00.000Z',
      paths: ['src/app.ts'],
      patchPath: '/workspace/app/.git/cody-web-ui-checkpoints/checkpoint-1/workspace.patch',
      patchBytes: 128,
      hasPatch: true,
    },
    ...overrides,
  }
}

describe('desktopMessageState', () => {
  it('keeps previous message references when incoming fields are unchanged', () => {
    const previous = [message()]
    const incoming = [message()]

    const merged = mergeMessages(previous, incoming)

    expect(merged).toBe(previous)
    expect(merged[0]).toBe(previous[0])
    expect(areMessageArraysEqual(previous, merged)).toBe(true)
  })

  it('preserves missing messages during silent refreshes and appends new rows', () => {
    const previousOnly = message({ id: 'live', text: 'still streaming' })
    const persisted = message({ id: 'persisted', text: 'saved' })

    const merged = mergeMessages([previousOnly], [persisted], { preserveMissing: true })

    expect(merged.map((row) => row.id)).toEqual(['live', 'persisted'])
  })

  it('deduplicates repeated incoming ids before they reach the rendered thread', () => {
    const previous = [
      message({ id: 'user-1', role: 'user', text: 'question' }),
      message({ id: 'assistant-1', role: 'assistant', text: 'old answer' }),
    ]
    const incoming = [
      message({ id: 'user-1', role: 'user', text: 'question' }),
      message({ id: 'assistant-1', role: 'assistant', text: 'new answer' }),
      message({ id: 'assistant-1', role: 'assistant', text: 'duplicate answer' }),
      message({ id: 'assistant-2', role: 'assistant', text: 'next answer' }),
    ]

    const merged = mergeMessages(previous, incoming)

    expect(merged.map((row) => row.id)).toEqual(['user-1', 'assistant-1', 'assistant-2'])
    expect(merged[1].text).toBe('new answer')
  })

  it('compacts adjacent duplicate user messages even when ids differ', () => {
    const firstUser = message({
      id: 'user-live',
      role: 'user',
      text: '我觉得可以，干吧',
      images: ['/image.png'],
      skills: [{ name: 'review', path: '/skills/review', displayName: 'review', description: '' }],
      messageType: 'userMessage',
    })
    const secondUser = message({
      ...firstUser,
      id: 'user-persisted',
    })
    const assistant = message({ id: 'assistant', role: 'assistant', text: '收到' })
    const laterSameText = message({
      ...firstUser,
      id: 'user-later',
    })

    expect(removeDuplicateAdjacentUserMessages([firstUser, secondUser, assistant, laterSameText])).toEqual([
      firstUser,
      assistant,
      laterSameText,
    ])
    expect(mergeMessages([firstUser], [firstUser, secondUser])).toEqual([firstUser])
    expect(buildDisplayedMessages([firstUser, secondUser], [], null)).toEqual([firstUser])
  })

  it('compacts duplicate user messages when persisted text only differs by whitespace', () => {
    const optimistic = message({
      id: 'optimistic-user:thread-1:1',
      role: 'user',
      text: '第一行\n\n第二行',
      messageType: 'userMessage.optimistic',
    })
    const persisted = message({
      id: 'server-user',
      role: 'user',
      text: ' 第一行 第二行 ',
      messageType: 'userMessage',
    })

    expect(removeDuplicateAdjacentUserMessages([optimistic, persisted])).toEqual([persisted])
    expect(mergeMessages([optimistic], [persisted], { preserveMissing: true })).toEqual([persisted])
  })

  it('replaces optimistic user messages with persisted matches', () => {
    const optimistic = message({
      id: 'optimistic-user:thread-1:1',
      role: 'user',
      text: 'run it',
      messageType: 'userMessage.optimistic',
    })
    const persisted = message({
      id: 'server-user',
      role: 'user',
      text: 'run it',
      messageType: 'userMessage',
    })

    expect(removeDuplicateAdjacentUserMessages([optimistic, persisted])).toEqual([persisted])
    expect(mergeMessages([optimistic], [persisted], { preserveMissing: true })).toEqual([persisted])
    expect(removeMessageById([optimistic], optimistic.id)).toEqual([])
  })

  it('matches skills by stable identity instead of presentation metadata', () => {
    const optimistic = message({
      id: 'optimistic-user:thread-1:1', role: 'user', text: 'Review this', messageType: 'userMessage.optimistic',
      skills: [{ name: 'review', path: '/skills/review', displayName: 'Code Review', description: 'Detailed review' }],
    })
    const persisted = message({
      id: 'server-user', role: 'user', text: 'Review this', messageType: 'userMessage',
      skills: [{ name: 'review', path: '/skills/review', displayName: 'review', description: '' }],
    })
    expect(mergeMessages([optimistic], [persisted], { preserveMissing: true })).toEqual([persisted])
  })

  it('replaces an optimistic row by its turn-linked id without moving it below the answer', () => {
    const optimistic = message({ id: 'optimistic-user:thread-1:1', role: 'user', text: 'Review this', messageType: 'userMessage.optimistic' })
    const assistant = message({ id: 'assistant-1', role: 'assistant', text: 'Done' })
    const persisted = message({ id: 'server-user', role: 'user', text: 'Review this', messageType: 'userMessage' })
    expect(replaceMessageById([optimistic, assistant], optimistic.id, persisted)).toEqual([persisted, assistant])
  })

  it('replaces non-adjacent optimistic user messages without appending duplicates', () => {
    const longOptimistic = message({
      id: 'optimistic-user:thread-1:1',
      role: 'user',
      text: '这些人的菜单，都应该改成 turbine.campaigndashboard.overview',
      messageType: 'userMessage.optimistic',
    })
    const shortOptimistic = message({
      id: 'optimistic-user:thread-1:2',
      role: 'user',
      text: '人的菜单都在了是么？',
      messageType: 'userMessage.optimistic',
    })
    const longPersisted = message({
      id: 'server-user-long',
      role: 'user',
      text: longOptimistic.text,
      messageType: 'userMessage',
    })

    const merged = mergeMessages([longOptimistic, shortOptimistic], [longPersisted], { preserveMissing: true })

    expect(merged).toEqual([longPersisted, shortOptimistic])
  })

  it('reconciles a replayed historical user item by turn without moving it to the bottom', () => {
    const historicalUser = message({
      id: 'user-old-id',
      turnId: 'turn-previous',
      role: 'user',
      text: '之前发出的消息',
      messageType: 'userMessage',
    })
    const historicalAnswer = message({
      id: 'assistant-previous',
      turnId: 'turn-previous',
      text: '之前的回复',
      messageType: 'agentMessage',
    })
    const historicalReceipt = message({
      id: 'turn-summary:turn-previous',
      turnId: 'turn-previous',
      role: 'system',
      text: 'Answered',
      messageType: 'worked',
    })
    const currentUser = message({
      id: 'user-current',
      turnId: 'turn-current',
      role: 'user',
      text: '现在发出的消息',
      messageType: 'userMessage',
    })
    const currentAnswer = message({
      id: 'assistant-current',
      turnId: 'turn-current',
      text: '正在回复',
      messageType: 'agentMessage.live',
    })
    const replayedHistoricalUser = message({
      ...historicalUser,
      id: 'user-replayed-id',
    })

    const merged = mergeMessages(
      [historicalUser, historicalAnswer, historicalReceipt, currentUser, currentAnswer],
      [replayedHistoricalUser, historicalAnswer, historicalReceipt, currentUser],
      { preserveMissing: true },
    )

    expect(merged.map((row) => row.id)).toEqual([
      'user-replayed-id',
      'assistant-previous',
      'turn-summary:turn-previous',
      'user-current',
      'assistant-current',
    ])
    expect(merged.filter((row) => row.text === '之前发出的消息')).toHaveLength(1)
  })

  it('preserves identical prompts when they belong to different turns', () => {
    const first = message({
      id: 'user-first', turnId: 'turn-1', role: 'user', text: '再试一次', messageType: 'userMessage',
    })
    const receipt = message({
      id: 'turn-summary:turn-1', turnId: 'turn-1', role: 'system', text: 'Answered', messageType: 'worked',
    })
    const second = message({
      id: 'user-second', turnId: 'turn-2', role: 'user', text: '再试一次', messageType: 'userMessage',
    })

    expect(mergeMessages([first, receipt], [first, receipt, second], { preserveMissing: true })).toEqual([
      first,
      receipt,
      second,
    ])
  })

  it('inserts a newly discovered historical row at its protocol turn instead of the tail', () => {
    const oldAnswer = message({ id: 'old-answer', turnId: 'turn-old', text: '旧回复' })
    const oldReceipt = message({ id: 'turn-summary:turn-old', turnId: 'turn-old', role: 'system', text: 'Answered', messageType: 'worked' })
    const current = message({ id: 'current-user', turnId: 'turn-current', role: 'user', text: '新问题', messageType: 'userMessage' })
    const missingOldUser = message({ id: 'old-user', turnId: 'turn-old', role: 'user', text: '旧问题', messageType: 'userMessage' })

    const merged = mergeMessages(
      [oldAnswer, oldReceipt, current],
      [missingOldUser, oldAnswer, oldReceipt, current],
      { preserveMissing: true },
    )
    expect(merged.map((row) => row.id)).toEqual(['old-user', 'old-answer', 'turn-summary:turn-old', 'current-user'])
  })

  it('removes redundant live assistant messages once persisted text arrives', () => {
    const live = message({
      id: 'live-agent',
      text: 'hello   world',
      messageType: 'agentMessage.live',
    })
    const unrelated = message({ id: 'tool', role: 'system', text: '', messageType: 'tool.command' })
    const incoming = [message({ id: 'saved-agent', text: 'hello world' })]

    expect(removeRedundantLiveAgentMessages([live, unrelated], incoming)).toEqual([unrelated])
    expect(normalizeMessageText(' hello\n\nworld ')).toBe('hello world')
  })

  it('removes live assistant rows when the same persisted item id arrives', () => {
    const live = message({
      id: 'agent-1',
      text: 'partial stream',
      messageType: 'agentMessage.live',
    })
    const persisted = message({
      id: 'agent-1',
      text: 'final response',
      messageType: 'agentMessage',
    })

    expect(removeRedundantLiveAgentMessages([live], [persisted])).toEqual([])
    expect(buildDisplayedMessages([persisted], [live], null)).toEqual([persisted])
  })

  it('removes superseded optimistic user messages from displayed rows even when separated', () => {
    const optimistic = message({
      id: 'optimistic-user:thread-1:1',
      role: 'user',
      text: '重复消息',
      messageType: 'userMessage.optimistic',
    })
    const assistant = message({ id: 'assistant-1', role: 'assistant', text: '处理中' })
    const persisted = message({
      id: 'server-user-1',
      role: 'user',
      text: '重复消息',
      messageType: 'userMessage',
    })

    expect(buildDisplayedMessages([optimistic, assistant, persisted], [], null)).toEqual([
      persisted,
      assistant,
    ])
  })

  it('removes superseded optimistic user messages when normalized text matches a persisted row', () => {
    const persisted = message({
      id: 'server-user-1',
      role: 'user',
      text: '这些人的菜单 都应该改成 turbine.campaigndashboard.overview',
      messageType: 'userMessage',
    })
    const followUp = message({
      id: 'server-user-2',
      role: 'user',
      text: '人的菜单都在了是么？',
      messageType: 'userMessage',
    })
    const optimistic = message({
      id: 'optimistic-user:thread-1:1',
      role: 'user',
      text: '这些人的菜单\n\n都应该改成 turbine.campaigndashboard.overview',
      messageType: 'userMessage.optimistic',
    })

    expect(buildDisplayedMessages([persisted, followUp, optimistic], [], null)).toEqual([
      persisted,
      followUp,
    ])
  })

  it('upserts changed messages and keeps unchanged upserts stable', () => {
    const existing = message()
    const unchanged = upsertMessage([existing], message())
    const changed = upsertMessage([existing], message({ text: 'updated' }))

    expect(unchanged).toBeInstanceOf(Array)
    expect(unchanged[0]).toBe(existing)
    expect(changed[0].text).toBe('updated')
  })

  it('updates message maps by thread without unnecessary churn', () => {
    const existing = message({ id: 'existing', text: 'old' })
    const state = { 'thread-1': [existing] }
    const nextMessages = upsertMessages(state['thread-1'], [
      message({ id: 'existing', text: 'new' }),
      message({ id: 'next', text: 'added' }),
    ])

    expect(nextMessages.map((row) => row.text)).toEqual(['new', 'added'])
    expect(updateMessagesForThread(state, 'thread-1', state['thread-1'])).toBe(state)
    expect(updateMessagesForThread(state, '', [])).toBe(state)
    expect(updateMessagesForThread(state, 'thread-1', nextMessages)).toEqual({
      'thread-1': nextMessages,
    })
  })

  it('appends live assistant deltas without duplicating message rows', () => {
    const first = upsertLiveAssistantDelta([], {
      messageId: 'agent-1',
      textDelta: 'hello',
      messageType: 'agentMessage.live',
    })
    const second = upsertLiveAssistantDelta(first, {
      messageId: 'agent-1',
      textDelta: ' world',
      messageType: 'agentMessage.live',
    })

    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      id: 'agent-1',
      role: 'assistant',
      text: 'hello world',
      messageType: 'agentMessage.live',
    })
  })

  it('applies live assistant deltas to the thread message map', () => {
    const first = upsertLiveAssistantDeltaForThread({}, 'thread-1', {
      messageId: 'agent-1',
      textDelta: 'hello',
      messageType: 'agentMessage.live',
    })
    const second = upsertLiveAssistantDeltaForThread(first, 'thread-1', {
      messageId: 'agent-1',
      textDelta: ' plan',
      messageType: 'plan.live',
    })

    expect(second['thread-1']).toHaveLength(1)
    expect(second['thread-1'][0]).toMatchObject({
      id: 'agent-1',
      text: 'hello plan',
      messageType: 'plan.live',
    })
    expect(upsertLiveAssistantDeltaForThread(second, '', {
      messageId: 'agent-2',
      textDelta: 'ignored',
      messageType: 'agentMessage.live',
    })).toBe(second)
  })

  it('removes only the live plan for a completed turn', () => {
    const messages = [
      message({ id: 'answer-live', text: 'answer', messageType: 'agentMessage.live' }),
      message({ id: 'plan-live', text: 'plan', messageType: 'plan.live' }),
      message({ id: 'plan:turn-1:live', text: 'fallback plan', messageType: 'plan.live' }),
      message({ id: 'plan:turn-2:live', text: 'other turn plan', messageType: 'plan.live' }),
      message({ id: 'persisted-plan', text: 'persisted', messageType: 'plan' }),
    ]

    expect(removeLivePlanMessagesForTurn(messages, 'turn-1', 'plan-live')).toEqual([
      message({ id: 'answer-live', text: 'answer', messageType: 'agentMessage.live' }),
      message({ id: 'plan:turn-2:live', text: 'other turn plan', messageType: 'plan.live' }),
      message({ id: 'persisted-plan', text: 'persisted', messageType: 'plan' }),
    ])
    expect(removeLivePlanMessagesForTurn(messages, '', 'plan-live')).toBe(messages)
  })

  it('promotes the completed answer and clears stale live rows for the thread', () => {
    const persisted = [
      message({ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'first', messageType: 'userMessage' }),
      message({ id: 'agent-1', turnId: 'turn-1', text: 'first answer', messageType: 'agentMessage' }),
      message({ id: 'user-2', turnId: 'turn-2', role: 'user', text: 'second', messageType: 'userMessage' }),
    ]
    const live = [
      message({ id: 'agent-1-live-copy', turnId: 'turn-1', text: 'first answer', messageType: 'agentMessage.live' }),
      message({ id: 'agent-2', turnId: 'turn-2', text: 'second answer', messageType: 'agentMessage.live' }),
      message({ id: 'plan:turn-2:live', turnId: 'turn-2', text: 'plan', messageType: 'plan.live' }),
    ]

    const finalized = finalizeLiveMessagesForTurn(persisted, live, 'turn-2')

    expect(finalized.liveMessages).toEqual([])
    expect(finalized.persistedMessages.map((row) => [row.id, row.messageType])).toEqual([
      ['user-1', 'userMessage'],
      ['agent-1', 'agentMessage'],
      ['user-2', 'userMessage'],
      ['agent-2', 'agentMessage'],
    ])
  })

  it('preserves live reasoning whitespace until display time', () => {
    expect(appendLiveReasoningDelta('', '  thinking')).toBe('  thinking')
    expect(appendLiveReasoningDelta('  thinking', '\nnext')).toBe('  thinking\nnext')
    expect(appendLiveReasoningDelta('', '   ')).toBe('')
    expect(appendLiveReasoningSectionBreak('  thinking')).toBe('  thinking\n\n')
    expect(appendLiveReasoningSectionBreak('  thinking\n\n')).toBe('  thinking\n\n')
  })

  it('updates live reasoning maps without losing meaningful whitespace', () => {
    const state = updateLiveReasoningTextForThread({}, 'thread-1', '  thinking')
    const withDelta = appendLiveReasoningDeltaForThread(state, 'thread-1', '\nnext')
    const withBreak = appendLiveReasoningSectionBreakForThread(withDelta, 'thread-1')

    expect(state).toEqual({ 'thread-1': '  thinking' })
    expect(withDelta).toEqual({ 'thread-1': '  thinking\nnext' })
    expect(withBreak).toEqual({ 'thread-1': '  thinking\nnext\n\n' })
    expect(updateLiveReasoningTextForThread(withBreak, 'thread-1', '   ')).toEqual({})
    expect(clearLiveReasoningTextForThread(withBreak, 'thread-1')).toEqual({})
    expect(clearLiveReasoningTextForThread(withBreak, 'missing')).toBe(withBreak)
  })

  it('shows live assistant output before it is persisted by thread/read', () => {
    const persisted = [message({ id: 'user-1', role: 'user', text: 'question' })]
    const live = [
      message({
        id: 'agent-1',
        role: 'assistant',
        text: 'streaming answer',
        messageType: 'agentMessage.live',
      }),
    ]

    const displayed = buildDisplayedMessages(persisted, live, null)

    expect(displayed.map((row) => row.id)).toEqual(['user-1', 'agent-1'])
    expect(displayed[1]).toMatchObject({
      role: 'assistant',
      text: 'streaming answer',
      messageType: 'agentMessage.live',
    })
  })

  it('formats turn summaries and inserts them after the last assistant response', () => {
    const user = message({ id: 'user', role: 'user', text: 'question' })
    const assistant = message({ id: 'assistant', role: 'assistant', text: 'answer' })
    const staleSummary = buildTurnSummaryMessage({ turnId: 'old', durationMs: 1 })

    const next = insertTurnSummaryMessage([user, staleSummary, assistant], {
      turnId: 'turn-1',
      durationMs: 65_000,
    })

    expect(formatTurnDuration(65_000)).toBe('1m 5s')
    expect(next.map((row) => row.id)).toEqual(['user', 'turn-summary:old', 'assistant', 'turn-summary:turn-1'])
    expect(next[3].text).toBe('Worked for 1m 5s')
  })

  it('does not append a refreshed copy of the current user message below a streaming answer', () => {
    const user = message({ id: 'user-live', role: 'user', text: 'Explain the account flow', messageType: 'userMessage' })
    const assistant = message({ id: 'agent-live', role: 'assistant', text: 'I am checking it.', messageType: 'agentMessage.live' })
    const refreshedUser = message({ id: 'user-server', role: 'user', text: 'Explain the account flow', messageType: 'userMessage' })

    expect(mergeMessages([user, assistant], [refreshedUser], { preserveMissing: true }).map((row) => row.id))
      .toEqual(['user-live', 'agent-live'])
  })

  it('keeps an intentionally repeated prompt after a completed turn boundary', () => {
    const user = message({ id: 'user-first', role: 'user', text: 'Try again', messageType: 'userMessage' })
    const assistant = message({ id: 'agent-first', role: 'assistant', text: 'Done', messageType: 'agentMessage' })
    const receipt = buildTurnSummaryMessage({ turnId: 'turn-first', durationMs: 1000 })
    const repeatedUser = message({ id: 'user-second', role: 'user', text: 'Try again', messageType: 'userMessage' })

    expect(mergeMessages([user, assistant, receipt], [repeatedUser], { preserveMissing: true }).map((row) => row.id))
      .toEqual(['user-first', 'agent-first', receipt.id, 'user-second'])
  })

  it('compares turn activities by label and details', () => {
    expect(areTurnActivitiesEqual(
      { label: 'Thinking', details: ['model'] },
      { label: 'Thinking', details: ['model'] },
    )).toBe(true)
    expect(areTurnActivitiesEqual(
      { label: 'Thinking', details: ['model'] },
      { label: 'Writing', details: ['model'] },
    )).toBe(false)
  })

  it('normalizes and merges turn activity details', () => {
    expect(mergeTurnActivity(undefined, {
      label: '   ',
      details: [' Thinking ', '', 'Thinking'],
    })).toEqual({
      label: 'Thinking',
      details: [],
    })

    expect(mergeTurnActivity(
      { label: 'Thinking', details: ['old', 'keep', 'same'] },
      { label: ' Writing response ', details: ['keep', 'new\nline', 'same', 'last'] },
    )).toEqual({
      label: 'Writing response',
      details: ['same', 'new line', 'last'],
    })
  })

  it('updates turn summary state without churning unchanged records', () => {
    const summary = { turnId: 'turn-1', durationMs: 1000 }
    const state = updateTurnSummaryState({}, 'thread-1', summary)

    expect(state).toEqual({ 'thread-1': summary })
    expect(updateTurnSummaryState(state, 'thread-1', summary)).toBe(state)
    expect(updateTurnSummaryState(state, 'thread-1', null)).toEqual({})
    expect(updateTurnSummaryState(state, '', null)).toBe(state)
  })

  it('updates turn activity state with normalized merged details', () => {
    const state = updateTurnActivityState({}, 'thread-1', {
      label: ' Thinking ',
      details: [' model ', '', 'Thinking'],
    })

    expect(state).toEqual({
      'thread-1': { label: 'Thinking', details: ['model'] },
    })
    expect(updateTurnActivityState(state, 'thread-1', {
      label: 'Thinking',
      details: ['model'],
    })).toBe(state)
    expect(updateTurnActivityState(state, 'thread-1', null)).toEqual({})
  })

  it('updates turn error state with normalized messages', () => {
    const state = updateTurnErrorState({}, 'thread-1', ' failed\nagain ')

    expect(state).toEqual({
      'thread-1': { message: 'failed again' },
    })
    expect(updateTurnErrorState(state, 'thread-1', 'failed again')).toBe(state)
    expect(updateTurnErrorState(state, 'thread-1', '   ')).toEqual({})
  })

  it('builds live overlay only when selected thread has live state', () => {
    expect(buildLiveOverlay('', {}, {}, {})).toBeNull()
    expect(buildLiveOverlay('thread-1', {}, {}, {})).toBeNull()
    expect(buildLiveOverlay(
      'thread-1',
      { 'thread-1': { label: 'Writing', details: ['tool'] } },
      { 'thread-1': '  reasoning  ' },
      { 'thread-1': { message: '  failed  ' } },
    )).toEqual({
      activityLabel: 'Writing',
      activityDetails: ['tool'],
      reasoningText: 'reasoning',
      errorText: 'failed',
    })
    expect(buildLiveOverlay(
      'thread-1',
      {},
      { 'thread-1': 'thinking' },
      {},
    )?.activityLabel).toBe('Thinking')
  })

  it('resolves turn duration from the strongest available source', () => {
    expect(resolveTurnDurationMs({
      explicitDurationMs: 100,
      turnDurationMs: 200,
      completedStartedAtMs: 0,
      completedAtMs: 500,
      pendingStartedAtMs: 0,
    })).toBe(100)
    expect(resolveTurnDurationMs({
      turnDurationMs: null,
      completedStartedAtMs: 400,
      completedAtMs: 100,
      pendingStartedAtMs: 0,
    })).toBe(0)
    expect(resolveTurnDurationMs({
      completedAtMs: 500,
      pendingStartedAtMs: 100,
    })).toBe(400)
  })

  it('builds rollback audit messages', () => {
    const audit = buildRollbackAuditMessage(rollbackResult({ rollbackApplied: false }))

    expect(audit).toMatchObject({
      id: 'tooling.rollback:checkpoint-1:src/app.ts',
      role: 'system',
      messageType: 'tool.rollback',
      tool: {
        kind: 'rollback',
        status: 'no changes',
        summary: 'No local changes found for src/app.ts',
      },
    })
  })
})
