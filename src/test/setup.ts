/**
 * Some bundled Node runtimes expose an incomplete global `localStorage`
 * object when no backing file is configured. happy-dom normally supplies a
 * complete implementation, but bare `localStorage` still resolves to the
 * broken Node global. Keep browser-component tests deterministic by pointing
 * both names at one standards-shaped in-memory store.
 */
if (typeof window !== 'undefined') {
  const current = window.localStorage
  if (typeof current?.getItem !== 'function' || typeof current?.setItem !== 'function' || typeof current?.clear !== 'function') {
    const values = new Map<string, string>()
    const storage: Storage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => { values.delete(key) },
      setItem: (key, value) => { values.set(key, String(value)) },
    }
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: window.localStorage,
  })
}
