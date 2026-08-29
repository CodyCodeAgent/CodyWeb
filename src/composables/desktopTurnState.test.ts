import { describe, expect, it } from 'vitest'
import type { ComposerSubmission } from '@codycodeagent/cody-web-core/composer'
import {
  buildPendingTurnActivity,
  buildSteeringTurnActivity,
  normalizeComposerTurnInput,
  normalizeNewThreadTurnInput,
  normalizeThreadTextTurnInput,
} from './desktopTurnState'
import type { UiComposerContextKind } from '../types/codex'

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

})
