import { asRecord as coreAsRecord } from '@codycodeagent/cody-web-core/protocol'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return coreAsRecord(value)
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readIsoTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }

  if (typeof value !== 'string' || value.length === 0) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

export function readIsoTimestampString(value: unknown): string {
  if (typeof value === 'string') return value

  const ms = readIsoTimestampMs(value)
  return ms === null ? '' : new Date(ms).toISOString()
}

export function toRawPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
