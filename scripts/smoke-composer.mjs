import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

const HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const BROWSER_TIMEOUT_MS = 30_000
const DEFAULT_TURN_TIMEOUT_MS = 180_000
const LIVE_DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryPartAdded',
  'turn/plan/updated',
])

function readArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return ''
  return process.argv[index + 1]?.trim() ?? ''
}

function readFlag(name) {
  return process.argv.includes(name)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function readString(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeText(value) {
  return readString(value).replace(/\s+/gu, ' ').trim()
}

function readProtocolId(record, camelKey, snakeKey) {
  return readString(record?.[camelKey]) || readString(record?.[snakeKey])
}

function extractNotificationThreadId(notification) {
  const params = asRecord(notification?.params)
  if (!params) return ''
  const directThreadId = readProtocolId(params, 'threadId', 'thread_id')
  if (directThreadId) return directThreadId
  const conversationId = readProtocolId(params, 'conversationId', 'conversation_id')
  if (conversationId) return conversationId
  const thread = asRecord(params.thread)
  const nestedThreadId = readString(thread?.id)
  if (nestedThreadId) return nestedThreadId
  const turn = asRecord(params.turn)
  return readProtocolId(turn, 'threadId', 'thread_id')
}

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/codex-api/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function createRealtimeRecorder(baseUrl) {
  const frames = []
  const socket = new WebSocket(websocketUrl(baseUrl))
  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for realtime websocket ready frame.')), STARTUP_TIMEOUT_MS)
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.on('message', (data) => {
      let parsed
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      if (parsed?.type === 'ready') {
        clearTimeout(timeout)
        resolve()
        return
      }
      if (parsed?.type === 'rpc' && parsed.notification) {
        frames.push(parsed.notification)
      }
    })
  })

  return {
    waitUntilReady() {
      return readyPromise
    },
    summarize(threadId) {
      const notifications = frames.filter((notification) => extractNotificationThreadId(notification) === threadId)
      const methods = notifications.map((notification) => readString(notification?.method)).filter(Boolean)
      return {
        frameCount: notifications.length,
        hasTurnCompleted: methods.includes('turn/completed'),
        liveDeltaCount: methods.filter((method) => LIVE_DELTA_METHODS.has(method)).length,
      }
    },
    close() {
      socket.close()
    },
  }
}

async function rpc(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const payload = await response.json()
  assert(response.ok, `${method} returned HTTP ${String(response.status)}: ${JSON.stringify(payload)}`)
  assert(!payload.error, `${method} returned error: ${JSON.stringify(payload.error)}`)
  return payload.result
}

function itemText(item) {
  if (!item || typeof item !== 'object') return ''
  if (typeof item.text === 'string') return item.text
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

function readPersistedTurn(threadReadResult, sentMessage) {
  const expected = normalizeText(sentMessage)
  const turns = Array.isArray(threadReadResult?.thread?.turns) ? threadReadResult.thread.turns : []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const items = Array.isArray(turn?.items) ? turn.items : []
    const hasUserMessage = items
      .filter((item) => item?.type === 'userMessage')
      .some((item) => normalizeText(itemText(item)) === expected)
    if (!hasUserMessage) continue
    const assistantText = items
      .filter((item) => item?.type === 'agentMessage' || item?.type === 'plan')
      .map(itemText)
      .find((text) => normalizeText(text).length > 0) || ''
    return {
      id: readString(turn?.id),
      status: readString(turn?.status),
      assistantText,
    }
  }
  return null
}

function isTransientThreadReadError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /rollout .* is empty|failed to read thread/u.test(message)
}

