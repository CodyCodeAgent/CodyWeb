import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000
const DEFAULT_APPROVAL_POLICY = 'untrusted'
const DEFAULT_THREAD_SANDBOX = 'read-only'
const DEFAULT_TURN_SANDBOX_POLICY = {
  type: 'readOnly',
  access: { type: 'fullAccess' },
}
const DEFAULT_COMMAND = 'node -e "console.log(\\"cody-web-ui approval smoke\\")"'
const DEFAULT_MESSAGE = [
  'CodyWeb approval smoke test.',
  'You must use the shell/command execution tool to run exactly this command now.',
  'Do not only describe the command. Do not ask a follow-up question.',
  DEFAULT_COMMAND,
  'After the command is declined, briefly say the approval smoke was declined.',
].join('\n')

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

async function safeRpc(baseUrl, method, params) {
  try {
    return await rpc(baseUrl, method, params)
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function postJson(baseUrl, path, body) {
  const { response, payload } = await fetchJson(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert(response.ok, `${path} returned HTTP ${String(response.status)}: ${JSON.stringify(payload)}`)
  return payload
}

async function getJson(baseUrl, path) {
  const { response, payload } = await fetchJson(`${baseUrl}${path}`)
  assert(response.ok, `${path} returned HTTP ${String(response.status)}: ${JSON.stringify(payload)}`)
  return payload
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

function readThreadId(payload) {
  const id = payload?.thread?.id
  return typeof id === 'string' ? id.trim() : ''
}

function readTurnId(payload) {
  const id = payload?.turn?.id
  return typeof id === 'string' ? id.trim() : ''
}

function readPendingRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : []
}

function requestThreadId(request) {
  if (typeof request?.threadId === 'string') return request.threadId
  if (typeof request?.params?.threadId === 'string') return request.params.threadId
  return ''
}

function requestTurnId(request) {
  if (typeof request?.turnId === 'string') return request.turnId
  if (typeof request?.params?.turnId === 'string') return request.params.turnId
  return ''
}

function requestSubject(request) {
  return [
    request?.params?.command,
    request?.params?.reason,
    request?.method,
  ].filter((value) => typeof value === 'string' && value.length > 0).join('\n')
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

function summarizeItem(item) {
  if (!item || typeof item !== 'object') return null
  return {
    id: typeof item.id === 'string' ? item.id : '',
    type: typeof item.type === 'string' ? item.type : '',
    status: typeof item.status === 'string' ? item.status : '',
    text: itemText(item).replace(/\s+/gu, ' ').trim().slice(0, 180),
    command: typeof item.command === 'string'
      ? item.command
      : typeof item.params?.command === 'string'
        ? item.params.command
        : '',
    toolKind: typeof item.tool?.kind === 'string' ? item.tool.kind : '',
  }
}

function summarizeThreadRead(threadReadResult, turnId) {
  const turns = Array.isArray(threadReadResult?.thread?.turns) ? threadReadResult.thread.turns : []
  const turn = turns.find((candidate) => candidate?.id === turnId)
  const items = Array.isArray(turn?.items) ? turn.items : []
  return {
    threadName: typeof threadReadResult?.thread?.name === 'string' ? threadReadResult.thread.name : '',
    turnStatus: typeof turn?.status === 'string' ? turn.status : '',
    itemCount: items.length,
    items: items.slice(-8).map(summarizeItem).filter(Boolean),
  }
}

function isTurnCompletedWithoutApproval(summary) {
  if (!summary || typeof summary !== 'object') return false
  return summary.turnStatus === 'completed' && summary.itemCount > 1
}

async function readApprovalDiagnostics(baseUrl, threadId, turnId, lastRows) {
  const threadRead = await safeRpc(baseUrl, 'thread/read', {
    threadId,
    includeTurns: true,
  })
  let gatewayDiagnostics = null
  try {
    gatewayDiagnostics = await getJson(baseUrl, '/codex-api/meta/diagnostics')
  } catch (error) {
    gatewayDiagnostics = {
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const appServer = gatewayDiagnostics?.result?.appServer ?? {}
  return {
    pendingRows: lastRows,
    thread: threadRead?.error ? threadRead : summarizeThreadRead(threadRead, turnId),
    appServer: {
      status: appServer.status,
      initialized: appServer.initialized,
      pendingClientRequestCount: appServer.pendingClientRequestCount,
      pendingServerRequestCount: appServer.pendingServerRequestCount,
      sentClientRequestCount: appServer.sentClientRequestCount,
      completedClientRequestCount: appServer.completedClientRequestCount,
      failedClientRequestCount: appServer.failedClientRequestCount,
      notificationCount: appServer.notificationCount,
      serverRequestCount: appServer.serverRequestCount,
      pendingServerRequests: appServer.pendingServerRequests,
      recentLogs: Array.isArray(appServer.recentLogs) ? appServer.recentLogs.slice(-6) : [],
    },
  }
}

async function waitForCommandApproval(baseUrl, threadId, turnId, timeoutMs) {
  const startedAt = Date.now()
  let lastRows = []
  let lastThreadSummary = null
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await getJson(baseUrl, '/codex-api/server-requests/pending')
    lastRows = readPendingRows(payload)
    const approval = lastRows.find((request) => {
      if (request?.method !== 'item/commandExecution/requestApproval') return false
      const rowThreadId = requestThreadId(request)
      const rowTurnId = requestTurnId(request)
      if (rowThreadId && rowThreadId !== threadId) return false
      if (rowTurnId && rowTurnId !== turnId) return false
      return true
    })
    if (approval) return approval
    if ((Date.now() - startedAt) % 10_000 < 1_000) {
      const threadRead = await safeRpc(baseUrl, 'thread/read', {
        threadId,
        includeTurns: true,
      })
      lastThreadSummary = threadRead?.error ? threadRead : summarizeThreadRead(threadRead, turnId)
      if (isTurnCompletedWithoutApproval(lastThreadSummary)) {
        break
      }
    }
    await delay(1_000)
  }
  const diagnostics = await readApprovalDiagnostics(baseUrl, threadId, turnId, lastRows)
  if (lastThreadSummary) {
    diagnostics.threadDuringPolling = lastThreadSummary
  }
  const outcome = isTurnCompletedWithoutApproval(diagnostics.thread)
    ? 'The turn completed without producing an item/commandExecution/requestApproval request. This usually means the model answered without actually invoking command execution.'
    : 'Timed out waiting for natural command approval.'
  throw new Error(`${outcome} Thread ${threadId}/${turnId}. Diagnostics: ${JSON.stringify(diagnostics)}`)
}

async function tryArchiveThread(baseUrl, threadId) {
  try {
    await rpc(baseUrl, 'thread/archive', { threadId })
  } catch {
    // Cleanup is best-effort; approval evidence is the primary smoke result.
  }
}

const allowTurnApproval = readFlag('--allow-turn-approval') || process.env.CODY_WEB_UI_SMOKE_ALLOW_TURN_APPROVAL === '1'
if (!allowTurnApproval) {
  console.log('Turn approval smoke skipped: set CODY_WEB_UI_SMOKE_ALLOW_TURN_APPROVAL=1 or pass --allow-turn-approval to start a real Codex turn that may consume model tokens.')
  process.exit(0)
}

const requestedCwd = readArgValue('--cwd')
const temporaryWorkspace = requestedCwd ? '' : await mkdtemp(join(tmpdir(), 'cody-web-ui-turn-approval-'))
const cwd = requestedCwd || temporaryWorkspace
const message = readArgValue('--message') || DEFAULT_MESSAGE
const model = readArgValue('--model')
const effort = readArgValue('--effort')
const timeoutMs = Number.parseInt(readArgValue('--timeout-ms') || '', 10) || DEFAULT_APPROVAL_TIMEOUT_MS
const approvalPolicy = readArgValue('--approval-policy') || DEFAULT_APPROVAL_POLICY
const disableApprovalOverrides = readFlag('--no-approval-overrides')
const port = await findFreePort()
const child = spawn(process.execPath, [
  'dist-cli/index.js',
  '--host',
  HOST,
  '--port',
  String(port),
  '--no-password',
], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

let createdThreadId = ''
try {
  await waitForOutput(child, /CodyWeb is running!/u, STARTUP_TIMEOUT_MS)
  const baseUrl = `http://${HOST}:${String(port)}`
  const startParams = { cwd }
  if (model) startParams.model = model
  if (!disableApprovalOverrides) {
    startParams.approvalPolicy = approvalPolicy
    startParams.sandbox = DEFAULT_THREAD_SANDBOX
  }
  const started = await rpc(baseUrl, 'thread/start', startParams)
  createdThreadId = readThreadId(started)
  assert(createdThreadId, 'thread/start did not return a thread id')

  const turnParams = {
    threadId: createdThreadId,
    input: [{ type: 'text', text: message, text_elements: [] }],
  }
  if (model) turnParams.model = model
  if (effort) turnParams.effort = effort
  if (!disableApprovalOverrides) {
    turnParams.approvalPolicy = approvalPolicy
    turnParams.sandboxPolicy = DEFAULT_TURN_SANDBOX_POLICY
  }

  const turnStarted = await rpc(baseUrl, 'turn/start', turnParams)
  const turnId = readTurnId(turnStarted)
  assert(turnId, 'turn/start did not return a turn id')

  const approval = await waitForCommandApproval(baseUrl, createdThreadId, turnId, timeoutMs)
  await postJson(baseUrl, '/codex-api/server-requests/respond', {
    id: approval.id,
    approvalScope: 'single',
    result: { decision: 'decline' },
  })
  await delay(500)
  const remaining = readPendingRows(await getJson(baseUrl, '/codex-api/server-requests/pending'))
    .filter((request) => request?.id === approval.id)
  assert(remaining.length === 0, `approval request ${String(approval.id)} was not resolved`)
  await tryArchiveThread(baseUrl, createdThreadId)
  console.log(`Turn approval smoke passed for ${createdThreadId}/${turnId}: natural ${approval.method} request ${String(approval.id)} was rendered by the bridge and declined. Subject: ${requestSubject(approval).slice(0, 120)}`)
} finally {
  if (createdThreadId) {
    try {
      const baseUrl = `http://${HOST}:${String(port)}`
      await tryArchiveThread(baseUrl, createdThreadId)
    } catch {
      // Ignore cleanup failures.
    }
  }
  await stopChild(child)
  if (temporaryWorkspace) {
    await rm(temporaryWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
