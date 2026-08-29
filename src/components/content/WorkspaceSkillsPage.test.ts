// @vitest-environment happy-dom

import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSkillsPage from './WorkspaceSkillsPage.vue'
import { installTestLocalStorage } from '../../test/localStorage'

const skillClientMock = vi.hoisted(() => ({
  getSkillCatalog: vi.fn(),
  setSkillEnabled: vi.fn(),
}))

vi.mock('../../api/codexComposerClient', () => skillClientMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('WorkspaceSkillsPage', () => {
  it('loads, filters, inspects, and toggles real catalog metadata', async () => {
    installTestLocalStorage()
    window.localStorage.clear()
    skillClientMock.getSkillCatalog.mockResolvedValue([{
      cwd: '/repo',
      errors: [],
      skills: [
        {
          name: 'design-system',
          description: 'Build the interface',
          displayName: 'design-system',
          path: '/repo/.codex/skills/design/SKILL.md',
          scope: 'repo',
          enabled: true,
          brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '',
          dependencies: [{ type: 'browser', value: 'Chrome', description: '', transport: '', command: '', url: '' }],
        },
        {
          name: 'docs',
          description: 'Write docs',
          displayName: 'docs',
          path: '/home/skills/docs/SKILL.md',
          scope: 'user',
          enabled: false,
          brandColor: '', iconSmall: '', iconLarge: '', defaultPrompt: '', dependencies: [],
        },
      ],
    }])
    skillClientMock.setSkillEnabled.mockResolvedValue(undefined)

    const wrapper = mount(WorkspaceSkillsPage, { props: { cwd: '/repo', projectLabel: 'Repo' } })
    await flushPromises()

    expect(skillClientMock.getSkillCatalog).toHaveBeenCalledWith(['/repo'])
    expect(wrapper.findAll('.skill-card')).toHaveLength(2)
    expect(wrapper.get('.skill-detail').text()).toContain('design-system')
    expect(wrapper.get('.skill-detail').text()).toContain('Chrome')

    await wrapper.get('.skills-search input').setValue('docs')
    expect(wrapper.findAll('.skill-card')).toHaveLength(1)
    await wrapper.get('.skill-card').trigger('click')
    await wrapper.get('.skill-toggle').trigger('click')

    expect(skillClientMock.setSkillEnabled).toHaveBeenCalledWith('/home/skills/docs/SKILL.md', true)
    expect(wrapper.get('.skill-toggle').attributes('aria-checked')).toBe('true')
  })
})
