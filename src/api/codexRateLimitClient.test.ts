import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAccountRateLimits,
  normalizeRateLimitSnapshot,
} from './codexRateLimitClient'

const httpMock = vi.hoisted(() => ({
  fetchCodexJson: vi.fn(),
  readRpcResult: vi.fn((payload: unknown) => (payload as { result: unknown }).result),
}))

vi.mock('./codexHttpClient', () => httpMock)

afterEach(() => {
  vi.clearAllMocks()
})

describe('codex rate limit client', () => {
  it('normalizes snapshots and clamps window percentages', () => {
    expect(normalizeRateLimitSnapshot({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      primary: {
        usedPercent: 125,
        windowDurationMins: 300,
        resetsAt: 1780000000000,
      },
      secondary: {
        usedPercent: -4,
        windowDurationMins: null,
        resetsAt: null,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: null,
      },
    }, 2)).toEqual({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: 1780000000000,
      },
      secondary: {
        usedPercent: 0,
        windowDurationMins: null,
        resetsAt: null,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '',
      },
      availableResetCredits: 2,
    })
  })

  it('loads codex account rate limits and reset credits', async () => {
    httpMock.fetchCodexJson.mockResolvedValue({ payload: { result: {
      rateLimits: {
        limitId: 'fallback',
        limitName: 'Fallback',
        planType: 'pro',
        primary: null,
        secondary: null,
        credits: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'team',
          primary: {
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: 1780000000000,
          },
          secondary: null,
          credits: null,
        },
      },
      rateLimitResetCredits: {
        availableCount: 3,
      },
    } }, status: 200 })

    await expect(getAccountRateLimits()).resolves.toEqual({
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'team',
      primary: {
        usedPercent: 42,
        windowDurationMins: 300,
        resetsAt: 1780000000000,
      },
      secondary: null,
      credits: null,
      availableResetCredits: 3,
    })
    expect(httpMock.fetchCodexJson).toHaveBeenCalledWith('/codex-api/account/rate-limits', expect.objectContaining({ method: 'account/rateLimits/read' }))
  })
})
