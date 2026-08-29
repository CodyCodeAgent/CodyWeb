import type {
  SkillMetadata,
  SkillsListResponse,
} from './appServerDtos'
import { uploadLocalImage, type UploadedLocalImage } from './codexBridgeClient'
import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'

export type SkillCatalogEntry = SkillsListResponse['data'][number]

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

export function toComposerSkill(skill: SkillMetadata): ComposerSkill | null {
  const name = skill.name.trim()
  const path = skill.path.trim()
  if (!name || !path || skill.enabled !== true) return null

  const displayName = skill.interface?.displayName?.trim() || name
  const description =
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description.trim()

  return {
    name,
    path,
    displayName,
    description,
  }
}

export async function getAvailableSkills(cwd?: string): Promise<ComposerSkill[]> {
  try {
    const params: Record<string, unknown> = {}
    const normalizedCwd = cwd?.trim() ?? ''
    if (normalizedCwd.length > 0) {
      params.cwds = [normalizedCwd]
    }

    const payload = await callRpc<SkillsListResponse>('skills/list', params)
    const byKey = new Map<string, ComposerSkill>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        const normalized = toComposerSkill(skill)
        if (!normalized) continue
        byKey.set(`${normalized.name}\n${normalized.path}`, normalized)
      }
    }

    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skills', 'skills/list')
  }
}

export async function getSkillCatalog(cwds: string[]): Promise<SkillCatalogEntry[]> {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)))
  if (normalizedCwds.length === 0) return []

  try {
    const payload = await callRpc<SkillsListResponse>('skills/list', { cwds: normalizedCwds })
    return payload.data
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skill catalog', 'skills/list')
  }
}

export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  const normalizedPath = path.trim()
  if (!normalizedPath) throw new Error('Skill path is required')

  try {
    await callRpc<unknown>('skills/config/write', { path: normalizedPath, enabled })
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
