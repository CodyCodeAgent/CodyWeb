import type { ComposerSubmission } from '@codycodeagent/cody-web-core/composer'
import type { UiComposerContextKind } from '../types/codex'

export type LocalMessageOutboxStatus = 'queued' | 'sending' | 'failed'

export type LocalMessageOutboxItem = {
  id: string
  threadId: string
  text: string
  images: ComposerSubmission<UiComposerContextKind>['images']
  skills: ComposerSubmission<UiComposerContextKind>['skills']
  contexts?: ComposerSubmission<UiComposerContextKind>['contexts']
  status: LocalMessageOutboxStatus
  attempts: number
  createdAtIso: string
  updatedAtIso: string
  lastError?: string
  turnId?: string
}

const DB_NAME = 'cody-web-ui-local-message-outbox'
const DB_VERSION = 1
const STORE_NAME = 'items'

const memoryItems = new Map<string, LocalMessageOutboxItem>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function invalidateDatabase(db?: IDBDatabase | null): void {
  if (db) {
    try {
      db.close()
    } catch {
      // Closing a connection that is already closing is harmless.
    }
  }
  dbPromise = null
}

function cloneItem(item: LocalMessageOutboxItem): LocalMessageOutboxItem {
  return {
    ...item,
    images: item.images.map((image) => ({ ...image })),
    skills: item.skills.map((skill) => ({ ...skill })),
    contexts: item.contexts?.map((context) => ({ ...context, metadata: { ...context.metadata } })),
  }
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openOutboxDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) return Promise.resolve(null)
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('threadId', 'threadId', { unique: false })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('createdAtIso', 'createdAtIso', { unique: false })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // A page can retain a resolved promise while the browser closes this
      // connection during navigation/version changes. Forget it so the next
      // operation opens a fresh database instead of silently falling back to
      // in-memory data (which disappears on reload).
      db.onclose = () => invalidateDatabase(db)
      db.onversionchange = () => invalidateDatabase(db)
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      resolve(null)
    }
    request.onblocked = () => {
      dbPromise = null
      resolve(null)
    }
  })

  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const db = await openOutboxDb()
    if (!db) return null

    const result = await new Promise<{ value: T | null; retry: boolean }>((resolve) => {
      let settled = false
      let value: T | null = null
      const settle = (nextValue: T | null, retry = false) => {
        if (settled) return
        settled = true
        resolve({ value: nextValue, retry })
      }
      try {
        const transaction = db.transaction(STORE_NAME, mode)
        const request = operation(transaction.objectStore(STORE_NAME))
        request.onsuccess = () => {
          value = request.result
        }
        request.onerror = () => settle(null, true)
        transaction.oncomplete = () => settle(value)
        transaction.onerror = () => settle(null, true)
        transaction.onabort = () => settle(null, true)
      } catch {
        settle(null, true)
      }
    })
    if (!result.retry) return result.value
    invalidateDatabase(db)
  }
  return null
}

function sortOutboxItems(items: LocalMessageOutboxItem[]): LocalMessageOutboxItem[] {
  return [...items].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
}

export async function loadLocalMessageOutboxItems(): Promise<LocalMessageOutboxItem[]> {
  const rows = await withStore<LocalMessageOutboxItem[]>('readonly', (store) => store.getAll())
  const merged = new Map<string, LocalMessageOutboxItem>()
  for (const item of rows ?? []) merged.set(item.id, cloneItem(item))
  for (const item of memoryItems.values()) merged.set(item.id, cloneItem(item))
  return sortOutboxItems([...merged.values()])
}

export async function saveLocalMessageOutboxItem(item: LocalMessageOutboxItem): Promise<void> {
  const cloned = cloneItem(item)
  memoryItems.set(cloned.id, cloned)
  const result = await withStore<IDBValidKey>('readwrite', (store) => store.put(cloned))
  // memoryItems intentionally remains a mirror for the current page. IndexedDB
  // is retried above; on a genuine storage outage it still keeps the pending
  // submission visible and retryable instead of dropping it.
  void result
}

export async function deleteLocalMessageOutboxItem(itemId: string): Promise<void> {
  const normalizedId = itemId.trim()
  if (!normalizedId) return
  memoryItems.delete(normalizedId)
  await withStore<undefined>('readwrite', (store) => store.delete(normalizedId))
}

export function buildLocalMessageOutboxItem(input: {
  threadId: string
  payload: ComposerSubmission<UiComposerContextKind>
}): LocalMessageOutboxItem {
  const now = new Date().toISOString()
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return {
    id: `local-outbox:${randomId}`,
    threadId: input.threadId,
    text: input.payload.text.trim(),
    images: input.payload.images.map((image) => ({ ...image })),
    skills: input.payload.skills.map((skill) => ({ ...skill })),
    contexts: input.payload.contexts?.map((context) => ({ ...context, metadata: { ...context.metadata } })),
    status: 'queued',
    attempts: 0,
    createdAtIso: now,
    updatedAtIso: now,
  }
}

export function resetLocalMessageOutboxForTests(): void {
  memoryItems.clear()
  dbPromise = null
}
