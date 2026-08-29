import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAvailableSkills,
  getSkillCatalog,
  setSkillEnabled,
  toComposerSkill,
  uploadComposerImage,
} from './codexComposerClient'

const rpcMock = vi.hoisted(() => ({
  rpcCall: vi.fn(),
}))

const bridgeMock = vi.hoisted(() => ({
  uploadLocalImage: vi.fn(),
}))

vi.mock('./codexBridgeClient', () => bridgeMock)
vi.mock('./codexRpcClient', () => rpcMock)

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
    rpcMock.rpcCall.mockResolvedValue({
      data: [
        {
          cwd: '/repo',
          skills: [
            {
              name: 'zeta',
              path: '/skills/zeta',
              enabled: true,
              description: '',
              shortDescription: '',
              scope: 'repo', interface: undefined,
            },
            {
              name: 'alpha',
              path: '/skills/alpha',
              enabled: true,
              description: 'Alpha long',
              shortDescription: '',
              scope: 'repo', interface: undefined,
            },
          ], errors: [],
        },
        {
          cwd: '/repo',
          skills: [
            {
              name: 'alpha',
              path: '/skills/alpha',
              enabled: true,
              description: 'duplicate',
              shortDescription: '',
              scope: 'repo', interface: undefined,
            },
            {
              name: 'beta',
              path: '',
              enabled: true,
              description: '',
              shortDescription: '',
              scope: 'repo', interface: undefined,
            },
          ], errors: [],
        },
      ],
    })

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
    expect(rpcMock.rpcCall).toHaveBeenCalledWith('skills/list', { cwds: ['/repo'] })
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
    rpcMock.rpcCall.mockResolvedValue({ data: [{ cwd: '/repo', skills: [], errors: [] }] })

    await expect(getSkillCatalog([' /repo ', '/repo', ''])).resolves.toEqual([
      { cwd: '/repo', skills: [], errors: [] },
    ])
    expect(rpcMock.rpcCall).toHaveBeenCalledWith('skills/list', { cwds: ['/repo'] })
  })

  it('updates skill enabled state by path', async () => {
    rpcMock.rpcCall.mockResolvedValue({})

    await expect(setSkillEnabled(' /skills/design/SKILL.md ', false)).resolves.toBeUndefined()
    expect(rpcMock.rpcCall).toHaveBeenCalledWith('skills/config/write', {
      path: '/skills/design/SKILL.md',
      enabled: false,
    })
  })
})
