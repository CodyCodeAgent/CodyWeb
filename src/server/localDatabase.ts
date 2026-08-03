import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_SETTINGS_DB_PATH = join(homedir(), '.cody-web-ui', 'settings.sqlite3')

export function localDatabasePath(): string {
  return process.env.CODY_WEB_UI_SETTINGS_DB?.trim() || DEFAULT_SETTINGS_DB_PATH
}

export function openLocalDatabase(dbPath = localDatabasePath()): Database.Database {
  const dbDirectory = dirname(dbPath)
  mkdirSync(dbDirectory, { recursive: true, mode: 0o700 })
  if (dbPath === DEFAULT_SETTINGS_DB_PATH) chmodSync(dbDirectory, 0o700)

  let db: Database.Database | undefined
  try {
    db = new Database(dbPath)
    chmodSync(dbPath, 0o600)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    return db
  } catch (error) {
    db?.close()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to open settings database at ${dbPath}: ${message}`)
  }
}

export async function withLocalDatabase<T>(operation: (db: Database.Database) => T): Promise<T> {
  const dbPath = localDatabasePath()
  const dbDirectory = dirname(dbPath)
  await mkdir(dbDirectory, { recursive: true, mode: 0o700 })
  // The default database contains write-only integration credentials. Keep its
  // containing directory private even when an earlier version created it with
  // a permissive umask. A custom database may intentionally live in a shared
  // service directory, so only its file is tightened below.
  if (dbPath === DEFAULT_SETTINGS_DB_PATH) await chmod(dbDirectory, 0o700)

  let db: Database.Database | undefined
  try {
    db = new Database(dbPath)
    await chmod(dbPath, 0o600)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  } catch (error) {
    db?.close()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to open settings database at ${dbPath}: ${message}`)
  }

  try {
    return operation(db)
  } finally {
    db.close()
  }
}
