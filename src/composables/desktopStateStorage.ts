import { isReasoningEffort } from './desktopTurnPreferences'
import {
  DEFAULT_COMPOSER_PERMISSION_MODE,
  normalizeComposerPermissionMode,
} from './desktopTurnPermissions'
import { DESKTOP_STORAGE_KEYS } from './desktopSettingsKeys'
import type { ReasoningEffort, ThreadScrollState, UiComposerPermissionMode, UiComposerSubmitMode } from '../types/codex'

export type DesktopTurnPreferences = {
  modelId: string
  reasoningEffort: ReasoningEffort | ''
  collaborationModeName: string
  permissionMode: UiComposerPermissionMode
  submitMode: UiComposerSubmitMode
}

export const DEFAULT_DESKTOP_TURN_PREFERENCES: DesktopTurnPreferences = {
  modelId: '',
  reasoningEffort: 'medium',
  collaborationModeName: 'default',
  permissionMode: DEFAULT_COMPOSER_PERMISSION_MODE,
  submitMode: 'queue',
}

function normalizeComposerSubmitMode(value: unknown): UiComposerSubmitMode {
  return value === 'guide' ? 'guide' : 'queue'
}

function getLocalStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function readJsonStorage(key: string): unknown {
  const storage = getLocalStorage()
  if (!storage) return null

  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJsonStorage(key: string, value: unknown): void {
  const storage = getLocalStorage()
  if (!storage) return
  storage.setItem(key, JSON.stringify(value))
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const normalized: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0 && typeof rawValue === 'string') {
      normalized[key] = rawValue
    }
  }
  return normalized
}

export function normalizeDesktopTurnPreferences(value: unknown): DesktopTurnPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_DESKTOP_TURN_PREFERENCES
  }

  const row = value as Record<string, unknown>
  const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : ''
  const rawReasoningEffort = typeof row.reasoningEffort === 'string' ? row.reasoningEffort.trim() : ''
  const reasoningEffort = rawReasoningEffort && isReasoningEffort(rawReasoningEffort)
    ? rawReasoningEffort
    : DEFAULT_DESKTOP_TURN_PREFERENCES.reasoningEffort
  const collaborationModeName = typeof row.collaborationModeName === 'string' && row.collaborationModeName.trim()
    ? row.collaborationModeName.trim()
    : DEFAULT_DESKTOP_TURN_PREFERENCES.collaborationModeName
  const permissionMode = normalizeComposerPermissionMode(row.permissionMode)
  const submitMode = normalizeComposerSubmitMode(row.submitMode)

  return {
    modelId,
    reasoningEffort,
    collaborationModeName,
    permissionMode,
    submitMode,
  }
}

export function normalizeDefaultNewThreadCwd(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeThreadScrollState(value: unknown): ThreadScrollState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const rawState = value as Record<string, unknown>
  if (typeof rawState.scrollTop !== 'number' || !Number.isFinite(rawState.scrollTop)) return null
  if (typeof rawState.isAtBottom !== 'boolean') return null

  const normalized: ThreadScrollState = {
    scrollTop: Math.max(0, rawState.scrollTop),
    isAtBottom: rawState.isAtBottom,
  }

  if (typeof rawState.scrollRatio === 'number' && Number.isFinite(rawState.scrollRatio)) {
    normalized.scrollRatio = clamp(rawState.scrollRatio, 0, 1)
  }

  return normalized
}

export function loadReadStateMap(): Record<string, string> {
  return normalizeStringRecord(readJsonStorage(DESKTOP_STORAGE_KEYS.readState))
}

export function saveReadStateMap(state: Record<string, string>): void {
  writeJsonStorage(DESKTOP_STORAGE_KEYS.readState, state)
}

export function loadAutoRefreshEnabled(): boolean {
  const storage = getLocalStorage()
  return storage?.getItem(DESKTOP_STORAGE_KEYS.autoRefreshEnabled) === '1'
}

export function saveAutoRefreshEnabled(value: boolean): void {
  const storage = getLocalStorage()
  if (!storage) return
  storage.setItem(DESKTOP_STORAGE_KEYS.autoRefreshEnabled, value ? '1' : '0')
}

export function loadDesktopTurnPreferences(): DesktopTurnPreferences {
  return normalizeDesktopTurnPreferences(readJsonStorage(DESKTOP_STORAGE_KEYS.turnPreferences))
}

export function saveDesktopTurnPreferences(preferences: DesktopTurnPreferences): void {
  writeJsonStorage(DESKTOP_STORAGE_KEYS.turnPreferences, normalizeDesktopTurnPreferences(preferences))
}

export function loadDefaultNewThreadCwd(): string {
  const storage = getLocalStorage()
  return normalizeDefaultNewThreadCwd(storage?.getItem(DESKTOP_STORAGE_KEYS.defaultNewThreadCwd) ?? '')
}

export function saveDefaultNewThreadCwd(cwd: string): void {
  const storage = getLocalStorage()
  if (!storage) return
  const normalizedCwd = normalizeDefaultNewThreadCwd(cwd)
  if (!normalizedCwd) {
    storage.removeItem(DESKTOP_STORAGE_KEYS.defaultNewThreadCwd)
    return
  }
  storage.setItem(DESKTOP_STORAGE_KEYS.defaultNewThreadCwd, normalizedCwd)
}

export function loadThreadScrollStateMap(): Record<string, ThreadScrollState> {
  const parsed = readJsonStorage(DESKTOP_STORAGE_KEYS.scrollState)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const normalizedMap: Record<string, ThreadScrollState> = {}
  for (const [threadId, state] of Object.entries(parsed as Record<string, unknown>)) {
    if (!threadId) continue
    const normalizedState = normalizeThreadScrollState(state)
    if (normalizedState) {
      normalizedMap[threadId] = normalizedState
    }
  }
  return normalizedMap
}

export function saveThreadScrollStateMap(state: Record<string, ThreadScrollState>): void {
  writeJsonStorage(DESKTOP_STORAGE_KEYS.scrollState, state)
}

export function loadSelectedThreadId(): string {
  const storage = getLocalStorage()
  return storage?.getItem(DESKTOP_STORAGE_KEYS.selectedThread) ?? ''
}

export function saveSelectedThreadId(threadId: string): void {
  const storage = getLocalStorage()
  if (!storage) return
  if (!threadId) {
    storage.removeItem(DESKTOP_STORAGE_KEYS.selectedThread)
    return
  }
  storage.setItem(DESKTOP_STORAGE_KEYS.selectedThread, threadId)
}

export function loadProjectOrder(): string[] {
  const parsed = readJsonStorage(DESKTOP_STORAGE_KEYS.projectOrder)
  if (!Array.isArray(parsed)) return []

  const order: string[] = []
  for (const item of parsed) {
    if (typeof item === 'string' && item.length > 0 && !order.includes(item)) {
      order.push(item)
    }
  }
  return order
}

export function saveProjectOrder(order: string[]): void {
  writeJsonStorage(DESKTOP_STORAGE_KEYS.projectOrder, order)
}

export function loadProjectDisplayNames(): Record<string, string> {
  return normalizeStringRecord(readJsonStorage(DESKTOP_STORAGE_KEYS.projectDisplayName))
}

export function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  writeJsonStorage(DESKTOP_STORAGE_KEYS.projectDisplayName, displayNames)
}
