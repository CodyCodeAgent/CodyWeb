import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadAutoRefreshEnabled,
  loadDefaultNewThreadCwd,
  loadDesktopTurnPreferences,
  loadProjectDisplayNames,
  loadProjectOrder,
  loadReadStateMap,
  loadSelectedThreadId,
  loadThreadScrollStateMap,
  normalizeDesktopTurnPreferences,
  normalizeDefaultNewThreadCwd,
  normalizeThreadScrollState,
  saveAutoRefreshEnabled,
  saveDefaultNewThreadCwd,
  saveDesktopTurnPreferences,
  saveProjectDisplayNames,
  saveProjectOrder,
  saveReadStateMap,
  saveSelectedThreadId,
  saveThreadScrollStateMap,
} from './desktopStateStorage'
import { DESKTOP_STORAGE_KEYS } from './desktopSettingsKeys'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  vi.stubGlobal('window', {
    localStorage: storage,
  })
  return storage
}

describe('desktopStateStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns safe defaults without a browser window', () => {
    vi.stubGlobal('window', undefined)

    expect(loadReadStateMap()).toEqual({})
    expect(loadThreadScrollStateMap()).toEqual({})
    expect(loadSelectedThreadId()).toBe('')
    expect(loadProjectOrder()).toEqual([])
    expect(loadProjectDisplayNames()).toEqual({})
    expect(loadAutoRefreshEnabled()).toBe(false)
    expect(loadDefaultNewThreadCwd()).toBe('')
    expect(loadDesktopTurnPreferences()).toEqual({
      modelId: '',
      reasoningEffort: 'medium',
      collaborationModeName: 'default',
      permissionMode: 'current',
      submitMode: 'queue',
    })
  })

  it('round-trips read state, selected thread, project names, and auto-refresh preference', () => {
    installStorage()

    saveReadStateMap({ 'thread-1': '2026-07-07T00:00:00.000Z' })
    saveSelectedThreadId('thread-1')
    saveProjectDisplayNames({ '/repo': 'Repo' })
    saveAutoRefreshEnabled(true)

    expect(loadReadStateMap()).toEqual({ 'thread-1': '2026-07-07T00:00:00.000Z' })
    expect(loadSelectedThreadId()).toBe('thread-1')
    expect(loadProjectDisplayNames()).toEqual({ '/repo': 'Repo' })
    expect(loadAutoRefreshEnabled()).toBe(true)

    saveSelectedThreadId('')
    expect(loadSelectedThreadId()).toBe('')
  })

  it('normalizes and stores turn preferences', () => {
    const storage = installStorage()

    expect(normalizeDesktopTurnPreferences({
      modelId: ' gpt-5.5 ',
      reasoningEffort: 'high',
      collaborationModeName: ' plan ',
      permissionMode: 'yolo',
      submitMode: 'guide',
    })).toEqual({
      modelId: 'gpt-5.5',
      reasoningEffort: 'high',
      collaborationModeName: 'plan',
      permissionMode: 'yolo',
      submitMode: 'guide',
    })

    expect(normalizeDesktopTurnPreferences({
      modelId: 42,
      reasoningEffort: 'invalid',
      collaborationModeName: '',
      permissionMode: 'invalid',
      submitMode: 'invalid',
    })).toEqual({
      modelId: '',
      reasoningEffort: 'medium',
      collaborationModeName: 'default',
      permissionMode: 'current',
      submitMode: 'queue',
    })

    saveDesktopTurnPreferences({
      modelId: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      collaborationModeName: 'plan',
      permissionMode: 'yolo',
      submitMode: 'guide',
    })
    expect(loadDesktopTurnPreferences()).toEqual({
      modelId: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      collaborationModeName: 'plan',
      permissionMode: 'yolo',
      submitMode: 'guide',
    })

    storage.setItem(DESKTOP_STORAGE_KEYS.turnPreferences, '{bad json')
    expect(loadDesktopTurnPreferences()).toEqual({
      modelId: '',
      reasoningEffort: 'medium',
      collaborationModeName: 'default',
      permissionMode: 'current',
      submitMode: 'queue',
    })
  })

  it('normalizes and stores the default new thread cwd', () => {
    installStorage()

    expect(normalizeDefaultNewThreadCwd(' /repo/app ')).toBe('/repo/app')
    expect(normalizeDefaultNewThreadCwd(42)).toBe('')

    saveDefaultNewThreadCwd(' /repo/app ')
    expect(loadDefaultNewThreadCwd()).toBe('/repo/app')

    saveDefaultNewThreadCwd('')
    expect(loadDefaultNewThreadCwd()).toBe('')
  })

  it('normalizes project order and ignores corrupt records', () => {
    const storage = installStorage()

    storage.setItem(DESKTOP_STORAGE_KEYS.projectOrder, JSON.stringify(['repo', '', 'repo', 42, 'docs']))
    storage.setItem(DESKTOP_STORAGE_KEYS.projectDisplayName, JSON.stringify({ repo: 'Repo', empty: '', bad: 42 }))

    expect(loadProjectOrder()).toEqual(['repo', 'docs'])
    expect(loadProjectDisplayNames()).toEqual({ repo: 'Repo', empty: '' })

    storage.setItem(DESKTOP_STORAGE_KEYS.projectOrder, '{bad json')
    storage.setItem(DESKTOP_STORAGE_KEYS.projectDisplayName, '{bad json')
    expect(loadProjectOrder()).toEqual([])
    expect(loadProjectDisplayNames()).toEqual({})
  })

  it('normalizes thread scroll state before reading it back', () => {
    const storage = installStorage()

    storage.setItem(
      DESKTOP_STORAGE_KEYS.scrollState,
      JSON.stringify({
        good: { scrollTop: -50, isAtBottom: false, scrollRatio: 2 },
        missingBottom: { scrollTop: 10 },
        badTop: { scrollTop: '10', isAtBottom: true },
      }),
    )

    expect(loadThreadScrollStateMap()).toEqual({
      good: { scrollTop: 0, isAtBottom: false, scrollRatio: 1 },
    })
    expect(normalizeThreadScrollState({ scrollTop: 10, isAtBottom: true, scrollRatio: -1 })).toEqual({
      scrollTop: 10,
      isAtBottom: true,
      scrollRatio: 0,
    })
  })

  it('saves scroll state and discards corrupt read state JSON', () => {
    const storage = installStorage()

    saveThreadScrollStateMap({ thread: { scrollTop: 10, isAtBottom: true } })
    expect(loadThreadScrollStateMap()).toEqual({ thread: { scrollTop: 10, isAtBottom: true } })

    saveProjectOrder(['a', 'b'])
    expect(loadProjectOrder()).toEqual(['a', 'b'])

    storage.setItem(DESKTOP_STORAGE_KEYS.readState, '{bad json')
    expect(loadReadStateMap()).toEqual({})
  })
})
