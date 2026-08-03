import { computed, ref, watch, type Ref } from 'vue'
import { fetchUserSetting, writeUserSetting } from '../api/codexSettingsClient'
import { fetchDailyTokenUsage } from '../api/codexTokenUsageClient'
import { DESKTOP_SETTING_KEYS } from './desktopSettingsKeys'
import {
  codyGrowthSnapshot,
  EMPTY_CODY_GROWTH_LEDGER,
  normalizeCodyGrowthLedger,
  updateCodyGrowthLedger,
} from './codyGrowthRules'

export function useCodyGrowth(options: { cwd: Ref<string>; enabled: Ref<boolean> }) {
  const ledger = ref(EMPTY_CODY_GROWTH_LEDGER)
  const todayKey = ref('')
  const isLoading = ref(false)
  const error = ref<'' | 'load' | 'save'>('')
  let requestVersion = 0

  const snapshot = computed(() => codyGrowthSnapshot(ledger.value, todayKey.value))

  async function refresh(): Promise<void> {
    const cwd = options.cwd.value.trim()
    if (!options.enabled.value || !cwd) return
    const version = ++requestVersion
    isLoading.value = true
    try {
      const [stored, usage] = await Promise.all([
        fetchUserSetting<unknown>(DESKTOP_SETTING_KEYS.codyGrowth),
        fetchDailyTokenUsage(cwd, new Date(), 'global'),
      ])
      if (version !== requestVersion) return
      const nextLedger = updateCodyGrowthLedger(normalizeCodyGrowthLedger(stored?.value), usage)
      ledger.value = nextLedger
      todayKey.value = usage.date
      error.value = ''
      void writeUserSetting(DESKTOP_SETTING_KEYS.codyGrowth, nextLedger).catch(() => {
        error.value = 'save'
      })
    } catch {
      if (version === requestVersion) error.value = 'load'
    } finally {
      if (version === requestVersion) isLoading.value = false
    }
  }

  watch([options.cwd, options.enabled], () => { void refresh() }, { immediate: true })

  return { snapshot, isLoading, error, refresh }
}
