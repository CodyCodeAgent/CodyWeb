import { computed, ref } from 'vue'
import { getAvailableSkills } from '../api/codexComposerClient'
import {
  findComposerTrigger,
  removeComposerTrigger,
  type ComposerSkill,
  type ComposerTrigger,
} from '@codycodeagent/cody-web-core/composer'

export function useComposerSkills() {
  const selectedSkills = ref<ComposerSkill[]>([])
  const availableSkills = ref<ComposerSkill[]>([])
  const skillError = ref('')
  const isLoadingSkills = ref(false)
  const activeTrigger = ref<ComposerTrigger | null>(null)
  let loadedCwd = ''

  const filteredSkills = computed(() => {
    const trigger = activeTrigger.value
    if (!trigger) return []

    const selectedKeys = new Set(selectedSkills.value.map((skill) => `${skill.name}\n${skill.path}`))
    const query = trigger.query
    return availableSkills.value
      .filter((skill) => !selectedKeys.has(`${skill.name}\n${skill.path}`))
      .filter((skill) => {
        if (!query) return true
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.displayName.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        )
      })
      .slice(0, 8)
  })

  const isSkillMenuOpen = computed(() => activeTrigger.value !== null)

  async function ensureSkillsLoaded(cwd: string): Promise<void> {
    const normalizedCwd = cwd.trim()
    if (loadedCwd === normalizedCwd && availableSkills.value.length > 0) return

    isLoadingSkills.value = true
    skillError.value = ''
    try {
      availableSkills.value = await getAvailableSkills(normalizedCwd || undefined)
      loadedCwd = normalizedCwd
    } catch (error) {
      skillError.value = error instanceof Error ? error.message : 'Failed to load skills'
      availableSkills.value = []
    } finally {
      isLoadingSkills.value = false
    }
  }

  async function updateSkillTrigger(text: string, cursor: number, cwd: string): Promise<void> {
    const trigger = findComposerTrigger(text, cursor, '$')
    activeTrigger.value = trigger
    if (!trigger) return
    await ensureSkillsLoaded(cwd)
  }

  function selectSkill(skill: ComposerSkill, draft: string): { text: string; cursor: number } {
    const trigger = activeTrigger.value
    if (!trigger) return { text: draft, cursor: draft.length }

    const exists = selectedSkills.value.some((selected) => selected.name === skill.name && selected.path === skill.path)
    if (!exists) {
      selectedSkills.value = [...selectedSkills.value, skill]
    }

    const nextDraft = removeComposerTrigger(draft, trigger)
    activeTrigger.value = null
    return nextDraft
  }

  function removeSkill(skill: ComposerSkill): void {
    selectedSkills.value = selectedSkills.value.filter(
      (selected) => selected.name !== skill.name || selected.path !== skill.path,
    )
  }

  function addSkill(skill: ComposerSkill): void {
    const name = skill.name.trim()
    const path = skill.path.trim()
    if (!name || !path) return
    const exists = selectedSkills.value.some((selected) => selected.name === name && selected.path === path)
    if (!exists) selectedSkills.value = [...selectedSkills.value, { ...skill, name, path }]
  }

  function closeSkillMenu(): void {
    activeTrigger.value = null
  }

  function resetSkills(): void {
    selectedSkills.value = []
    activeTrigger.value = null
    skillError.value = ''
  }

  return {
    selectedSkills,
    filteredSkills,
    isSkillMenuOpen,
    isLoadingSkills,
    skillError,
    updateSkillTrigger,
    selectSkill,
    addSkill,
    removeSkill,
    closeSkillMenu,
    resetSkills,
  }
}
