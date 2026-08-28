import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

const HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const BROWSER_TIMEOUT_MS = 30_000
const THEME_SETTING_KEY = 'theme.preferences.v1'
const EXPECTED_THEME = {
  skinId: 'control-tower',
  density: 'spacious',
  layoutPresetId: 'ide-mode',
  accentColor: '#ff3366',
}
const EXPECTED_LAYOUT_VARIABLES = {
  'chat-focus': { contentMax: '72rem', conversationMax: '46rem', composerMax: '46rem' },
  'review-focus': { contentMax: '96rem', conversationMax: '86rem', composerMax: '72rem' },
  'ops-dashboard': { contentMax: '100rem', conversationMax: '62rem', composerMax: '58rem' },
  'ide-mode': { contentMax: 'none', conversationMax: 'none', composerMax: '80rem' },
  'mobile-review': { contentMax: '52rem', conversationMax: '46rem', composerMax: '46rem' },
}
const EXPECTED_DENSITY_VARIABLES = {
  compact: { panelGap: '.5rem', panelPadding: '.625rem', messageGap: '.5rem' },
  comfortable: { panelGap: '.75rem', panelPadding: '.75rem', messageGap: '.75rem' },
  spacious: { panelGap: '1rem', panelPadding: '1rem', messageGap: '1rem' },
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

  async screenshot() {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    return typeof result.data === 'string' ? result.data : ''
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
  const userDataDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-theme-chrome-'))
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
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1100,
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
    await delay(250)
  }
  throw new Error(`Timed out waiting for page condition. Last value: ${JSON.stringify(lastValue)} Diagnostics: ${JSON.stringify(page.diagnostics())}`)
}

async function setThemeSelect(page, testId, value, rootDatasetKey) {
  await page.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testId}"]');
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  return waitForPageValue(
    page,
    `(() => {
      const layout = document.querySelector('.desktop-layout');
      const styles = layout ? getComputedStyle(layout) : null;
      return {
        selected: document.querySelector('[data-testid="${testId}"]')?.value || '',
        rootValue: document.documentElement.dataset[${JSON.stringify(rootDatasetKey)}] || '',
        contentMax: styles?.getPropertyValue('--ui-content-max').trim() || '',
        conversationMax: styles?.getPropertyValue('--ui-conversation-max').trim() || '',
        composerMax: styles?.getPropertyValue('--ui-composer-max').trim() || '',
        panelGap: styles?.getPropertyValue('--ui-panel-gap').trim() || '',
        panelPadding: styles?.getPropertyValue('--ui-panel-padding').trim() || '',
        messageGap: styles?.getPropertyValue('--ui-message-gap').trim() || ''
      };
    })()`,
    (state) => state?.selected === value && state.rootValue === value,
    BROWSER_TIMEOUT_MS,
  )
}

