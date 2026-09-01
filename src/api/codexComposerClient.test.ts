import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAvailableSkills,
  getSkillCatalog,
  setSkillEnabled,
  toComposerSkill,
  uploadComposerImage,
} from './codexComposerClient'

const bridgeMock = vi.hoisted(() => ({
  uploadLocalImage: vi.fn(),
}))
const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
  jsonPostInit: vi.fn((body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })),
  readRpcResult: vi.fn((payload: unknown) => (payload as { result: unknown }).result),
}))

vi.mock('./codexBridgeClient', () => bridgeMock)
vi.mock('./codexHttpClient', () => httpMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex composer client', () => {
  it('normalizes enabled skills for composer display', () => {
    expect(toComposerSkill({
      name: 'docs',
      path: '/skills/docs',
      enabled: true,
      description: 'Use docs',
      displayName: 'Docs',
      scope: 'repo',
      brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
    })).toEqual({
      name: 'docs',
      path: '/skills/docs',
      displayName: 'Docs',
      description: 'Use docs',
    })

    expect(toComposerSkill({
      name: 'disabled',
      path: '/skills/disabled',
      enabled: false,
      description: '',
      displayName: 'disabled',
      scope: 'repo',
      brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
    })).toBeNull()
  })

  it('loads available skills with cwd filtering, de-duping, and name sorting', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: [
      {
        name: 'alpha', path: '/skills/alpha', enabled: true, description: 'duplicate', displayName: 'alpha',
        scope: 'repo', brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
      },
      {
        name: 'zeta', path: '/skills/zeta', enabled: true, description: '', displayName: 'zeta',
        scope: 'repo', brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
      },
    ] }, status: 200 })

    await expect(getAvailableSkills(' /repo ')).resolves.toEqual([
      {
        name: 'alpha',
        path: '/skills/alpha',
        displayName: 'alpha',
        description: 'duplicate',
      },
      {
        name: 'zeta',
        path: '/skills/zeta',
        displayName: 'zeta',
        description: '',
      },
    ])
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/skills?cwd=%2Frepo', expect.objectContaining({
      method: 'conversation/skills/list',
    }))
  })

  it('wraps composer image upload failures with the file name', async () => {
    bridgeMock.uploadLocalImage.mockRejectedValue(new Error('disk full'))

    await expect(uploadComposerImage({
      name: 'screen.png',
      type: 'image/png',
    } as File)).rejects.toMatchObject({
      name: 'CodexApiError',
      message: 'disk full',
      method: 'uploads/images',
    })
  })

  it('loads skill catalog entries for unique normalized workspaces', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: [{ cwd: '/repo', skills: [], errors: [] }] }, status: 200 })

    await expect(getSkillCatalog([' /repo ', '/repo', ''])).resolves.toEqual([
      { cwd: '/repo', skills: [], errors: [] },
    ])
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/skill-catalog?cwd=%2Frepo', expect.objectContaining({
      method: 'conversation/skills/catalog',
    }))
  })

  it('updates skill enabled state by path', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: { ok: true } }, status: 200 })

    await expect(setSkillEnabled(' /skills/design/SKILL.md ', false)).resolves.toBeUndefined()
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/conversations/skills/enabled', expect.objectContaining({
      method: 'conversation/skills/enabled',
    }))
    expect(httpMock.jsonPostInit).toHaveBeenCalledWith({ path: '/skills/design/SKILL.md', enabled: false })
  })
})
