import { getAccountRateLimits } from '../api/codexRateLimitClient'
import type { UiRateLimitSnapshot } from '../types/codex'
import { useAuthoritativeResource } from './useAuthoritativeResource'

export function useRateLimitState() {
  const resource = useAuthoritativeResource<UiRateLimitSnapshot | null>(getAccountRateLimits)

  return {
    rateLimitSnapshot: resource.value,
    isLoadingRateLimits: resource.isLoading,
    rateLimitError: resource.error,
    refreshRateLimits: resource.refresh,
  }
}