async function assertMainThemeHealth(page, baseUrl) {
  await page.send('Page.navigate', { url: `${baseUrl}/` })
  const state = await waitForPageValue(
    page,
    `(() => {
      const root = document.documentElement;
      const layout = document.querySelector('.desktop-layout');
      const content = document.querySelector('.content-body');
      const composer = document.querySelector('.thread-composer');
      const composerShell = document.querySelector('.thread-composer-shell');
      const newThreadGrid = document.querySelector('.new-thread-grid');
      const newThreadEmpty = document.querySelector('.new-thread-empty');
      const sidebar = document.querySelector('.desktop-sidebar');
      const main = document.querySelector('.desktop-main');
      function rect(element) {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height), visible: box.width > 0 && box.height > 0 };
      }
      const layoutStyles = layout ? getComputedStyle(layout) : null;
      const composerRect = composer?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      return {
        ready: Boolean(layout && content && composer && composerShell && newThreadGrid && newThreadEmpty && sidebar && main),
        rootSkin: root.dataset.themeSkin || '',
        rootDensity: root.dataset.themeDensity || '',
        rootLayout: root.dataset.layoutPreset || '',
        layoutSkin: layout?.dataset.themeSkin || '',
        layoutDensity: layout?.dataset.themeDensity || '',
        layoutPreset: layout?.dataset.layoutPreset || '',
        accent: getComputedStyle(root).getPropertyValue('--color-accent').trim(),
        contentMaxVariable: layoutStyles?.getPropertyValue('--ui-content-max').trim() || '',
        composerMaxVariable: layoutStyles?.getPropertyValue('--ui-composer-max').trim() || '',
        panelGapVariable: layoutStyles?.getPropertyValue('--ui-panel-gap').trim() || '',
        contentMaxWidth: content ? getComputedStyle(content).maxWidth : '',
        contentPaddingLeft: content ? getComputedStyle(content).paddingLeft : '',
        composer: rect(composer),
        newThreadGrid: rect(newThreadGrid),
        newThreadEmpty: rect(newThreadEmpty),
        composerCenterOffset: composerRect && mainRect
          ? Math.round(Math.abs((composerRect.left + composerRect.width / 2) - (mainRect.left + mainRect.width / 2)))
          : -1,
        composerBackground: composerShell ? getComputedStyle(composerShell).backgroundColor : '',
        sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
        mainBackground: main ? getComputedStyle(main).backgroundColor : '',
        viewportWidth: window.innerWidth,
        scrollWidth: root.scrollWidth
      };
    })()`,
    (value) => value?.ready === true && value.newThreadGrid?.visible === true && value.composer?.visible === true,
    BROWSER_TIMEOUT_MS,
  )

  assert(state.rootSkin === EXPECTED_THEME.skinId && state.layoutSkin === EXPECTED_THEME.skinId, `Main page skin attributes diverged: ${JSON.stringify(state)}`)
  assert(state.rootDensity === EXPECTED_THEME.density && state.layoutDensity === EXPECTED_THEME.density, `Main page density attributes diverged: ${JSON.stringify(state)}`)
  assert(state.rootLayout === EXPECTED_THEME.layoutPresetId && state.layoutPreset === EXPECTED_THEME.layoutPresetId, `Main page layout attributes diverged: ${JSON.stringify(state)}`)
  assert(state.accent.toLowerCase() === EXPECTED_THEME.accentColor, `Main page accent did not persist: ${JSON.stringify(state)}`)
  assert(state.contentMaxVariable === EXPECTED_LAYOUT_VARIABLES['ide-mode'].contentMax, `IDE layout variable did not apply: ${JSON.stringify(state)}`)
  assert(state.composerMaxVariable === EXPECTED_LAYOUT_VARIABLES['ide-mode'].composerMax, `IDE composer width did not apply: ${JSON.stringify(state)}`)
  assert(state.panelGapVariable === EXPECTED_DENSITY_VARIABLES.spacious.panelGap, `Spacious density did not reach the main page: ${JSON.stringify(state)}`)
  assert(state.contentPaddingLeft === '32px', `Spacious content gutter did not apply: ${JSON.stringify(state)}`)
  assert(state.composer.width >= 700, `Home composer is unexpectedly narrow: ${JSON.stringify(state)}`)
  assert(state.newThreadEmpty.visible === true, `Centered new-thread prompt is not visible: ${JSON.stringify(state)}`)
  assert(state.composerCenterOffset <= 2, `Home composer is not centered in the main surface: ${JSON.stringify(state)}`)
  assert(state.composerBackground !== 'rgb(255, 255, 255)', `Dark home composer leaked a light-only background: ${JSON.stringify(state)}`)
  assert(state.sidebarBackground !== state.mainBackground, `Theme surfaces collapsed to one color: ${JSON.stringify(state)}`)
  assert(state.scrollWidth <= state.viewportWidth + 1, `Main page has horizontal overflow: ${JSON.stringify(state)}`)
  return state
}

