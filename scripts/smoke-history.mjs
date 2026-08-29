import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

const HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const BROWSER_TIMEOUT_MS = 45_000

function readArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return ''
  return process.argv[index + 1]?.trim() ?? ''
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a TCP port')))
        return
      }
      const { port } = address
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern.toString()}. Output:\n${output}`)), timeoutMs)
    function onData(chunk) {
      output += chunk.toString()
      if (!pattern.test(output)) return
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      resolve(output)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function fetchJson(url, init) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const payload = await response.json()
    return { response, payload }
  } finally {
    clearTimeout(timeout)
  }
}

async function rpc(baseUrl, method, params) {
  const { response, payload } = await fetchJson(`${baseUrl}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  assert(response.ok, `${method} returned HTTP ${String(response.status)}: ${JSON.stringify(payload)}`)
  assert(!payload.error, `${method} returned error: ${JSON.stringify(payload.error)}`)
  return payload.result
}

async function findChromeExecutable() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next known browser path.
    }
  }
  return ''
}

async function waitForJson(url, timeoutMs, init = undefined) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, init)
      if (response.ok) return await response.json()
      lastError = new Error(`${url} returned HTTP ${String(response.status)}: ${await response.text()}`)
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`)
}

class CdpPage {
  constructor(webSocket) {
    this.webSocket = webSocket
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    webSocket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (typeof message.id !== 'number') {
        if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
          this.events.push(message)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)))
        return
      }
      pending.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    this.webSocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }

  async screenshot() {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    return typeof result.data === 'string' ? result.data : ''
  }

  diagnostics() {
    return this.events.slice(-8)
  }

  close() {
    this.webSocket.close()
  }
}

async function openChromePage(url) {
  const chromePath = await findChromeExecutable()
  assert(chromePath, 'Chrome, Chromium, or Edge was not found for browser smoke testing.')
  const debugPort = await findFreePort()
  const userDataDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-history-chrome-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  try {
    await waitForJson(`http://${HOST}:${String(debugPort)}/json/version`, BROWSER_TIMEOUT_MS)
    const target = await waitForJson(
      `http://${HOST}:${String(debugPort)}/json/new?${encodeURIComponent(url)}`,
      BROWSER_TIMEOUT_MS,
      { method: 'PUT' },
    )
    const webSocket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      webSocket.once('open', resolve)
      webSocket.once('error', reject)
    })
    const page = new CdpPage(webSocket)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Log.enable')
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    return {
      page,
      async close() {
        page.close()
        await stopChild(chrome)
        await rm(userDataDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await stopChild(chrome)
    await rm(userDataDir, { recursive: true, force: true })
    throw error
  }
}

async function waitForPageValue(page, expression, predicate, timeoutMs) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await page.evaluate(expression)
    if (predicate(lastValue)) return lastValue
    await delay(200)
  }
  throw new Error(`Timed out waiting for page condition. Last value: ${JSON.stringify(lastValue)} Diagnostics: ${JSON.stringify(page.diagnostics())}`)
}

function conversationStateExpression() {
  return `(() => {
    const list = document.querySelector('[data-testid="conversation-list"]');
    const messages = Array.from(document.querySelectorAll('[data-testid="conversation-message"]'));
    const ids = messages.map((message) => message.getAttribute('data-message-id') || '');
    const history = document.querySelector('[data-testid="conversation-history-button"]');
    return {
      ready: Boolean(list),
      renderedCount: messages.length,
      uniqueCount: new Set(ids).size,
      firstId: ids[0] || '',
      lastId: ids.at(-1) || '',
      historyText: history?.textContent?.replace(/\\s+/g, ' ').trim() || '',
      windowText: document.querySelector('.conversation-history-window')?.textContent?.trim() || '',
      scrollTop: list?.scrollTop || 0,
      scrollHeight: list?.scrollHeight || 0,
      clientHeight: list?.clientHeight || 0,
      anchorShift: window.__codyHistoryAnchorId
        ? Math.round((document.querySelector('[data-message-id="' + CSS.escape(window.__codyHistoryAnchorId) + '"]')?.getBoundingClientRect().top || 0) - window.__codyHistoryAnchorTop)
        : null,
      loadError: document.querySelector('.conversation-load-error')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
    };
  })()`
}

function rawThreadItemCount(result) {
  const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : []
  return turns.reduce((sum, turn) => sum + (Array.isArray(turn?.items) ? turn.items.length : 0), 0)
}

function readPngSize(base64Data) {
  const bytes = Buffer.from(base64Data, 'base64')
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return { width: 0, height: 0, bytes: bytes.length }
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
  }
}

