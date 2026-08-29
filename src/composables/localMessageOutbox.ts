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
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openOutboxDb()
  if (!db) return null

  return new Promise((resolve) => {
    let settled = false
    let result: T | null = null
    const settle = (nextResult: T | null) => {
      if (settled) return
      settled = true
      resolve(nextResult)
    }
    const transaction = db.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onsuccess = () => {
      result = request.result
    }
    request.onerror = () => settle(null)
    transaction.oncomplete = () => settle(result)
    transaction.onerror = () => settle(null)
    transaction.onabort = () => settle(null)
  })
}

function sortOutboxItems(items: LocalMessageOutboxItem[]): LocalMessageOutboxItem[] {
  return [...items].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
}

export async function loadLocalMessageOutboxItems(): Promise<LocalMessageOutboxItem[]> {
  const rows = await withStore<LocalMessageOutboxItem[]>('readonly', (store) => store.getAll())
  if (rows) return sortOutboxItems(rows.map(cloneItem))
  return sortOutboxItems([...memoryItems.values()].map(cloneItem))
}

export async function saveLocalMessageOutboxItem(item: LocalMessageOutboxItem): Promise<void> {
  const cloned = cloneItem(item)
  const result = await withStore<IDBValidKey>('readwrite', (store) => store.put(cloned))
  if (result === null) {
    memoryItems.set(cloned.id, cloned)
  }
}

export async function deleteLocalMessageOutboxItem(itemId: string): Promise<void> {
  const normalizedId = itemId.trim()
  if (!normalizedId) return
  const result = await withStore<undefined>('readwrite', (store) => store.delete(normalizedId))
  if (result === null) {
    memoryItems.delete(normalizedId)
  }
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