async function tryArchiveThread(baseUrl, threadId) {
  if (!threadId) return
  try {
    await rpc(baseUrl, 'thread/archive', { threadId })
  } catch {
    // Cleanup is best-effort after the browser assertions have completed.
  }
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
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern.toString()}. Output:\n${output}`))
    }, timeoutMs)

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

    const forceKill = setTimeout(() => {
      child.kill('SIGKILL')
    }, 3_000)

    child.once('exit', () => {
      clearTimeout(forceKill)
      resolve()
    })
    child.kill('SIGTERM')
  })
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
        if (
          message.method === 'Runtime.exceptionThrown' ||
          message.method === 'Runtime.consoleAPICalled' ||
          message.method === 'Log.entryAdded'
        ) {
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails))
    }
    return result.result?.value
  }

  diagnostics() {
    return this.events.slice(-8).map((event) => ({
      method: event.method,
      params: event.params,
    }))
  }

  close() {
    this.webSocket.close()
  }
}

async function openChromePage(url) {
  const chromePath = await findChromeExecutable()
  assert(chromePath, 'Chrome, Chromium, or Edge was not found for browser smoke testing.')

  const debugPort = await findFreePort()
  const userDataDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-composer-chrome-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })

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
    await delay(250)
  }
  throw new Error(`Timed out waiting for page condition. Last value: ${JSON.stringify(lastValue)} Diagnostics: ${JSON.stringify(page.diagnostics())}`)
}

function conversationStateExpression(expectedMessage) {
  const expected = JSON.stringify(normalizeText(expectedMessage))
  return `(() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const routeMatch = window.location.pathname.match(/^\\/thread\\/([^/]+)$/);
    const userMessages = Array.from(document.querySelectorAll('[data-testid="conversation-message"][data-role="user"]'));
    // Message rows also contain controls such as copy/share actions. Assert
    // against the rendered message body so UI chrome cannot turn a healthy
    // conversation into a false-negative smoke failure.
    const userText = (element) => normalize(element.querySelector('.cody-markdown-renderer')?.textContent);
    const matchingUsers = userMessages.filter((element) => userText(element) === ${expected});
    const assistantMessages = Array.from(document.querySelectorAll('[data-testid="conversation-message"][data-role="assistant"]'));
    const assistantText = assistantMessages.map((element) => normalize(element.textContent)).filter(Boolean).join(' ');
    const input = document.querySelector('[data-testid="thread-composer-input"]');
    return {
      href: window.location.href,
      threadId: routeMatch ? decodeURIComponent(routeMatch[1]) : '',
      matchingUserCount: matchingUsers.length,
      optimisticUserCount: matchingUsers.filter((element) => element.getAttribute('data-message-type') === 'userMessage.optimistic').length,
      userMessageTypes: matchingUsers.map((element) => element.getAttribute('data-message-type') || ''),
      assistantText,
      assistantChars: assistantText.length,
      hasLiveOverlay: Boolean(document.querySelector('[data-testid="conversation-live-overlay-toggle"]')),
      liveOverlayText: normalize(document.querySelector('[data-testid="conversation-live-overlay-toggle"]')?.textContent),
      isTurnInProgress: Boolean(document.querySelector('.thread-composer-stop')),
      inputDisabled: input ? input.disabled : true,
      isLoadingMessages: document.body.textContent.includes('Loading messages...'),
      loadError: normalize(document.querySelector('.conversation-load-error')?.textContent)
    };
  })()`
}

function turnHasCompleted(status) {
  return /completed|complete|succeeded|success/u.test(status)
}

const allowTurn = readFlag('--allow-turn') || process.env.CODY_WEB_UI_SMOKE_ALLOW_COMPOSER_TURN === '1'
const requireLiveRender = readFlag('--require-live-render')
const turnTimeoutMs = Number.parseInt(readArgValue('--timeout-ms') || '', 10) || DEFAULT_TURN_TIMEOUT_MS
const message = readArgValue('--message') || (allowTurn
  ? `CodyWeb browser realtime smoke ${String(Date.now())}: do not use tools; reply with exactly twelve numbered lines, each containing the words "cody web ui live".`
  : 'browser composer smoke')

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
let realtime = null
let createdThreadId = ''
try {
  await waitForOutput(server, /CodyWeb is running!/u, STARTUP_TIMEOUT_MS)
  const baseUrl = `http://${HOST}:${String(serverPort)}`
  if (allowTurn) {
    realtime = createRealtimeRecorder(baseUrl)
    await realtime.waitUntilReady()
  }
  browser = await openChromePage(baseUrl)

  const readyState = await waitForPageValue(
    browser.page,
    `(() => {
      const input = document.querySelector('[data-testid="thread-composer-input"]');
      const submit = document.querySelector('[data-testid="thread-composer-submit"]');
      return input && submit ? {
        href: window.location.href,
        inputDisabled: input.disabled,
        submitDisabled: submit.disabled,
        placeholder: input.getAttribute('placeholder') || '',
        body: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 800)
      } : null;
    })()`,
    (value) => value && value.inputDisabled === false,
    BROWSER_TIMEOUT_MS,
  )
  assert(readyState.submitDisabled === true, 'composer submit should start disabled before text entry')

  const typedState = await browser.page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="thread-composer-input"]');
    const submit = document.querySelector('[data-testid="thread-composer-submit"]');
    input.value = ${JSON.stringify(message)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      value: input.value,
      submitDisabled: submit.disabled
    };
  })()`)
  assert(typedState.value === message, 'composer text was not entered')

  await waitForPageValue(
    browser.page,
    `(() => {
      const submit = document.querySelector('[data-testid="thread-composer-submit"]');
      return submit ? { submitDisabled: submit.disabled } : null;
    })()`,
    (value) => value?.submitDisabled === false,
    BROWSER_TIMEOUT_MS,
  )

  if (!allowTurn) {
    console.log('Composer browser smoke passed: input enabled and send button activates after typing.')
  } else {
    const sentAtMs = Date.now()
    await browser.page.evaluate(`(() => {
      const submit = document.querySelector('[data-testid="thread-composer-submit"]');
      submit.click();
      return true;
    })()`)

    const firstUserState = await waitForPageValue(
      browser.page,
      conversationStateExpression(message),
      (value) => value?.threadId && value.matchingUserCount === 1,
      BROWSER_TIMEOUT_MS,
    )
    createdThreadId = firstUserState.threadId
    const optimisticLatencyMs = Date.now() - sentAtMs
    assert(!firstUserState.loadError, `thread page showed a load error after sending: ${firstUserState.loadError}`)

    const startedAtMs = Date.now()
    let finalTurn = null
    let finalPageState = firstUserState
    let sawAssistantBeforeCompletion = false
    let sawLiveOverlay = firstUserState.hasLiveOverlay
    let lastReadError = ''
    let nextReadAtMs = 0

    while (Date.now() - startedAtMs < turnTimeoutMs) {
      finalPageState = await browser.page.evaluate(conversationStateExpression(message))
      const realtimeSummary = realtime.summarize(createdThreadId)
      if (finalPageState.assistantChars > 0 && !realtimeSummary.hasTurnCompleted) {
        sawAssistantBeforeCompletion = true
      }
      sawLiveOverlay ||= finalPageState.hasLiveOverlay

      if (Date.now() >= nextReadAtMs) {
        nextReadAtMs = Date.now() + 500
        try {
          const read = await rpc(baseUrl, 'thread/read', {
            threadId: createdThreadId,
            includeTurns: true,
          })
          finalTurn = readPersistedTurn(read, message)
          lastReadError = ''
        } catch (error) {
          if (!isTransientThreadReadError(error)) throw error
          lastReadError = error instanceof Error ? error.message : String(error)
        }
      }

      if (
        finalTurn?.assistantText &&
        turnHasCompleted(finalTurn.status) &&
        realtimeSummary.hasTurnCompleted &&
        finalPageState.assistantChars > 0 &&
        !finalPageState.isTurnInProgress
      ) {
        break
      }
      await delay(100)
    }

    const realtimeSummary = realtime.summarize(createdThreadId)
    assert(finalTurn?.assistantText, `turn did not persist an assistant response. Last read error: ${lastReadError}`)
    assert(turnHasCompleted(finalTurn.status), `turn did not complete successfully: ${JSON.stringify(finalTurn)}`)
    assert(realtimeSummary.frameCount > 0, 'browser turn completed without thread-scoped realtime frames')
    assert(realtimeSummary.liveDeltaCount > 0, 'browser turn completed without realtime delta frames')
    assert(finalPageState.assistantChars > 0, `assistant response was persisted but not rendered: ${JSON.stringify(finalPageState)}`)
    assert(finalPageState.matchingUserCount === 1, `sent user message rendered ${String(finalPageState.matchingUserCount)} times before reload`)
    assert(!finalPageState.isLoadingMessages, 'thread remained stuck on Loading messages after the response completed')
    if (requireLiveRender) {
      assert(
        sawAssistantBeforeCompletion,
        `assistant text never appeared in the DOM before turn/completed. Realtime: ${JSON.stringify(realtimeSummary)}`,
      )
    }

    await browser.page.send('Page.reload', { ignoreCache: true })
    const reloadedState = await waitForPageValue(
      browser.page,
      conversationStateExpression(message),
      (value) => value?.threadId === createdThreadId && value.matchingUserCount === 1 && value.assistantChars > 0,
      BROWSER_TIMEOUT_MS,
    )
    assert(!reloadedState.loadError, `thread page showed a load error after reload: ${reloadedState.loadError}`)
    assert(reloadedState.matchingUserCount === 1, `sent user message rendered ${String(reloadedState.matchingUserCount)} times after reload`)

    console.log(
      `Composer live-turn smoke passed for ${createdThreadId}/${finalTurn.id}: user bubble ${String(optimisticLatencyMs)}ms, ` +
      `${String(realtimeSummary.liveDeltaCount)} live deltas, live DOM ${sawAssistantBeforeCompletion ? 'yes' : 'not required'}, ` +
      `overlay ${sawLiveOverlay ? 'seen' : 'not seen'}, one user message before and after reload.`,
    )
  }
} finally {
  realtime?.close()
  if (createdThreadId) {
    try {
      await tryArchiveThread(`http://${HOST}:${String(serverPort)}`, createdThreadId)
    } catch {
      // Server shutdown still proceeds if cleanup cannot reach app-server.
    }
  }
  if (browser) await browser.close()
  await stopChild(server)
}
