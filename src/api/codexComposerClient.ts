import { uploadLocalImage, type UploadedLocalImage } from './codexBridgeClient'
import { normalizeCodexApiError } from './codexErrors'
import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'
import type { CodexSkillCatalogGroup, CodexSkillOption } from '@codycodeagent/cody-web-core/session'
import { fetchCodexJson, jsonPostInit, readRpcResult } from './codexHttpClient'

export type SkillCatalogEntry = CodexSkillCatalogGroup

function ownerCwdPath(basePath: string, cwds: string[]): string {
  const query = new URLSearchParams()
  for (const cwd of Array.from(new Set(cwds.map(value => value.trim()).filter(Boolean)))) query.append('cwd', cwd)
  const suffix = query.toString()
  return suffix ? `${basePath}?${suffix}` : basePath
}

async function getOwnerResult<T>(path: string, method: string): Promise<T> {
  const { payload, status } = await fetchCodexJson(path, {
    init: { method: 'GET' },
    method,
    networkErrorMessage: `${method} request failed before it was sent`,
    httpErrorMessage: `${method} request failed`,
    timeoutMs: 25_000,
  })
  return readRpcResult(payload, status, method, `${method} returned malformed envelope`) as T
}

export function toComposerSkill(skill: CodexSkillOption): ComposerSkill | null {
  const name = skill.name
  const path = skill.path
  if (!name || !path || skill.enabled !== true) return null

  return {
    name,
    path,
    displayName: skill.displayName,
    description: skill.description,
  }
}

export async function getAvailableSkills(cwd?: string): Promise<ComposerSkill[]> {
  try {
    const normalizedCwd = cwd?.trim() ?? ''
    return (await getOwnerResult<CodexSkillOption[]>(ownerCwdPath('/codex-api/conversations/skills', normalizedCwd ? [normalizedCwd] : []), 'conversation/skills/list'))
      .map(toComposerSkill).filter((skill): skill is ComposerSkill => skill !== null)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skills', 'skills/list')
  }
}

export async function getSkillCatalog(cwds: string[]): Promise<SkillCatalogEntry[]> {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)))
  if (normalizedCwds.length === 0) return []

  try {
    return await getOwnerResult<SkillCatalogEntry[]>(ownerCwdPath('/codex-api/conversations/skill-catalog', normalizedCwds), 'conversation/skills/catalog')
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skill catalog', 'skills/list')
  }
}

export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  const normalizedPath = path.trim()
  if (!normalizedPath) throw new Error('Skill path is required')

  try {
    const { payload, status } = await fetchCodexJson('/codex-api/conversations/skills/enabled', {
      init: jsonPostInit({ path: normalizedPath, enabled }),
      method: 'conversation/skills/enabled',
      networkErrorMessage: 'Skill update failed before request was sent',
      httpErrorMessage: 'Skill update failed',
      timeoutMs: 25_000,
    })
    readRpcResult(payload, status, 'conversation/skills/enabled', 'Skill update returned malformed envelope')
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to update skill', 'skills/config/write')
  }
}

export async function uploadComposerImage(file: File): Promise<UploadedLocalImage> {
  try {
    return await uploadLocalImage(file)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to upload ${file.name || 'image'}`, 'uploads/images')
  }
}
