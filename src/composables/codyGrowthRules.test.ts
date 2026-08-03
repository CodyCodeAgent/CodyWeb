import { describe, expect, it } from 'vitest'
import type { UiDailyTokenUsage } from '../types/codex'
import {
  codyGrowthSnapshot,
  dailyGrowth,
  growthRequiredForLevel,
  levelForGrowth,
  levelIcons,
  normalizeCodyGrowthLedger,
  tokenGrowthBonus,
  updateCodyGrowthLedger,
} from './codyGrowthRules'

function usage(date: string, totalTokens: number): UiDailyTokenUsage {
  return {
    cwd: '', repoRoot: '', generatedAtIso: `${date}T12:00:00.000Z`, date, timezoneOffsetMinutes: -480,
    inputTokens: totalTokens, outputTokens: 0, totalTokens, tokenUsageEventCount: totalTokens > 0 ? 1 : 0,
    threadCount: totalTokens > 0 ? 1 : 0, turnCount: totalTokens > 0 ? 1 : 0,
    costUsd: null, costEventCount: 0, source: totalTokens > 0 ? 'reconciled-rollouts' : 'none', lastReconciledAtIso: null,
  }
}

describe('Cody growth rules', () => {
  it('caps daily token acceleration and uses the QQ quadratic level curve', () => {
    expect(tokenGrowthBonus(9_999)).toBe(0)
    expect(tokenGrowthBonus(100_000)).toBe(0.5)
    expect(tokenGrowthBonus(9_000_000)).toBe(1)
    expect(dailyGrowth(9_000_000)).toBe(2)
    expect(growthRequiredForLevel(16)).toBe(320)
    expect(levelForGrowth(320)).toBe(16)
  })

  it('decomposes levels into crown, sun, moon, and star materials', () => {
    expect(levelIcons(27).map((icon) => icon.kind)).toEqual(['sun', 'moon', 'moon', 'star', 'star', 'star'])
    expect(levelIcons(0)).toEqual([{ kind: 'empty', symbol: '☆' }])
  })

  it('persists one daily value, keeps the high-water mark, and calculates streaks', () => {
    let ledger = normalizeCodyGrowthLedger(null)
    ledger = updateCodyGrowthLedger(ledger, usage('2026-08-01', 100_000))
    ledger = updateCodyGrowthLedger(ledger, usage('2026-08-02', 2_000_000))
    const snapshot = codyGrowthSnapshot(ledger, '2026-08-02')

    expect(snapshot.points).toBe(3.5)
    expect(snapshot.activeDays).toBe(2)
    expect(snapshot.streakDays).toBe(2)

    const corrected = updateCodyGrowthLedger(ledger, usage('2026-08-02', 0))
    expect(corrected.highestGrowth).toBe(3.5)
    expect(corrected.dailyTokens['2026-08-02']).toBe(2_000_000)
  })
})
