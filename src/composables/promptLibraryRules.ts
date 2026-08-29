import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'

export type PromptTemplateScope = 'global' | 'workspace'
export type ScenarioPackageAuthoringMode = 'human' | 'ai'

export type PromptTemplate = {
  id: string
  title: string
  description: string
  content: string
  primarySkill: ComposerSkill | null
  authoringMode: ScenarioPackageAuthoringMode
  category: string
  scope: PromptTemplateScope
  workspaceCwd: string
  isFavorite: boolean
  useCount: number
  lastUsedAtIso: string
  createdAtIso: string
  updatedAtIso: string
}

export type PromptInsertion = {
  id: number
  text: string
  skills: ComposerSkill[]
  mode: 'insert' | 'replace'
}

const DEFAULT_PROMPTS: Array<Pick<PromptTemplate, 'id' | 'title' | 'description' | 'content' | 'category'>> = [
  {
    id: 'builtin-code-review',
    title: 'Review the current changes',
    description: 'Inspect correctness, regressions, security, and missing tests.',
    category: 'Review',
    content: 'Review the current workspace changes. Prioritize concrete bugs, regressions, security risks, and missing test coverage. Cite affected files and lines. Do not modify code unless I ask you to.',
  },
  {
    id: 'builtin-debug-root-cause',
    title: 'Find the root cause',
    description: 'Trace a problem through evidence before proposing a fix.',
    category: 'Debug',
    content: 'Diagnose this problem from the evidence in the repository and runtime. Trace the full data flow, identify the root cause, distinguish symptoms from causes, and explain the smallest safe fix. Do not implement until the diagnosis is supported.',
  },
  {
    id: 'builtin-ship-feature',
    title: 'Build and verify a feature',
    description: 'Implement a scoped feature with proportional validation.',
    category: 'Build',
    content: 'Implement the requested feature end to end. Preserve existing behavior outside the requested scope, add focused tests for the new behavior, run type checks and the relevant build, and summarize the result and any remaining risks.',
  },
  {
    id: 'builtin-explain-system',
    title: 'Explain this system',
    description: 'Create a concise architecture and data-flow walkthrough.',
    category: 'Understand',
    content: 'Study this system and explain how it works from entry point to outcome. Cover the main components, data flow, state ownership, important failure paths, and the best files to read next. Use a diagram only when it materially improves clarity.',
  },
]

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function createPromptTemplateId(cryptoValue: { randomUUID?: () => string } | null | undefined = globalThis.crypto): string {
  if (typeof cryptoValue?.randomUUID === 'function') return `prompt-${cryptoValue.randomUUID()}`
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function defaultPromptTemplates(now = new Date().toISOString()): PromptTemplate[] {
  return DEFAULT_PROMPTS.map((prompt) => ({
    ...prompt,
    primarySkill: null,
    authoringMode: 'human',
    scope: 'global',
    workspaceCwd: '',
    isFavorite: false,
    useCount: 0,
    lastUsedAtIso: '',
    createdAtIso: now,
    updatedAtIso: now,
  }))
}

export function normalizePromptTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) return defaultPromptTemplates()
  const templates: PromptTemplate[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const id = string(row.id)
    const title = string(row.title)
    const content = string(row.content)
    if (!id || !title || !content) continue
    const scope: PromptTemplateScope = row.scope === 'workspace' ? 'workspace' : 'global'
    templates.push({
      id,
      title,
      description: string(row.description),
      content,
      primarySkill: normalizePrimarySkill(row.primarySkill),
      authoringMode: row.authoringMode === 'ai' ? 'ai' : 'human',
      category: string(row.category) || 'General',
      scope,
      workspaceCwd: scope === 'workspace' ? string(row.workspaceCwd) : '',
      isFavorite: row.isFavorite === true,
      useCount: typeof row.useCount === 'number' && Number.isFinite(row.useCount) ? Math.max(0, row.useCount) : 0,
      lastUsedAtIso: string(row.lastUsedAtIso),
      createdAtIso: string(row.createdAtIso) || new Date().toISOString(),
      updatedAtIso: string(row.updatedAtIso) || new Date().toISOString(),
    })
  }
  return templates.length > 0 ? templates : defaultPromptTemplates()
}

export function visiblePromptTemplates(templates: PromptTemplate[], cwd: string, query: string, category = 'All'): PromptTemplate[] {
  const normalizedCwd = cwd.trim()
  const needle = query.trim().toLocaleLowerCase()
  return templates
    .filter((template) => template.scope === 'global' || (normalizedCwd && template.workspaceCwd === normalizedCwd))
    .filter((template) => category === 'All' || template.category === category)
    .filter((template) => !needle || [template.title, template.description, template.content, template.category, template.primarySkill?.displayName ?? '', template.primarySkill?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(needle)))
    .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || Date.parse(right.lastUsedAtIso || '') - Date.parse(left.lastUsedAtIso || '') || left.title.localeCompare(right.title))
}

function normalizePrimarySkill(value: unknown): ComposerSkill | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const name = string(row.name)
  const path = string(row.path)
  if (!name || !path) return null
  return {
    name,
    path,
    displayName: string(row.displayName) || name,
    description: string(row.description),
  }
}

export function insertPromptIntoDraft(draft: string, prompt: string, cursor: number, mode: PromptInsertion['mode']): { text: string; cursor: number } {
  const normalizedPrompt = prompt.trim()
  if (mode === 'replace' || !draft) return { text: normalizedPrompt, cursor: normalizedPrompt.length }
  const safeCursor = Math.max(0, Math.min(cursor, draft.length))
  const before = draft.slice(0, safeCursor)
  const after = draft.slice(safeCursor)
  const prefix = before && !/\s$/u.test(before) ? '\n\n' : ''
  const suffix = after && !/^\s/u.test(after) ? '\n\n' : ''
  const text = `${before}${prefix}${normalizedPrompt}${suffix}${after}`
  return { text, cursor: before.length + prefix.length + normalizedPrompt.length }
}