const threadId = readArgValue('--thread-id') || process.env.CODY_WEB_UI_SMOKE_HISTORY_THREAD_ID?.trim() || ''
if (!threadId) {
  console.log('History smoke skipped: pass --thread-id <id> or set CODY_WEB_UI_SMOKE_HISTORY_THREAD_ID to a real thread with earlier messages.')
  process.exit(0)
}

const serverPort = await findFreePort()
const server = spawn(process.execPath, [
  'dist-cli/index.js',
  '--host',
  HOST,
  '--port',
  String(serverPort),
  '--no-password',
], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

let browser = null
try {
  await waitForOutput(server, /CodyWeb is running!/u, STARTUP_TIMEOUT_MS)
  const baseUrl = `http://${HOST}:${String(serverPort)}`
  const thread = await rpc(baseUrl, 'thread/read', { threadId, includeTurns: true })
  const rawItemCount = rawThreadItemCount(thread)
  browser = await openChromePage(`${baseUrl}/thread/${threadId}`)

  const initial = await waitForPageValue(
    browser.page,
    conversationStateExpression(),
    (value) => value?.ready === true && value.renderedCount > 0 && value.historyText.length > 0,
    BROWSER_TIMEOUT_MS,
  )
  assert(!initial.loadError, `large thread showed a load error: ${initial.loadError}`)
  assert(initial.uniqueCount === initial.renderedCount, `initial message window contains duplicate ids: ${JSON.stringify(initial)}`)
  assert(initial.firstId && initial.lastId && initial.firstId !== initial.lastId, `initial message window is not populated: ${JSON.stringify(initial)}`)

  const anchor = await browser.page.evaluate(`(() => {
    const list = document.querySelector('[data-testid="conversation-list"]');
    const first = document.querySelector('[data-testid="conversation-message"]');
    list.scrollTop = 0;
    window.__codyHistoryAnchorId = first.getAttribute('data-message-id') || '';
    window.__codyHistoryAnchorTop = first.getBoundingClientRect().top;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { id: window.__codyHistoryAnchorId, top: window.__codyHistoryAnchorTop };
  })()`)
  assert(anchor.id === initial.firstId, `history anchor did not match the first rendered message: ${JSON.stringify({ anchor, initial })}`)

  const expanded = await waitForPageValue(
    browser.page,
    conversationStateExpression(),
    (value) => value?.renderedCount > initial.renderedCount,
    BROWSER_TIMEOUT_MS,
  )
  assert(expanded.uniqueCount === expanded.renderedCount, `expanded message window contains duplicate ids: ${JSON.stringify(expanded)}`)
  assert(expanded.lastId === initial.lastId, `loading earlier messages displaced the latest message: ${JSON.stringify({ initial, expanded })}`)
  assert(expanded.firstId !== initial.firstId, `loading earlier messages did not prepend history: ${JSON.stringify({ initial, expanded })}`)
  assert(expanded.scrollTop > 0, `loading earlier messages left the viewport pinned to the new top: ${JSON.stringify(expanded)}`)
  assert(Math.abs(expanded.anchorShift ?? 999) <= 8, `loading earlier messages visibly shifted the previous top message: ${JSON.stringify(expanded)}`)

  const screenshot = readPngSize(await browser.page.screenshot())
  assert(
    screenshot.width === 1440 && screenshot.height === 1000 && screenshot.bytes > 20_000,
    `large thread screenshot was not captured as a populated desktop PNG: ${JSON.stringify(screenshot)}`,
  )

  await browser.page.send('Page.reload', { ignoreCache: true })
  const reloaded = await waitForPageValue(
    browser.page,
    conversationStateExpression(),
    (value) => value?.ready === true && value.renderedCount === initial.renderedCount && value.historyText.length > 0,
    BROWSER_TIMEOUT_MS,
  )
  assert(reloaded.uniqueCount === reloaded.renderedCount, `reloaded message window contains duplicate ids: ${JSON.stringify(reloaded)}`)
  assert(reloaded.lastId === initial.lastId, `reload did not retain the latest message: ${JSON.stringify({ initial, reloaded })}`)

  console.log(
    `History browser smoke passed for ${threadId}: ${String(rawItemCount)} raw items, ` +
    `${String(initial.renderedCount)} initial messages, ${String(expanded.renderedCount)} after top-scroll, ` +
    `anchor shift ${String(expanded.anchorShift)}px, duplicate-free before/after reload.`,
  )
} finally {
  if (browser) await browser.close()
  await stopChild(server)
}
