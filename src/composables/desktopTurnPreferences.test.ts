import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COLLABORATION_MODE,
  FALLBACK_PLAN_COLLABORATION_MODE,
  buildPendingTurnDetails,
  buildTurnCollaborationMode,
  isReasoningEffort,
  mergeAvailableModelsWithCurrent,
  mergeCollaborationModeOptions,
  normalizeSelectedReasoningEffort,
  reconcileSelectedCollaborationModeName,
  selectCollaborationModeName,
  selectModelId,
  selectReasoningEffortFromPreference,
} from './desktopTurnPreferences'
import type { UiCollaborationModeOption } from '../types/codex'

function planMode(overrides: Partial<UiCollaborationModeOption> = {}): UiCollaborationModeOption {
  return {
    name: 'plan',
    mode: 'plan',
    label: 'Plan',
    model: '',
    reasoningEffort: '',
    developerInstructions: null,
    ...overrides,
  }
}

describe('desktopTurnPreferences', () => {
  it('validates and normalizes reasoning effort choices', () => {
    expect(isReasoningEffort('medium')).toBe(true)
    expect(isReasoningEffort('wild')).toBe(false)
    expect(normalizeSelectedReasoningEffort('high')).toBe('high')
    expect(normalizeSelectedReasoningEffort('')).toBe('')
    expect(normalizeSelectedReasoningEffort('wild' as never)).toBeNull()
  })

  it('merges collaboration modes with default and plan fallback', () => {
    const customPlan = planMode({ name: 'custom-plan', label: 'Custom plan' })
    const duplicate = planMode({ name: 'custom-plan', label: 'Duplicate' })
    const merged = mergeCollaborationModeOptions([
      DEFAULT_COLLABORATION_MODE,
      customPlan,
      duplicate,
    ])

    expect(merged).toEqual([DEFAULT_COLLABORATION_MODE, customPlan])
    expect(mergeCollaborationModeOptions([])).toEqual([
      DEFAULT_COLLABORATION_MODE,
      FALLBACK_PLAN_COLLABORATION_MODE,
    ])
  })

  it('selects and reconciles collaboration mode names', () => {
    const options = mergeCollaborationModeOptions([
      planMode({ name: 'planner' }),
      planMode({ name: 'Plan', label: 'Plan' }),
    ])

    expect(selectCollaborationModeName(' planner ', options)).toBe('planner')
    expect(selectCollaborationModeName('PLAN', options)).toBe('Plan')
    expect(selectCollaborationModeName('', options)).toBe(DEFAULT_COLLABORATION_MODE.name)
    expect(selectCollaborationModeName('missing', options)).toBe('')
    expect(reconcileSelectedCollaborationModeName('missing', options)).toBe(DEFAULT_COLLABORATION_MODE.name)
    expect(reconcileSelectedCollaborationModeName('planner', options)).toBe('planner')
    expect(reconcileSelectedCollaborationModeName('plan', options)).toBe('Plan')
  })

  it('builds pending turn details with optional mode labeling', () => {
    expect(buildPendingTurnDetails('', '')).toEqual(['Model: default', 'Thinking: default'])
    expect(buildPendingTurnDetails('gpt-5', 'high', planMode({ label: 'Plan first' }))).toEqual([
      'Mode: Plan first',
      'Model: gpt-5',
      'Thinking: high',
    ])
  })

  it('builds explicit collaboration payloads for default and plan mode', () => {
    expect(buildTurnCollaborationMode(DEFAULT_COLLABORATION_MODE, 'gpt-5', 'medium')).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(buildTurnCollaborationMode(
      planMode({
        model: '',
        reasoningEffort: '',
        developerInstructions: 'Think first',
      }),
      'gpt-5',
      'medium',
    )).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5',
        reasoning_effort: 'medium',
        developer_instructions: 'Think first',
      },
    })
  })

  it('merges available models and selects the best current model', () => {
    expect(mergeAvailableModelsWithCurrent(['gpt-5'], 'codex')).toEqual(['codex', 'gpt-5'])
    expect(mergeAvailableModelsWithCurrent(['gpt-5'], 'gpt-5')).toEqual(['gpt-5'])

    expect(selectModelId('gpt-5', ['gpt-5', 'codex'], 'codex')).toBe('gpt-5')
    expect(selectModelId('missing', ['gpt-5'], 'codex')).toBe('codex')
    expect(selectModelId('', ['gpt-5'], '')).toBe('gpt-5')
    expect(selectModelId('', [], '')).toBe('')
  })

  it('updates reasoning effort only when current config is valid', () => {
    expect(selectReasoningEffortFromPreference('medium', {
      model: 'gpt-5',
      reasoningEffort: 'high',
    })).toBe('high')
    expect(selectReasoningEffortFromPreference('medium', {
      model: 'gpt-5',
      reasoningEffort: '',
    })).toBe('medium')
  })
})
