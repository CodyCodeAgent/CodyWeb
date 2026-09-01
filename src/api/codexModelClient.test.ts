import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAvailableModelIds,
  getCollaborationModes,
  getCurrentModelConfig,
  normalizeCollaborationModeOption,
  normalizeReasoningEffort,
  normalizeTokenLimit,
  setDefaultModel,
} from './codexModelClient'

const rpcMock = vi.hoisted(() => ({
  rpcCall: vi.fn(),
}))
const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
  readRpcResult: vi.fn((payload: unknown) => (payload as { result: unknown }).result),
}))

vi.mock('./codexRpcClient', () => rpcMock)
vi.mock('./codexHttpClient', () => httpMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex model client', () => {
  it('normalizes reasoning efforts and collaboration modes', () => {
    expect(normalizeReasoningEffort('high')).toBe('high')
    expect(normalizeReasoningEffort('wild')).toBe('')

    expect(normalizeCollaborationModeOption({
      name: 'plan-mode',
      mode: 'plan',
      model: 'gpt-5',
      reasoning_effort: 'medium',
      developer_instructions: 'think first',
    })).toEqual({
      name: 'plan-mode',
      mode: 'plan',
      label: 'Plan Mode',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      developerInstructions: 'think first',
    })

    expect(normalizeCollaborationModeOption({
      name: '',
      mode: 'custom' as never,
      model: null,
      reasoning_effort: null,
      developer_instructions: null,
    })).toBeNull()

    expect(normalizeCollaborationModeOption({
      name: 'Plan',
      mode: 'plan',
      model: null,
      reasoning_effort: 'medium',
    })).toEqual({
      name: 'Plan',
      mode: 'plan',
      label: 'Plan',
      model: '',
      reasoningEffort: 'medium',
      developerInstructions: null,
    })
  })

  it('normalizes numeric token limits from app-server payloads', () => {
    expect(normalizeTokenLimit(200_000)).toBe(200_000)
    expect(normalizeTokenLimit('180000')).toBe(180_000)
    expect(normalizeTokenLimit(0)).toBeNull()
    expect(normalizeTokenLimit('unknown')).toBeNull()
  })

  it('loads collaboration modes while dropping invalid and duplicate names', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: [
        {
          name: 'default',
          mode: 'default',
          model: null,
          reasoningEffort: 'low',
          developer_instructions: null,
        },
        {
          name: 'default',
          mode: 'plan',
          model: 'gpt-5',
          reasoningEffort: 'high',
          developer_instructions: null,
        },
        {
          name: 'bad',
          mode: 'other',
          model: null,
          reasoningEffort: null,
          developer_instructions: null,
        },
      ] }, status: 200 })

    await expect(getCollaborationModes()).resolves.toEqual([
      {
        name: 'default',
        mode: 'default',
        label: 'Default',
        model: '',
        reasoningEffort: 'low',
        developerInstructions: null,
      },
    ])
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/collaboration-modes', expect.objectContaining({
      method: 'conversation/collaboration-modes/list',
    }))
  })

  it('loads model ids using id before model and keeps first occurrence', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: [
        { id: 'gpt-5', model: 'fallback', displayName: 'GPT-5', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
        { id: '', model: 'gpt-4.1', displayName: 'GPT-4.1', description: '', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
        { id: 'gpt-5', model: 'duplicate', displayName: 'Duplicate', description: '', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
        { id: '', model: '', displayName: '', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
      ] }, status: 200 })

    await expect(getAvailableModelIds()).resolves.toEqual(['gpt-5', 'gpt-4.1'])
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/models', expect.objectContaining({
      method: 'conversation/models/list',
    }))
  })

  it('loads current model config with normalized reasoning effort', async () => {
    rpcMock.rpcCall.mockResolvedValue({
      config: {
        model: 'gpt-5',
        model_reasoning_effort: 'xhigh',
        model_context_window: '200000',
        model_auto_compact_token_limit: 180000,
      },
    })

    await expect(getCurrentModelConfig()).resolves.toEqual({
      model: 'gpt-5',
      reasoningEffort: 'xhigh',
      modelContextWindow: 200000,
      autoCompactTokenLimit: 180000,
    })
  })

  it('updates the default model', async () => {
    rpcMock.rpcCall.mockResolvedValue({})

    await expect(setDefaultModel('gpt-5')).resolves.toBeUndefined()

    expect(rpcMock.rpcCall).toHaveBeenCalledWith('setDefaultModel', { model: 'gpt-5' })
  })
})
