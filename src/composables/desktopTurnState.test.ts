import { describe, expect, it } from 'vitest'
import type { ComposerSubmission } from '@codycodeagent/cody-web-core/composer'
import {
  buildPendingTurnActivity,
  buildSteeringTurnActivity,
  buildCompletedTurnSummary,
  clearActiveTurnForThread,
  normalizeComposerTurnInput,
  normalizeNewThreadTurnInput,
  normalizeThreadTextTurnInput,
  setActiveTurnForThread,
  shouldClearUnreadForStartedTurn,
} from './desktopTurnState'
import type { UiComposerContextKind } from '../types/codex'
import type { TurnCompletedInfo, TurnStartedInfo } from './realtimeNotificationReaders'

function payload(overrides: Partial<ComposerSubmission<UiComposerContextKind>> = {}): ComposerSubmission<UiComposerContextKind> {
  return {
    text: '',
    images: [],
    skills: [],
    ...overrides,
  }
}

describe('desktopTurnState', () => {
  it('normalizes composer input while preserving attachment sends', () => {
    expect(normalizeComposerTurnInput(payload({ text: '  hello  ' }))).toMatchObject({
      text: 'hello',
      hasContent: true,
    })
    expect(normalizeComposerTurnInput(payload())).toMatchObject({
      text: '',
      images: [],
      skills: [],
      hasContent: false,
    })
    expect(normalizeComposerTurnInput(payload({
      images: [{ id: 'img-1', name: 'screen.png', path: '/tmp/screen.png', url: 'file:///tmp/screen.png', mimeType: 'image/png' }],
    }))).toMatchObject({
      text: '',
      hasContent: true,
    })
    expect(normalizeComposerTurnInput(payload({
      skills: [{ name: 'browser', path: '/skills/browser', description: 'Browser control', displayName: 'browser' }],
    }))).toMatchObject({
      text: '',
      hasContent: true,
    })
  })

  it('normalizes targeted thread and new thread inputs', () => {
    expect(normalizeThreadTextTurnInput(' thread-1 ', '  steer this  ')).toEqual({
      threadId: 'thread-1',
      text: 'steer this',
      images: [],
      skills: [],
      hasContent: true,
    })
    expect(normalizeThreadTextTurnInput(' thread-1 ', '   ')).toMatchObject({
      threadId: 'thread-1',
      text: '',
      hasContent: false,
    })
    expect(normalizeNewThreadTurnInput(payload({ text: '  start  ' }), ' /repo ')).toMatchObject({
      targetCwd: '/repo',
      text: 'start',
      hasContent: true,
    })
  })

  it('builds pending and steering activity labels consistently', () => {
    expect(buildPendingTurnActivity({
      modelId: 'codex',
      reasoningEffort: 'medium',
      mode: {
        name: 'plan',
        mode: 'plan',
        label: 'Plan first',
        model: '',
        reasoningEffort: '',
        developerInstructions: null,
      },
    })).toEqual({
      label: 'Thinking',
      details: ['Mode: Plan first', 'Model: codex', 'Thinking: medium'],
    })

    expect(buildSteeringTurnActivity({
      modelId: '',
      reasoningEffort: '',
    })).toEqual({
      label: 'Steering response',
      details: ['Model: default', 'Thinking: default'],
    })
  })

  it('updates active turn ids without churn', () => {
    const current = { 'thread-1': 'turn-1' }

    expect(setActiveTurnForThread(current, 'thread-1', 'turn-1')).toBe(current)
    expect(setActiveTurnForThread(current, 'thread-1', 'turn-2')).toEqual({
      'thread-1': 'turn-2',
    })
    expect(setActiveTurnForThread(current, '', 'turn-2')).toBe(current)
    expect(setActiveTurnForThread(current, 'thread-2', '')).toBe(current)

    expect(clearActiveTurnForThread(current, 'missing')).toBe(current)
    expect(clearActiveTurnForThread(current, 'thread-1')).toEqual({})
  })

  it('derives turn lifecycle state from realtime payloads', () => {
    const startedTurn: TurnStartedInfo = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 1_000,
    }
    const completedTurn: TurnCompletedInfo = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 4_500,
    }

    expect(shouldClearUnreadForStartedTurn({ 'thread-1': true }, startedTurn)).toBe(true)
    expect(shouldClearUnreadForStartedTurn({ 'thread-2': true }, startedTurn)).toBe(false)
    expect(buildCompletedTurnSummary({
      completedTurn,
      startedTurn,
      explicitDurationMs: null,
      turnDurationMs: null,
    })).toEqual({
      turnId: 'turn-1',
      durationMs: 3_500,
    })
    expect(buildCompletedTurnSummary({
      completedTurn,
      startedTurn: undefined,
      explicitDurationMs: 120,
      turnDurationMs: null,
    })).toEqual({
      turnId: 'turn-1',
      durationMs: 120,
    })
  })
})
