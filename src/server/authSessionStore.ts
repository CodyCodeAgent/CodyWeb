import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openLocalDatabase } from './localDatabase.js'

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

export type StoredAuthSession = {
  token: string
  deviceId: string
  createdAtMs: number
  expiresAtMs: number
  lastSeenAtMs: number
  ip: string
}

export type StoredTrustedDevice = {
  deviceId: string
  trustedAtMs: number
  lastSeenAtMs: number
  ip: string
}

export type AuthSessionStore = {
  readSession: (token: string, nowMs: number) => StoredAuthSession | null
  writeSession: (session: StoredAuthSession) => void
  deleteSession: (token: string) => void
  readTrustedDevice: (deviceId: string) => StoredTrustedDevice | null
  listTrustedDevices: () => StoredTrustedDevice[]
  writeTrustedDevice: (device: StoredTrustedDevice) => void
  deleteTrustedDevice: (deviceId: string) => void
  close: () => void
}

type SessionRow = {
  deviceId: string
  createdAtMs: number
  expiresAtMs: number
  lastSeenAtMs: number
  ip: string
}

type TrustedDeviceRow = {
  deviceId: string
  trustedAtMs: number
  lastSeenAtMs: number
  ip: string
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function authScope(password: string): string {
  return digest(`cody-web-ui-auth-session-v1\0${password}`)
}

function tokenHash(token: string): string {
  return digest(`cody-web-ui-auth-token-v1\0${token}`)
}

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      auth_scope TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      ip TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at_ms);
    CREATE TABLE IF NOT EXISTS auth_trusted_devices (
      auth_scope TEXT NOT NULL,
      device_id TEXT NOT NULL,
      trusted_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      ip TEXT NOT NULL,
      PRIMARY KEY (auth_scope, device_id)
    );
  `)
}

export function createAuthSessionStore(password: string, databasePath?: string, nowMs = Date.now()): AuthSessionStore {
  const db = openLocalDatabase(databasePath)
  const scope = authScope(password)
  ensureTables(db)

  const clearObsolete = db.transaction((nowMs: number) => {
    db.prepare('DELETE FROM auth_sessions WHERE auth_scope <> ? OR expires_at_ms <= ?').run(scope, nowMs)
    db.prepare('DELETE FROM auth_trusted_devices WHERE auth_scope <> ?').run(scope)
  })
  clearObsolete(nowMs)

  const readSessionStatement = db.prepare(`
    SELECT
      device_id AS deviceId,
      created_at_ms AS createdAtMs,
      expires_at_ms AS expiresAtMs,
      last_seen_at_ms AS lastSeenAtMs,
      ip
    FROM auth_sessions
    WHERE token_hash = ? AND auth_scope = ? AND expires_at_ms > ?
    LIMIT 1
  `)
  const touchSessionStatement = db.prepare(`
    UPDATE auth_sessions
    SET last_seen_at_ms = ?
    WHERE token_hash = ? AND auth_scope = ? AND last_seen_at_ms <= ?
  `)
  const writeSessionStatement = db.prepare(`
    INSERT INTO auth_sessions (
      token_hash, auth_scope, device_id, created_at_ms, expires_at_ms, last_seen_at_ms, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      auth_scope = excluded.auth_scope,
      device_id = excluded.device_id,
      created_at_ms = excluded.created_at_ms,
      expires_at_ms = excluded.expires_at_ms,
      last_seen_at_ms = excluded.last_seen_at_ms,
      ip = excluded.ip
  `)
  const deleteSessionStatement = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ? AND auth_scope = ?')
  const readTrustedDeviceStatement = db.prepare(`
    SELECT
      device_id AS deviceId,
      trusted_at_ms AS trustedAtMs,
      last_seen_at_ms AS lastSeenAtMs,
      ip
    FROM auth_trusted_devices
    WHERE auth_scope = ? AND device_id = ?
    LIMIT 1
  `)
  const listTrustedDevicesStatement = db.prepare(`
    SELECT
      device_id AS deviceId,
      trusted_at_ms AS trustedAtMs,
      last_seen_at_ms AS lastSeenAtMs,
      ip
    FROM auth_trusted_devices
    WHERE auth_scope = ?
    ORDER BY trusted_at_ms DESC
  `)
  const writeTrustedDeviceStatement = db.prepare(`
    INSERT INTO auth_trusted_devices (auth_scope, device_id, trusted_at_ms, last_seen_at_ms, ip)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(auth_scope, device_id) DO UPDATE SET
      trusted_at_ms = excluded.trusted_at_ms,
      last_seen_at_ms = excluded.last_seen_at_ms,
      ip = excluded.ip
  `)
  const deleteTrustedDeviceStatement = db.prepare(
    'DELETE FROM auth_trusted_devices WHERE auth_scope = ? AND device_id = ?',
  )

  return {
    readSession(token, nowMs) {
      const hash = tokenHash(token)
      const row = readSessionStatement.get(hash, scope, nowMs) as SessionRow | undefined
      if (!row) {
        deleteSessionStatement.run(hash, scope)
        return null
      }
      touchSessionStatement.run(nowMs, hash, scope, nowMs - LAST_SEEN_WRITE_INTERVAL_MS)
      return {
        token,
        deviceId: row.deviceId,
        createdAtMs: row.createdAtMs,
        expiresAtMs: row.expiresAtMs,
        lastSeenAtMs: nowMs,
        ip: row.ip,
      }
    },
    writeSession(session) {
      writeSessionStatement.run(
        tokenHash(session.token),
        scope,
        session.deviceId,
        session.createdAtMs,
        session.expiresAtMs,
        session.lastSeenAtMs,
        session.ip,
      )
    },
    deleteSession(token) {
      deleteSessionStatement.run(tokenHash(token), scope)
    },
    readTrustedDevice(deviceId) {
      return (readTrustedDeviceStatement.get(scope, deviceId) as TrustedDeviceRow | undefined) ?? null
    },
    listTrustedDevices() {
      return listTrustedDevicesStatement.all(scope) as TrustedDeviceRow[]
    },
    writeTrustedDevice(device) {
      writeTrustedDeviceStatement.run(
        scope,
        device.deviceId,
        device.trustedAtMs,
        device.lastSeenAtMs,
        device.ip,
      )
    },
    deleteTrustedDevice(deviceId) {
      deleteTrustedDeviceStatement.run(scope, deviceId)
    },
    close() {
      db.close()
    },
  }
}
