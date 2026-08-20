import { computed, ref } from 'vue'
import { getAvailableModelIds, getCollaborationModes, getCurrentModelConfig } from '../api/codexModelClient'
import { fetchUserSetting, writeUserSetting } from '../api/codexSettingsClient'
import type { ReasoningEffort, UiCollaborationModeOption, UiComposerPermissionMode, UiComposerSubmitMode } from '../types/codex'
import { DESKTOP_SETTING_KEYS } from './desktopSettingsKeys'
import { loadDesktopTurnPreferences, normalizeDesktopTurnPreferences, saveDesktopTurnPreferences } from './desktopStateStorage'
import { normalizeComposerPermissionMode } from './desktopTurnPermissions'
import {
  DEFAULT_COLLABORATION_MODE,
  FALLBACK_PLAN_COLLABORATION_MODE,
  mergeAvailableModelsWithCurrent,
  mergeCollaborationModeOptions,
  normalizeSelectedReasoningEffort,
  reconcileSelectedCollaborationModeName,
  selectCollaborationModeName,
  selectModelId,
  selectReasoningEffortFromPreference,
  type CurrentModelPreference,
} from './desktopTurnPreferences'

export function useDesktopComposerState() {
  const initial = loadDesktopTurnPreferences()
  const availableModelIds = ref<string[]>([])
  const selectedModelId = ref(initial.modelId)
  const selectedReasoningEffort = ref<ReasoningEffort | ''>(initial.reasoningEffort)
  const selectedPermissionMode = ref<UiComposerPermissionMode>(initial.permissionMode)
  const selectedSubmitMode = ref<UiComposerSubmitMode>(initial.submitMode)
  const modelContextWindow = ref<number | null>(null)
  const autoCompactTokenLimit = ref<number | null>(null)
  const collaborationModeOptions = ref<UiCollaborationModeOption[]>([DEFAULT_COLLABORATION_MODE, FALLBACK_PLAN_COLLABORATION_MODE])
  const selectedCollaborationModeName = ref(initial.collaborationModeName)
  const selectedCollaborationMode = computed(() => collaborationModeOptions.value.find((option) => option.name === selectedCollaborationModeName.value) ?? DEFAULT_COLLABORATION_MODE)
  let hydrated = false

  const current = () => normalizeDesktopTurnPreferences({ modelId: selectedModelId.value, reasoningEffort: selectedReasoningEffort.value, collaborationModeName: selectedCollaborationModeName.value, permissionMode: selectedPermissionMode.value, submitMode: selectedSubmitMode.value })
  function persist(): void {
    const preferences = current(); saveDesktopTurnPreferences(preferences)
    if (hydrated) void writeUserSetting(DESKTOP_SETTING_KEYS.turnPreferences, preferences).catch(() => undefined)
  }
  async function hydrate(): Promise<void> {
    if (hydrated) return; hydrated = true
    try {
      const setting = await fetchUserSetting<unknown>(DESKTOP_SETTING_KEYS.turnPreferences)
      if (setting) {
        const preferences = normalizeDesktopTurnPreferences(setting.value)
        selectedModelId.value = preferences.modelId; selectedReasoningEffort.value = preferences.reasoningEffort
        selectedCollaborationModeName.value = preferences.collaborationModeName; selectedPermissionMode.value = preferences.permissionMode; selectedSubmitMode.value = preferences.submitMode
        saveDesktopTurnPreferences(preferences); return
      }
    } catch { /* retain local preferences */ }
    const preferences = current(); saveDesktopTurnPreferences(preferences)
    void writeUserSetting(DESKTOP_SETTING_KEYS.turnPreferences, preferences).catch(() => undefined)
  }
  function setSelectedModelId(value: string): void { selectedModelId.value = value.trim(); persist() }
  function setSelectedReasoningEffort(value: ReasoningEffort | ''): void { const normalized = normalizeSelectedReasoningEffort(value); if (normalized !== null) { selectedReasoningEffort.value = normalized; persist() } }
  function setSelectedCollaborationModeName(value: string): void { const normalized = selectCollaborationModeName(value, collaborationModeOptions.value); if (normalized) { selectedCollaborationModeName.value = normalized; persist() } }
  function setSelectedPermissionMode(value: UiComposerPermissionMode): void { selectedPermissionMode.value = normalizeComposerPermissionMode(value); persist() }
  function setSelectedSubmitMode(value: UiComposerSubmitMode): void { selectedSubmitMode.value = value === 'guide' ? 'guide' : 'queue'; persist() }
  async function refreshCollaborationModes(): Promise<void> {
    let remote: UiCollaborationModeOption[] = []; try { remote = await getCollaborationModes() } catch { remote = [] }
    collaborationModeOptions.value = mergeCollaborationModeOptions(remote)
    selectedCollaborationModeName.value = reconcileSelectedCollaborationModeName(selectedCollaborationModeName.value, collaborationModeOptions.value); persist()
  }
  async function refreshModelPreferences(): Promise<void> {
    let ids: string[] = []
    let config: CurrentModelPreference & { modelContextWindow: number | null; autoCompactTokenLimit: number | null } = {
      model: '',
      reasoningEffort: '',
      modelContextWindow: null,
      autoCompactTokenLimit: null,
    }
    try { ids = await getAvailableModelIds() } catch { ids = [] }
    try { config = await getCurrentModelConfig() } catch {
      config = { model: '', reasoningEffort: '', modelContextWindow: null, autoCompactTokenLimit: null }
    }
    availableModelIds.value = mergeAvailableModelsWithCurrent(ids, config.model)
    selectedModelId.value = selectModelId(selectedModelId.value, availableModelIds.value, config.model)
    selectedReasoningEffort.value = selectReasoningEffortFromPreference(selectedReasoningEffort.value, config)
    modelContextWindow.value = config.modelContextWindow ?? null
    autoCompactTokenLimit.value = config.autoCompactTokenLimit ?? null
    persist()
  }
  return { availableModelIds, selectedModelId, selectedReasoningEffort, selectedPermissionMode, selectedSubmitMode, modelContextWindow, autoCompactTokenLimit, collaborationModeOptions, selectedCollaborationModeName, selectedCollaborationMode, hydrate, refreshCollaborationModes, refreshModelPreferences, setSelectedModelId, setSelectedReasoningEffort, setSelectedCollaborationModeName, setSelectedPermissionMode, setSelectedSubmitMode }
}
