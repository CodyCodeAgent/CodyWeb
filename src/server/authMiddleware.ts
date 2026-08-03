import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { RequestHandler, Request, Response, NextFunction } from 'express'
import {
  createAuthSessionStore,
  type StoredAuthSession as AuthSession,
  type StoredTrustedDevice as TrustedDevice,
} from './authSessionStore.js'

const TOKEN_COOKIE = 'cody_web_ui_token'
const DEVICE_COOKIE = 'cody_web_ui_device'
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000
const DEFAULT_MAX_FAILED_ATTEMPTS = 5

type LoginRateLimitState = {
  failedAtMs: number[]
  blockedUntilMs: number
}

export type AuthMiddlewareOptions = {
  databasePath?: string
  sessionTtlMs?: number
  rateLimitWindowMs?: number
  rateLimitBlockMs?: number
  maxFailedAttempts?: number
  now?: () => number
}

export type AuthMiddleware = RequestHandler & {
  authorizeUpgrade: (req: IncomingMessage) => boolean
  dispose: () => void
}

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    cookies[key] = value
  }
  return cookies
}

function requestIp(req: Request): string {
  // Express only applies X-Forwarded-For to req.ip when an explicit trusted
  // proxy is configured. Reading it directly lets clients rotate a spoofed
  // address and bypass login rate limiting.
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function cookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

function readDeviceCookie(cookies: Record<string, string>): string {
  const value = cookies[DEVICE_COOKIE]?.trim() ?? ''
  return /^[a-f0-9]{32}$/u.test(value) ? value : ''
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodyWeb &mdash; Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:2rem;width:100%;max-width:380px}
h1{font-size:1.25rem;font-weight:600;margin-bottom:1.5rem;text-align:center;color:#fafafa}
label{display:block;font-size:.875rem;color:#a3a3a3;margin-bottom:.5rem}
input{width:100%;padding:.625rem .75rem;background:#0a0a0a;border:1px solid #404040;border-radius:8px;color:#fafafa;font-size:1rem;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:.625rem;margin-top:1rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:.9375rem;font-weight:500;cursor:pointer;transition:background .15s}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:.8125rem;margin-top:.75rem;text-align:center;display:none}
</style>
</head>
<body>
<div class="card">
<h1>CodyWeb</h1>
<form id="f">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
<p class="error" id="err">Incorrect password</p>
</form>
</div>
<script>
const form=document.getElementById('f');
const errEl=document.getElementById('err');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  errEl.style.display='none';
  const res=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(res.ok){window.location.reload()}else{errEl.style.display='block';document.getElementById('pw').value='';document.getElementById('pw').focus()}
});
</script>
</body>
</html>`

export function createAuthMiddleware(password: string, options: AuthMiddlewareOptions = {}): AuthMiddleware {
  const rateLimits = new Map<string, LoginRateLimitState>()
  const sessionTtlMs = Math.max(60_000, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS)
  const rateLimitWindowMs = Math.max(1_000, options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS)
  const rateLimitBlockMs = Math.max(1_000, options.rateLimitBlockMs ?? DEFAULT_RATE_LIMIT_BLOCK_MS)
  const maxFailedAttempts = Math.max(1, options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS)
  const now = options.now ?? (() => Date.now())
  const sessionStore = createAuthSessionStore(password, options.databasePath, now())

  function readSessionFromCookie(cookieHeader: string | undefined, nowMs: number): AuthSession | null {
    const cookies = parseCookies(cookieHeader)
    const token = cookies[TOKEN_COOKIE]
    if (!token) return null
    return sessionStore.readSession(token, nowMs)
  }

  function readSession(req: Request, nowMs: number): AuthSession | null {
    return readSessionFromCookie(req.headers.cookie, nowMs)
  }

  function readRateLimit(ip: string, nowMs: number): LoginRateLimitState {
    const current = rateLimits.get(ip) ?? { failedAtMs: [], blockedUntilMs: 0 }
    current.failedAtMs = current.failedAtMs.filter((value) => value > nowMs - rateLimitWindowMs)
    if (current.blockedUntilMs <= nowMs) {
      current.blockedUntilMs = 0
    }
    rateLimits.set(ip, current)
    return current
  }

  function recordFailedLogin(ip: string, nowMs: number): LoginRateLimitState {
    const current = readRateLimit(ip, nowMs)
    current.failedAtMs.push(nowMs)
    if (current.failedAtMs.length >= maxFailedAttempts) {
      current.blockedUntilMs = nowMs + rateLimitBlockMs
    }
    rateLimits.set(ip, current)
    return current
  }

  function resetRateLimit(ip: string): void {
    rateLimits.delete(ip)
  }

  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    const nowMs = now()
    const ip = requestIp(req)

    if (req.method === 'GET' && req.path === '/auth/session') {
      const session = readSession(req, nowMs)
      if (!session) {
        res.status(401).json({ authenticated: false })
        return
      }
      const trustedDevice = sessionStore.readTrustedDevice(session.deviceId)
      if (trustedDevice) {
        trustedDevice.lastSeenAtMs = nowMs
        sessionStore.writeTrustedDevice(trustedDevice)
      }
      res.json({
        authenticated: true,
        deviceId: session.deviceId,
        trustedDevice: Boolean(trustedDevice),
        trustedAtIso: trustedDevice ? new Date(trustedDevice.trustedAtMs).toISOString() : null,
        createdAtIso: new Date(session.createdAtMs).toISOString(),
        expiresAtIso: new Date(session.expiresAtMs).toISOString(),
        lastSeenAtIso: new Date(session.lastSeenAtMs).toISOString(),
      })
      return
    }

    if (req.method === 'GET' && req.path === '/auth/devices') {
      const session = readSession(req, nowMs)
      if (!session) {
        res.status(401).json({ authenticated: false })
        return
      }
      res.json({
        devices: sessionStore.listTrustedDevices()
          .map((device) => ({
            deviceId: device.deviceId,
            trustedAtIso: new Date(device.trustedAtMs).toISOString(),
            lastSeenAtIso: new Date(device.lastSeenAtMs).toISOString(),
            current: device.deviceId === session.deviceId,
          })),
      })
      return
    }

    if (req.method === 'POST' && req.path === '/auth/device/trust') {
      const session = readSession(req, nowMs)
      if (!session) {
        res.status(401).json({ authenticated: false })
        return
      }
      const trustedDevice: TrustedDevice = {
        deviceId: session.deviceId,
        trustedAtMs: nowMs,
        lastSeenAtMs: nowMs,
        ip,
      }
      sessionStore.writeTrustedDevice(trustedDevice)
      res.json({
        ok: true,
        deviceId: session.deviceId,
        trustedDevice: true,
        trustedAtIso: new Date(trustedDevice.trustedAtMs).toISOString(),
      })
      return
    }

    if (req.method === 'POST' && req.path === '/auth/device/revoke') {
      const session = readSession(req, nowMs)
      if (!session) {
        res.status(401).json({ authenticated: false })
        return
      }
      sessionStore.deleteTrustedDevice(session.deviceId)
      res.json({
        ok: true,
        deviceId: session.deviceId,
        trustedDevice: false,
      })
      return
    }

    if (req.method === 'POST' && req.path === '/auth/logout') {
      const cookies = parseCookies(req.headers.cookie)
      const token = cookies[TOKEN_COOKIE]
      if (token) sessionStore.deleteSession(token)
      res.setHeader('Set-Cookie', [
        clearCookie(TOKEN_COOKIE),
      ])
      res.json({ ok: true })
      return
    }

    // Handle login POST
    if (req.method === 'POST' && req.path === '/auth/login') {
      const rateLimit = readRateLimit(ip, nowMs)
      if (rateLimit.blockedUntilMs > nowMs) {
        res.status(429).json({
          error: 'Too many failed login attempts',
          retryAfterMs: rateLimit.blockedUntilMs - nowMs,
        })
        return
      }

      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { password?: string }
          const provided = typeof parsed.password === 'string' ? parsed.password : ''

          if (!constantTimeCompare(provided, password)) {
            const nextRateLimit = recordFailedLogin(ip, nowMs)
            const blocked = nextRateLimit.blockedUntilMs > nowMs
            res.status(blocked ? 429 : 401).json({
              error: blocked ? 'Too many failed login attempts' : 'Invalid password',
              remainingAttempts: blocked ? 0 : Math.max(0, maxFailedAttempts - nextRateLimit.failedAtMs.length),
              retryAfterMs: blocked ? nextRateLimit.blockedUntilMs - nowMs : 0,
            })
            return
          }

          const token = randomBytes(32).toString('hex')
          const cookies = parseCookies(req.headers.cookie)
          const deviceId = readDeviceCookie(cookies) || randomBytes(16).toString('hex')
          const session: AuthSession = {
            token,
            deviceId,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + sessionTtlMs,
            lastSeenAtMs: nowMs,
            ip,
          }
          sessionStore.writeSession(session)
          resetRateLimit(ip)
          const trustedDevice = sessionStore.readTrustedDevice(deviceId)
          if (trustedDevice) {
            trustedDevice.lastSeenAtMs = nowMs
            sessionStore.writeTrustedDevice(trustedDevice)
          }

          res.setHeader('Set-Cookie', [
            `${TOKEN_COOKIE}=${token}; ${cookieAttributes(sessionTtlMs / 1000)}`,
            `${DEVICE_COOKIE}=${deviceId}; ${cookieAttributes(365 * 24 * 60 * 60)}`,
          ])
          res.json({
            ok: true,
            expiresAtIso: new Date(session.expiresAtMs).toISOString(),
            deviceId,
            trustedDevice: Boolean(trustedDevice),
            trustedAtIso: trustedDevice ? new Date(trustedDevice.trustedAtMs).toISOString() : null,
          })
        } catch {
          res.status(400).json({ error: 'Invalid request body' })
        }
      })
      return
    }

    // Check for valid token cookie
    if (readSession(req, nowMs)) {
      next()
      return
    }

    // No valid session — serve login page
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(200).send(LOGIN_PAGE_HTML)
  }) as AuthMiddleware

  middleware.authorizeUpgrade = (req: IncomingMessage): boolean =>
    Boolean(readSessionFromCookie(req.headers.cookie, now()))
  middleware.dispose = () => sessionStore.close()

  return middleware
}