async function assertLightThemeHealth(page, baseUrl) {
  await page.send('Page.navigate', { url: `${baseUrl}/settings` })
  await waitForPageValue(
    page,
    `Boolean(document.querySelector('[data-testid="theme-skin-select"]') && document.querySelector('[data-testid="theme-accent-input"]'))`,
    (value) => value === true,
    BROWSER_TIMEOUT_MS,
  )
  await setThemeSelect(page, 'theme-skin-select', 'light-pro', 'themeSkin')
  await setThemeSelect(page, 'theme-color-mode-select', 'light', 'themeColorMode')
  await page.evaluate(`(() => {
    const accent = document.querySelector('[data-testid="theme-accent-input"]');
    accent.value = '#1d4ed8';
    accent.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)

  const settingsState = await waitForPageValue(
    page,
    `(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      return {
        skin: root.dataset.themeSkin || '',
        accent: styles.getPropertyValue('--color-accent').trim(),
        background: styles.getPropertyValue('--color-background').trim(),
        panel: styles.getPropertyValue('--color-panel').trim(),
        text: styles.getPropertyValue('--color-text').trim(),
        colorScheme: styles.colorScheme || '',
        overflow: root.scrollWidth > window.innerWidth
      };
    })()`,
    (value) => value?.skin === 'light-pro' && value.accent.toLowerCase() === '#1d4ed8',
    BROWSER_TIMEOUT_MS,
  )
  assert(settingsState.background === '#f8fafc', `Light theme background token is wrong: ${JSON.stringify(settingsState)}`)
  assert(settingsState.panel === '#ffffff', `Light theme panel token is wrong: ${JSON.stringify(settingsState)}`)
  assert(settingsState.text === '#0f172a', `Light theme text token is wrong: ${JSON.stringify(settingsState)}`)
  assert(settingsState.colorScheme.includes('light'), `Light theme color-scheme did not apply: ${JSON.stringify(settingsState)}`)
  assert(settingsState.overflow === false, `Light Settings page has horizontal overflow: ${JSON.stringify(settingsState)}`)

  await page.send('Page.navigate', { url: `${baseUrl}/` })
  const mainState = await waitForPageValue(
    page,
    `(() => {
      const root = document.documentElement;
      const composer = document.querySelector('.thread-composer');
      const composerShell = document.querySelector('.thread-composer-shell');
      const hero = document.querySelector('.new-thread-hero');
      return {
        ready: Boolean(composer && composerShell && hero),
        skin: root.dataset.themeSkin || '',
        composerBackground: composerShell ? getComputedStyle(composerShell).backgroundColor : '',
        heroColor: hero ? getComputedStyle(hero).color : '',
        overflow: root.scrollWidth > window.innerWidth
      };
    })()`,
    (value) => value?.ready === true && value.skin === 'light-pro',
    BROWSER_TIMEOUT_MS,
  )
  assert(mainState.composerBackground !== 'rgb(32, 36, 44)', `Light home composer retained the dark panel surface: ${JSON.stringify(mainState)}`)
  assert(mainState.heroColor === 'rgb(15, 23, 42)', `Light home heading text token did not apply: ${JSON.stringify(mainState)}`)
  assert(mainState.overflow === false, `Light main page has horizontal overflow: ${JSON.stringify(mainState)}`)
  return { settingsState, mainState }
}

function readPngSize(base64Data) {
  const bytes = Buffer.from(base64Data, 'base64')
  if (bytes.length < 24) return { width: 0, height: 0, bytes: bytes.length }
  const pngSignature = '89504e470d0a1a0a'
  if (bytes.subarray(0, 8).toString('hex') !== pngSignature) {
    return { width: 0, height: 0, bytes: bytes.length }
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
  }
}

async function assertThemeVisualHealth(page) {
  const visual = await page.evaluate(`(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    function rect(selector) {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
        left: Math.round(box.left),
        visible: box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0,
      };
    }
    function hexToRgb(value) {
      const hex = value.trim().replace(/^#/, '');
      const full = hex.length === 3
        ? hex.split('').map((part) => part + part).join('')
        : hex.slice(0, 6);
      if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
      return [
        Number.parseInt(full.slice(0, 2), 16) / 255,
        Number.parseInt(full.slice(2, 4), 16) / 255,
        Number.parseInt(full.slice(4, 6), 16) / 255,
      ];
    }
    function luminance(rgb) {
      if (!rgb) return 0;
      const linear = rgb.map((channel) => (
        channel <= 0.03928
          ? channel / 12.92
          : Math.pow((channel + 0.055) / 1.055, 2.4)
      ));
      return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
    }
    function contrast(a, b) {
      const first = luminance(hexToRgb(a));
      const second = luminance(hexToRgb(b));
      const light = Math.max(first, second);
      const dark = Math.min(first, second);
      return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
    }
    const background = styles.getPropertyValue('--color-background').trim();
    const panel = styles.getPropertyValue('--color-panel').trim();
    const text = styles.getPropertyValue('--color-text').trim();
    const accent = styles.getPropertyValue('--color-accent').trim();
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      bodyTextLength: document.body.textContent.length,
      themePanel: rect('.workspace-theme-panel'),
      background,
      panel,
      text,
      accent,
      textOnBackground: contrast(text, background),
      textOnPanel: contrast(text, panel),
    };
  })()`)

  assert(visual.scrollWidth <= visual.viewportWidth + 1, `Settings page has horizontal overflow: ${JSON.stringify(visual)}`)
  assert(visual.bodyTextLength > 500, `Settings page rendered too little text: ${JSON.stringify(visual)}`)
  assert(visual.themePanel?.visible === true && visual.themePanel.width >= 600, `Theme panel is not visibly laid out: ${JSON.stringify(visual)}`)
  assert(visual.background !== visual.panel, `Theme background and panel colors collapsed together: ${JSON.stringify(visual)}`)
  assert(visual.accent.toLowerCase() === EXPECTED_THEME.accentColor, `Theme accent did not apply visually: ${JSON.stringify(visual)}`)
  assert(visual.textOnBackground >= 4.5, `Theme text/background contrast is too low: ${JSON.stringify(visual)}`)
  assert(visual.textOnPanel >= 4.5, `Theme text/panel contrast is too low: ${JSON.stringify(visual)}`)

  const screenshot = readPngSize(await page.screenshot())
  assert(
    screenshot.width === 1440 && screenshot.height === 1100 && screenshot.bytes > 20_000,
    `Theme screenshot was not captured as a populated desktop PNG: ${JSON.stringify(screenshot)}`,
  )

  return { visual, screenshot }
}

const settingsDir = await mkdtemp(join(tmpdir(), 'cody-web-ui-theme-settings-'))
const settingsDbPath = join(settingsDir, 'settings.sqlite3')
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
  env: {
    ...process.env,
    CODY_WEB_UI_SETTINGS_DB: settingsDbPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let browser = null
try {
  await waitForOutput(server, /CodyWeb is running!/u, STARTUP_TIMEOUT_MS)
  const baseUrl = `http://${HOST}:${String(serverPort)}`
  browser = await openChromePage(`${baseUrl}/settings`)

  await waitForPageValue(
    browser.page,
    `(() => {
      const skin = document.querySelector('[data-testid="theme-skin-select"]');
      const density = document.querySelector('[data-testid="theme-density-select"]');
      const layout = document.querySelector('[data-testid="theme-layout-select"]');
      const accent = document.querySelector('[data-testid="theme-accent-input"]');
      return {
        ready: Boolean(skin && density && layout && accent),
        skin: skin?.value || '',
        density: density?.value || '',
        layout: layout?.value || '',
        accent: accent?.value || '',
        disabled: Boolean(skin?.disabled || density?.disabled || layout?.disabled || accent?.disabled),
        persistenceError: document.querySelector('[data-testid="theme-persistence-error"]')?.textContent || '',
      };
    })()`,
    (value) => value?.ready === true && value.disabled === false,
    BROWSER_TIMEOUT_MS,
  )

  await browser.page.evaluate(`(() => {
    function setSelect(testId, value) {
      const element = document.querySelector('[data-testid="' + testId + '"]');
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function setInput(testId, value) {
      const element = document.querySelector('[data-testid="' + testId + '"]');
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setSelect('theme-skin-select', '${EXPECTED_THEME.skinId}');
    setSelect('theme-layout-select', '${EXPECTED_THEME.layoutPresetId}');
    setSelect('theme-density-select', '${EXPECTED_THEME.density}');
    setInput('theme-accent-input', '${EXPECTED_THEME.accentColor}');
  })()`)

  await waitForPageValue(
    browser.page,
    `(() => {
      const root = document.documentElement;
      return {
        skin: root.dataset.themeSkin || '',
        density: root.dataset.themeDensity || '',
        layout: root.dataset.layoutPreset || '',
        accent: getComputedStyle(root).getPropertyValue('--color-accent').trim(),
        colorScheme: getComputedStyle(root).colorScheme || '',
        persistenceError: document.querySelector('[data-testid="theme-persistence-error"]')?.textContent || '',
      };
    })()`,
    (value) =>
      value?.skin === EXPECTED_THEME.skinId &&
      value?.density === EXPECTED_THEME.density &&
      value?.layout === EXPECTED_THEME.layoutPresetId &&
      value?.accent.toLowerCase() === EXPECTED_THEME.accentColor &&
      value?.persistenceError === '',
    BROWSER_TIMEOUT_MS,
  )

  await waitForPageValue(
    browser.page,
    `fetch('/codex-api/settings?key=${encodeURIComponent(THEME_SETTING_KEY)}')
      .then((response) => response.json())
      .then((payload) => payload.result?.setting?.value || null)`,
    (value) =>
      value?.skinId === EXPECTED_THEME.skinId &&
      value?.density === EXPECTED_THEME.density &&
      value?.layoutPresetId === EXPECTED_THEME.layoutPresetId &&
      value?.accentColor?.toLowerCase() === EXPECTED_THEME.accentColor,
    BROWSER_TIMEOUT_MS,
  )

  await browser.page.evaluate(`(() => {
    localStorage.clear();
    location.reload();
  })()`)

  const restored = await waitForPageValue(
    browser.page,
    `(() => {
      const skin = document.querySelector('[data-testid="theme-skin-select"]');
      const density = document.querySelector('[data-testid="theme-density-select"]');
      const layout = document.querySelector('[data-testid="theme-layout-select"]');
      const accent = document.querySelector('[data-testid="theme-accent-input"]');
      const root = document.documentElement;
      return {
        ready: Boolean(skin && density && layout && accent),
        skin: skin?.value || '',
        density: density?.value || '',
        layout: layout?.value || '',
        accent: accent?.value || '',
        summary: document.querySelector('[data-testid="theme-summary"]')?.textContent?.trim() || '',
        detail: document.querySelector('[data-testid="theme-detail"]')?.textContent?.trim() || '',
        rootSkin: root.dataset.themeSkin || '',
        rootDensity: root.dataset.themeDensity || '',
        rootLayout: root.dataset.layoutPreset || '',
        rootAccent: getComputedStyle(root).getPropertyValue('--color-accent').trim(),
        persistenceError: document.querySelector('[data-testid="theme-persistence-error"]')?.textContent || '',
      };
    })()`,
    (value) =>
      value?.ready === true &&
      value?.skin === EXPECTED_THEME.skinId &&
      value?.density === EXPECTED_THEME.density &&
      value?.layout === EXPECTED_THEME.layoutPresetId &&
      value?.accent.toLowerCase() === EXPECTED_THEME.accentColor &&
      value?.summary === 'Control Tower · Dark · IDE Mode' &&
      value?.detail === `Accent override: ${EXPECTED_THEME.accentColor}.` &&
      value?.rootSkin === EXPECTED_THEME.skinId &&
      value?.rootDensity === EXPECTED_THEME.density &&
      value?.rootLayout === EXPECTED_THEME.layoutPresetId &&
      value?.rootAccent.toLowerCase() === EXPECTED_THEME.accentColor &&
      value?.persistenceError === '',
    BROWSER_TIMEOUT_MS,
  )
  const visualHealth = await assertThemeVisualHealth(browser.page)

  for (const [layoutPresetId, expectedVariables] of Object.entries(EXPECTED_LAYOUT_VARIABLES)) {
    const layoutState = await setThemeSelect(
      browser.page,
      'theme-layout-select',
      layoutPresetId,
      'layoutPreset',
    )
    assert(
      layoutState.contentMax === expectedVariables.contentMax &&
      layoutState.conversationMax === expectedVariables.conversationMax &&
      layoutState.composerMax === expectedVariables.composerMax,
      `Layout preset ${layoutPresetId} did not change global layout variables: ${JSON.stringify(layoutState)}`,
    )
  }

  for (const [density, expectedVariables] of Object.entries(EXPECTED_DENSITY_VARIABLES)) {
    const densityState = await setThemeSelect(
      browser.page,
      'theme-density-select',
      density,
      'themeDensity',
    )
    assert(
      densityState.panelGap === expectedVariables.panelGap &&
      densityState.panelPadding === expectedVariables.panelPadding &&
      densityState.messageGap === expectedVariables.messageGap,
      `Density ${density} did not change global spacing variables: ${JSON.stringify(densityState)}`,
    )
  }

  await setThemeSelect(
    browser.page,
    'theme-layout-select',
    EXPECTED_THEME.layoutPresetId,
    'layoutPreset',
  )
  await setThemeSelect(
    browser.page,
    'theme-density-select',
    EXPECTED_THEME.density,
    'themeDensity',
  )
  const mainHealth = await assertMainThemeHealth(browser.page, baseUrl)
  const lightHealth = await assertLightThemeHealth(browser.page, baseUrl)

  console.log(
    `Theme browser smoke passed: ${restored.skin}, ${restored.density}, ${restored.layout}, ${restored.accent}; ` +
    `${String(Object.keys(EXPECTED_LAYOUT_VARIABLES).length)} layouts, ${String(Object.keys(EXPECTED_DENSITY_VARIABLES).length)} densities, ` +
    `dark and ${lightHealth.settingsState.skin} surfaces, settings screenshot ${visualHealth.screenshot.width}x${visualHealth.screenshot.height}, ` +
    `centered home composer ${String(mainHealth.composer.width)}px.`,
  )
} finally {
  if (browser) await browser.close()
  await stopChild(server)
  await rm(settingsDir, { recursive: true, force: true })
}
