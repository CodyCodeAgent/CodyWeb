import { uploadLocalImage, type UploadedLocalImage } from './codexBridgeClient'
import { normalizeCodexApiError } from './codexErrors'
import { rpcCall } from './codexRpcClient'
import type { ComposerSkill } from '@codycodeagent/cody-web-core/composer'
import { CodexSessionCatalog, type CodexSkillCatalogGroup, type CodexSkillOption } from '@codycodeagent/cody-web-core/session'

export type SkillCatalogEntry = CodexSkillCatalogGroup

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

const sessionCatalog = new CodexSessionCatalog({ call: callRpc })

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
    return (await sessionCatalog.listSkills(normalizedCwd ? [normalizedCwd] : []))
      .map(toComposerSkill).filter((skill): skill is ComposerSkill => skill !== null)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skills', 'skills/list')
  }
}

export async function getSkillCatalog(cwds: string[]): Promise<SkillCatalogEntry[]> {
  const normalizedCwds = Array.from(new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)))
  if (normalizedCwds.length === 0) return []

  try {
    return await sessionCatalog.listSkillCatalog(normalizedCwds)
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load skill catalog', 'skills/list')
  }
}

export async function setSkillEnabled(path: string, enabled: boolean): Promise<void> {
  const normalizedPath = path.trim()
  if (!normalizedPath) throw new Error('Skill path is required')

  try {
    await sessionCatalog.setSkillEnabled(normalizedPath, enabled)
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
