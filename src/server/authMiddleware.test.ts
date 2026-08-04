import http, { type Server } from 'node:http'
import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthMiddleware } from './authMiddleware'
import { openLocalDatabase } from './localDatabase'

type TestServer = {
  baseUrl: string
  close: () => Promise<void>
}

async function startAuthServer(options: {
  databasePath?: string
  password?: string
  sessionTtlMs?: number
  rateLimitWindowMs?: number
  rateLimitBlockMs?: number
  maxFailedAttempts?: number
  now?: () => number
} = {}): Promise<TestServer> {
  const databasePath = options.databasePath ?? join(
    await mkdtemp(join(tmpdir(), 'cody-auth-middleware-')),
    'settings.sqlite3',
  )
  if (!options.databasePath) temporaryDirectories.push(dirname(databasePath))
  const app = express()
  const authMiddleware = createAuthMiddleware(options.password ?? 'correct-password', {
    databasePath,
    sessionTtlMs: options.sessionTtlMs,
    rateLimitWindowMs: options.rateLimitWindowMs,
    rateLimitBlockMs: options.rateLimitBlockMs,
    maxFailedAttempts: options.maxFailedAttempts,
    now: options.now,
  })
  app.use(authMiddleware)
  app.get('/protected', (_req, res) => {
    res.json({ ok: true })
  })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => {
          authMiddleware.dispose()
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function cookiesFrom(response: Response): string {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const rows = typeof getSetCookie === 'function'
    ? getSetCookie.call(response.headers)
    : [response.headers.get('set-cookie') ?? '']
  return rows
    .flatMap((row) => row.split(/,(?=\s*cody_web_ui_)/u))
    .map((row) => row.split(';')[0]?.trim() ?? '')
    .filter(Boolean)
    .join('; ')
}

const servers: TestServer[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('authMiddleware', () => {
  it('keeps default login sessions valid for 30 days', async () => {
    let nowMs = Date.parse('2026-07-05T00:00:00.000Z')
    const server = await startAuthServer({ now: () => nowMs })
    servers.push(server)

    const login = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    expect(login.status).toBe(200)
    await expect(login.clone().json()).resolves.toMatchObject({
      ok: true,
      expiresAtIso: '2026-08-04T00:00:00.000Z',
    })
    expect(login.headers.get('set-cookie')).toMatch(/cody_web_ui_token=[a-f0-9]+;[^,]*Max-Age=2592000/u)
    const cookie = cookiesFrom(login)

    nowMs += 30 * 24 * 60 * 60 * 1000 - 1
    const beforeExpiry = await fetch(`${server.baseUrl}/auth/session`, { headers: { cookie } })
    expect(beforeExpiry.status).toBe(200)

    nowMs += 2
    const afterExpiry = await fetch(`${server.baseUrl}/auth/session`, { headers: { cookie } })
    expect(afterExpiry.status).toBe(401)
  })

  it('creates short-lived authenticated sessions with status and logout', async () => {
    let nowMs = Date.parse('2026-07-05T00:00:00.000Z')
    const server = await startAuthServer({
      sessionTtlMs: 60_000,
      now: () => nowMs,
    })
    servers.push(server)

    const unauthenticated = await fetch(`${server.baseUrl}/auth/session`)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.json()).toEqual({ authenticated: false })

    const protectedBeforeLogin = await fetch(`${server.baseUrl}/protected`)
    expect(protectedBeforeLogin.status).toBe(200)
    expect(await protectedBeforeLogin.text()).toContain('CodyWeb')

    const login = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    expect(login.status).toBe(200)
    const loginPayload = await login.json() as { expiresAtIso: string; deviceId: string; ok: boolean }
    expect(loginPayload).toMatchObject({
      ok: true,
      expiresAtIso: '2026-07-05T00:01:00.000Z',
    })
    expect(loginPayload.deviceId).toHaveLength(32)
    const cookie = cookiesFrom(login)
    expect(cookie).toContain('cody_web_ui_token=')
    expect(cookie).toContain('cody_web_ui_device=')

    const protectedAfterLogin = await fetch(`${server.baseUrl}/protected`, {
      headers: { cookie },
    })
    expect(protectedAfterLogin.status).toBe(200)
    expect(await protectedAfterLogin.json()).toEqual({ ok: true })

    const session = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { cookie },
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      authenticated: true,
      deviceId: loginPayload.deviceId,
      trustedDevice: false,
      trustedAtIso: null,
      createdAtIso: '2026-07-05T00:00:00.000Z',
      expiresAtIso: '2026-07-05T00:01:00.000Z',
    })

    const logout = await fetch(`${server.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(logout.status).toBe(200)
    expect(cookiesFrom(logout)).toContain('cody_web_ui_token=')

    const protectedAfterLogout = await fetch(`${server.baseUrl}/protected`, {
      headers: { cookie },
    })
    expect(await protectedAfterLogout.text()).toContain('CodyWeb')

    const secondLogin = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    const secondCookie = cookiesFrom(secondLogin)
    nowMs += 60_001
    const expired = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { cookie: secondCookie },
    })
    expect(expired.status).toBe(401)
  })

  it('trusts the current device across short-lived sessions and supports revocation', async () => {
    let nowMs = Date.parse('2026-07-05T00:00:00.000Z')
    const server = await startAuthServer({
      sessionTtlMs: 60_000,
      now: () => nowMs,
    })
    servers.push(server)

    const login = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    const loginPayload = await login.json() as { deviceId: string; trustedDevice: boolean }
    expect(loginPayload.trustedDevice).toBe(false)
    const cookie = cookiesFrom(login)

    const trust = await fetch(`${server.baseUrl}/auth/device/trust`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(trust.status).toBe(200)
    expect(await trust.json()).toMatchObject({
      ok: true,
      deviceId: loginPayload.deviceId,
      trustedDevice: true,
      trustedAtIso: '2026-07-05T00:00:00.000Z',
    })

    const trustedSession = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { cookie },
    })
    expect(await trustedSession.json()).toMatchObject({
      authenticated: true,
      deviceId: loginPayload.deviceId,
      trustedDevice: true,
      trustedAtIso: '2026-07-05T00:00:00.000Z',
    })

    const devices = await fetch(`${server.baseUrl}/auth/devices`, {
      headers: { cookie },
    })
    expect(await devices.json()).toEqual({
      devices: [
        expect.objectContaining({
          deviceId: loginPayload.deviceId,
          current: true,
        }),
      ],
    })

    const logout = await fetch(`${server.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(logout.status).toBe(200)
    nowMs += 10_000
    const secondLogin = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    const secondLoginPayload = await secondLogin.json() as { deviceId: string; trustedDevice: boolean }
    expect(secondLoginPayload).toMatchObject({
      deviceId: loginPayload.deviceId,
      trustedDevice: true,
    })
    const secondCookie = cookiesFrom(secondLogin)

    const revoke = await fetch(`${server.baseUrl}/auth/device/revoke`, {
      method: 'POST',
      headers: { cookie: secondCookie },
    })
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toMatchObject({
      ok: true,
      deviceId: loginPayload.deviceId,
      trustedDevice: false,
    })

    const revokedSession = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { cookie: secondCookie },
    })
    expect(await revokedSession.json()).toMatchObject({
      authenticated: true,
      deviceId: loginPayload.deviceId,
      trustedDevice: false,
      trustedAtIso: null,
    })
  })

  it('persists hashed sessions and trusted devices across server restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cody-auth-restart-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'settings.sqlite3')
    const nowMs = Date.parse('2026-08-03T13:00:00.000Z')
    const firstServer = await startAuthServer({ databasePath, now: () => nowMs })
    servers.push(firstServer)

    const login = await fetch(`${firstServer.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    const cookie = cookiesFrom(login)
    const rawToken = cookie.match(/(?:^|;\s*)cody_web_ui_token=([^;]+)/u)?.[1] ?? ''
    expect(rawToken).toHaveLength(64)

    const trust = await fetch(`${firstServer.baseUrl}/auth/device/trust`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(trust.status).toBe(200)

    const db = openLocalDatabase(databasePath)
    const persisted = db.prepare('SELECT token_hash AS tokenHash FROM auth_sessions LIMIT 1').get() as { tokenHash: string }
    db.close()
    expect(persisted.tokenHash).toHaveLength(64)
    expect(persisted.tokenHash).not.toBe(rawToken)

    await firstServer.close()
    const restartedServer = await startAuthServer({ databasePath, now: () => nowMs + 30_000 })
    servers.push(restartedServer)

    const restored = await fetch(`${restartedServer.baseUrl}/auth/session`, {
      headers: { cookie },
    })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({
      authenticated: true,
      trustedDevice: true,
    })

    await restartedServer.close()
    const changedPasswordServer = await startAuthServer({
      databasePath,
      password: 'new-password',
      now: () => nowMs + 45_000,
    })
    servers.push(changedPasswordServer)
    const invalidated = await fetch(`${changedPasswordServer.baseUrl}/auth/session`, {
      headers: { cookie },
    })
    expect(invalidated.status).toBe(401)
  })

  it('upgrades a still-valid legacy session to the 30-day lifetime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cody-auth-legacy-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'settings.sqlite3')
    let nowMs = Date.parse('2026-07-05T00:00:00.000Z')
    const legacyServer = await startAuthServer({ databasePath, sessionTtlMs: 60_000, now: () => nowMs })
    servers.push(legacyServer)

    const login = await fetch(`${legacyServer.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    const cookie = cookiesFrom(login)
    await legacyServer.close()

    nowMs += 30_000
    const upgradedServer = await startAuthServer({ databasePath, now: () => nowMs })
    servers.push(upgradedServer)
    const upgraded = await fetch(`${upgradedServer.baseUrl}/auth/session`, { headers: { cookie } })

    expect(upgraded.status).toBe(200)
    await expect(upgraded.clone().json()).resolves.toMatchObject({
      authenticated: true,
      expiresAtIso: '2026-08-04T00:00:00.000Z',
    })
    expect(upgraded.headers.get('set-cookie')).toMatch(/cody_web_ui_token=[a-f0-9]+;[^,]*Max-Age=2591970/u)
  })

  it('rate limits repeated failed logins and resets after success', async () => {
    let nowMs = Date.parse('2026-07-05T00:00:00.000Z')
    const server = await startAuthServer({
      maxFailedAttempts: 2,
      rateLimitWindowMs: 60_000,
      rateLimitBlockMs: 120_000,
      now: () => nowMs,
    })
    servers.push(server)

    const firstFailure = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(firstFailure.status).toBe(401)
    expect(await firstFailure.json()).toMatchObject({
      remainingAttempts: 1,
      retryAfterMs: 0,
    })

    const secondFailure = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(secondFailure.status).toBe(429)
    expect(await secondFailure.json()).toMatchObject({
      remainingAttempts: 0,
      retryAfterMs: 120_000,
    })

    const blockedEvenWithCorrectPassword = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    expect(blockedEvenWithCorrectPassword.status).toBe(429)

    nowMs += 120_001
    const success = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    expect(success.status).toBe(200)

    const failureAfterReset = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(failureAfterReset.status).toBe(401)
    expect(await failureAfterReset.json()).toMatchObject({
      remainingAttempts: 1,
    })
  })
})
