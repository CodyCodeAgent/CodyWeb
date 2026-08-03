import type { UiDailyTokenUsage } from '../types/codex'

export type CodyGrowthLedger = {
  schemaVersion: 1
  dailyTokens: Record<string, number>
  highestGrowth: number
}

export type CodyGrowthSnapshot = {
  level: number
  points: number
  percent: number
  remaining: number
  icons: Array<{ kind: 'crown' | 'sun' | 'moon' | 'star' | 'empty'; symbol: string }>
  activeDays: number
  streakDays: number
  todayTokens: number
}

export const EMPTY_CODY_GROWTH_LEDGER: CodyGrowthLedger = {
  schemaVersion: 1,
  dailyTokens: {},
  highestGrowth: 0,
}

export function tokenGrowthBonus(totalTokens: number): number {
  const tokens = Math.max(0, Number(totalTokens) || 0)
  if (tokens >= 2_000_000) return 1
  if (tokens >= 500_000) return 0.75
  if (tokens >= 100_000) return 0.5
  if (tokens >= 10_000) return 0.25
  return 0
}

export function dailyGrowth(totalTokens: number): number {
  return totalTokens > 0 ? 1 + tokenGrowthBonus(totalTokens) : 0
}

export function growthRequiredForLevel(level: number): number {
  const normalized = Math.max(0, Math.floor(Number(level) || 0))
  return normalized * normalized + 4 * normalized
}

export function levelForGrowth(growth: number): number {
  return Math.max(0, Math.floor(Math.sqrt(Math.max(0, Number(growth) || 0) + 4) - 2))
}

export function levelIcons(level: number): CodyGrowthSnapshot['icons'] {
  let remaining = Math.max(0, Math.floor(Number(level) || 0))
  const parts = [
    { kind: 'crown' as const, symbol: '♛', count: Math.floor(remaining / 64) },
    { kind: 'sun' as const, symbol: '☀', count: 0 },
    { kind: 'moon' as const, symbol: '☾', count: 0 },
    { kind: 'star' as const, symbol: '★', count: 0 },
  ]
  remaining %= 64
  parts[1].count = Math.floor(remaining / 16)
  remaining %= 16
  parts[2].count = Math.floor(remaining / 4)
  parts[3].count = remaining % 4
  const icons = parts.flatMap((part) => Array.from({ length: part.count }, () => ({ kind: part.kind, symbol: part.symbol })))
  return icons.length > 0 ? icons.slice(0, 12) : [{ kind: 'empty', symbol: '☆' }]
}

function validDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
}

export function normalizeCodyGrowthLedger(value: unknown): CodyGrowthLedger {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const dailyRow = row.dailyTokens && typeof row.dailyTokens === 'object' && !Array.isArray(row.dailyTokens)
    ? row.dailyTokens as Record<string, unknown>
    : {}
  const entries = Object.entries(dailyRow)
    .filter(([date, tokens]) => validDateKey(date) && Number.isFinite(Number(tokens)) && Number(tokens) >= 0)
    .sort(([first], [second]) => first.localeCompare(second))
    .slice(-3_650)
  return {
    schemaVersion: 1,
    dailyTokens: Object.fromEntries(entries.map(([date, tokens]) => [date, Math.round(Number(tokens))])),
    highestGrowth: Math.max(0, Number(row.highestGrowth) || 0),
  }
}

export function updateCodyGrowthLedger(ledger: CodyGrowthLedger, usage: UiDailyTokenUsage): CodyGrowthLedger {
  const dailyTokens = {
    ...ledger.dailyTokens,
    [usage.date]: Math.max(ledger.dailyTokens[usage.date] ?? 0, Math.max(0, Math.round(usage.totalTokens))),
  }
  const computedGrowth = Object.values(dailyTokens).reduce((sum, tokens) => sum + dailyGrowth(tokens), 0)
  return normalizeCodyGrowthLedger({
    schemaVersion: 1,
    dailyTokens,
    highestGrowth: Math.max(ledger.highestGrowth, computedGrowth),
  })
}

export function codyGrowthSnapshot(ledger: CodyGrowthLedger, todayKey: string): CodyGrowthSnapshot {
  const points = Math.max(
    ledger.highestGrowth,
    Object.values(ledger.dailyTokens).reduce((sum, tokens) => sum + dailyGrowth(tokens), 0),
  )
  const level = levelForGrowth(points)
  const floor = growthRequiredForLevel(level)
  const ceiling = growthRequiredForLevel(level + 1)
  let streakDays = 0
  const cursor = new Date(`${todayKey}T12:00:00`)
  while (!Number.isNaN(cursor.getTime())) {
    const key = `${String(cursor.getFullYear()).padStart(4, '0')}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    if ((ledger.dailyTokens[key] ?? 0) <= 0) break
    streakDays += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return {
    level,
    points,
    percent: Math.max(0, Math.min(100, Math.round((points - floor) / Math.max(1, ceiling - floor) * 100))),
    remaining: Math.max(0, ceiling - points),
    icons: levelIcons(level),
    activeDays: Object.values(ledger.dailyTokens).filter((tokens) => tokens > 0).length,
    streakDays,
    todayTokens: ledger.dailyTokens[todayKey] ?? 0,
  }
}
