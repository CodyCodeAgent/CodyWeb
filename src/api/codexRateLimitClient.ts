import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from './appServerDtos'
import { fetchCodexJson, readRpcResult } from './codexHttpClient'
import type {
  UiRateLimitSnapshot,
  UiRateLimitWindow,
} from '../types/codex'

type AccountRateLimitsPayload = GetAccountRateLimitsResponse & {
  rateLimitResetCredits?: {
    availableCount?: number | null
  } | null
}

function normalizeRateLimitWindow(window: RateLimitWindow | null | undefined): UiRateLimitWindow | null {
  if (!window) return null

  return {
    usedPercent: Number.isFinite(window.usedPercent)
      ? Math.min(Math.max(window.usedPercent, 0), 100)
      : 0,
    windowDurationMins: typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null,
    resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null,
  }
}

export function normalizeRateLimitSnapshot(
  snapshot: RateLimitSnapshot | null | undefined,
  availableResetCredits: number | null = null,
): UiRateLimitSnapshot | null {
  if (!snapshot) return null

  return {
    limitId: snapshot.limitId ?? '',
    limitName: snapshot.limitName ?? '',
    planType: snapshot.planType ?? '',
    primary: normalizeRateLimitWindow(snapshot.primary),
    secondary: normalizeRateLimitWindow(snapshot.secondary),
    credits: snapshot.credits
      ? {
          hasCredits: snapshot.credits.hasCredits,
          unlimited: snapshot.credits.unlimited,
          balance: snapshot.credits.balance ?? '',
        }
      : null,
    availableResetCredits,
  }
}

function pickPrimaryAccountLimit(payload: AccountRateLimitsPayload): RateLimitSnapshot | null {
  return payload.rateLimitsByLimitId?.codex ?? payload.rateLimits ?? null
}

export async function getAccountRateLimits(): Promise<UiRateLimitSnapshot | null> {
  const { payload: envelope, status } = await fetchCodexJson('/codex-api/account/rate-limits', {
    init: { method: 'GET' }, method: 'account/rateLimits/read',
    networkErrorMessage: 'Account rate limits failed before request was sent',
    httpErrorMessage: 'Account rate limits failed', timeoutMs: 25_000,
  })
  const payload = readRpcResult<AccountRateLimitsPayload>(envelope, status, 'account/rateLimits/read', 'Account rate limits returned malformed envelope')
  const resetCredits =
    typeof payload.rateLimitResetCredits?.availableCount === 'number'
      ? payload.rateLimitResetCredits.availableCount
      : null
  return normalizeRateLimitSnapshot(pickPrimaryAccountLimit(payload), resetCredits)
}
