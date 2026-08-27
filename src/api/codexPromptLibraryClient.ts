import { CodexApiError } from './codexErrors'
import { asRecord, fetchCodexResultRecord, jsonPostInit } from './codexHttpClient'
import type { PromptTemplate } from '../composables/promptLibraryRules'
import type { UiComposerSkill } from '../types/codex'

const PROMPT_MUTATION_TIMEOUT_MS = 12_000

export type ScenarioPackageDraft = Pick<PromptTemplate, 'title' | 'description' | 'category' | 'content'> & {
  primarySkill: UiComposerSkill | null
  reason: string
}

function promptMutationInit(body: unknown): RequestInit {
  return {
    ...jsonPostInit(body),
    signal: AbortSignal.timeout(PROMPT_MUTATION_TIMEOUT_MS),
  }
}

function normalizeTemplates(value: unknown, status: number): PromptTemplate[] {
  if (!Array.isArray(value)) throw new CodexApiError('Prompt library returned malformed response', { code: 'invalid_response', method: 'prompt-templates', status })
  return value as PromptTemplate[]
}

export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/prompt-templates', {
    method: 'prompt-templates/list', networkErrorMessage: 'Prompt library request failed before it was sent',
    httpErrorMessage: 'Prompt library request failed', malformedMessage: 'Prompt library returned malformed response',
  })
  return normalizeTemplates(result.templates, status)
}

export async function replacePromptTemplates(templates: PromptTemplate[]): Promise<PromptTemplate[]> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/prompt-templates', {
    init: jsonPostInit({ templates }), method: 'prompt-templates/replace',
    networkErrorMessage: 'Prompt library save failed before it was sent', httpErrorMessage: 'Prompt library save failed',
    malformedMessage: 'Prompt library save returned malformed response',
  })
  const row = asRecord(result)
  return normalizeTemplates(row?.templates, status)
}

function normalizeTemplateResult(value: unknown, status: number): PromptTemplate {
  const row = asRecord(value)
  if (!row) throw new CodexApiError('Prompt library returned malformed template', { code: 'invalid_response', method: 'prompt-templates/item', status })
  return row as PromptTemplate
}

export async function savePromptTemplate(template: PromptTemplate, expectedUpdatedAt = ''): Promise<PromptTemplate> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/prompt-templates/item', {
    init: promptMutationInit({ template, expectedUpdatedAt }), method: 'prompt-templates/save',
    networkErrorMessage: 'Prompt save failed before it was sent', httpErrorMessage: 'Prompt save failed', malformedMessage: 'Prompt save returned malformed response',
  })
  return normalizeTemplateResult(result.template, status)
}

export async function deletePromptTemplate(id: string, expectedUpdatedAt = ''): Promise<void> {
  await fetchCodexResultRecord(`/codex-api/prompt-templates/item?id=${encodeURIComponent(id)}&expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`, {
    init: { method: 'DELETE', signal: AbortSignal.timeout(PROMPT_MUTATION_TIMEOUT_MS) }, method: 'prompt-templates/delete', networkErrorMessage: 'Prompt delete failed before it was sent',
    httpErrorMessage: 'Prompt delete failed', malformedMessage: 'Prompt delete returned malformed response',
  })
}

export async function recordPromptTemplateUse(id: string, usedAtIso: string): Promise<PromptTemplate> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/prompt-templates/use', {
    init: promptMutationInit({ id, usedAtIso }), method: 'prompt-templates/use', networkErrorMessage: 'Prompt usage update failed before it was sent',
    httpErrorMessage: 'Prompt usage update failed', malformedMessage: 'Prompt usage update returned malformed response',
  })
  return normalizeTemplateResult(result.template, status)
}

export async function setPromptTemplateFavorite(id: string, isFavorite: boolean): Promise<PromptTemplate> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/prompt-templates/favorite', {
    init: promptMutationInit({ id, isFavorite }), method: 'prompt-templates/favorite', networkErrorMessage: 'Prompt favorite update failed before it was sent',
    httpErrorMessage: 'Prompt favorite update failed', malformedMessage: 'Prompt favorite update returned malformed response',
  })
  return normalizeTemplateResult(result.template, status)
}

export async function draftScenarioPackage(cwd: string, brief: string): Promise<ScenarioPackageDraft> {
  const { result, status } = await fetchCodexResultRecord('/codex-api/scenario-packages/draft', {
    init: { ...jsonPostInit({ cwd, brief }), signal: AbortSignal.timeout(90_000) },
    method: 'scenario-packages/draft',
    networkErrorMessage: 'Scenario package draft failed before it was sent',
    httpErrorMessage: 'Scenario package draft failed',
    malformedMessage: 'Scenario package draft returned malformed data',
  })
  const row = asRecord(result.draft)
  if (!row || typeof row.title !== 'string' || typeof row.content !== 'string') {
    throw new CodexApiError('Scenario package draft returned malformed data', { code: 'invalid_response', method: 'scenario-packages/draft', status })
  }
  const skill = asRecord(row.primarySkill)
  const primarySkill = skill && typeof skill.name === 'string' && typeof skill.path === 'string'
    ? {
        name: skill.name,
        path: skill.path,
        displayName: typeof skill.displayName === 'string' ? skill.displayName : skill.name,
        description: typeof skill.description === 'string' ? skill.description : '',
      }
    : null
  return {
    title: row.title,
    description: typeof row.description === 'string' ? row.description : '',
    category: typeof row.category === 'string' ? row.category : 'General',
    content: row.content,
    primarySkill,
    reason: typeof row.reason === 'string' ? row.reason : '',
  }
}
