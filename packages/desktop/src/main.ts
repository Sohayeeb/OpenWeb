/**
 * The browser itself.
 *
 * A single BrowserWindow owns two things: the chrome (tabs, address bar,
 * launcher) rendered from `chrome/index.html`, and one WebContentsView per
 * tab. The content view always talks to a loopback gateway; the shell shows
 * the openweb:// translation, so the local URL never escapes.
 */

import { DESKTOP_HEADER } from '@openweb/gateway'
import {
  BaseWindow,
  Menu,
  WebContentsView,
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { displayForUrl, internalUrl, resolveAddressInput, HOME } from './address.js'
import { listLauncherSites } from './launcher.js'
import { readPublishedSites } from './published.js'
import { startStack, type Stack } from './services.js'

declare const __OPENWEB_CHANNEL__: string

const CHROME_HEIGHT = 96
const here = __dirname
const isDev = !app.isPackaged

interface Tab {
  id: number
  view: WebContentsView
  display: string
  title: string
  loading: boolean
  closed: boolean
}

interface TabState {
  id: number
  title: string
  display: string
  loading: boolean
}

interface BrowserState {
  tabs: TabState[]
  activeId: number | null
  address: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  status: string
  online: boolean
}

let win: BaseWindow | null = null
let shellView: WebContentsView | null = null
let launcherView: WebContentsView | null = null
let launcherOpen = false
let stack: Stack | null = null
let dataDir = ''
let logFile = ''
let tabs: Tab[] = []
let activeTabId: number | null = null
let nextTabId = 1
let statusText = 'starting your node…'
let shuttingDown = false
let installingUpdate = false

app.setName('OpenWeb')
if (process.platform === 'win32') app.setAppUserModelId('com.openweb.browser')

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const target = argv.find((argument) => /^openweb:\/\//i.test(argument))
    if (target) navigateActive(target)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (stack) navigateActive(url)
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => void fatal(error))
}

app.on('window-all-closed', () => app.quit())

app.on('before-quit', (event) => {
  if (shuttingDown || installingUpdate) return
  event.preventDefault()
  shuttingDown = true
  void shutdown().finally(() => app.exit(0))
})

async function bootstrap(): Promise<void> {
  // A test or smoke run can isolate itself from the real profile.
  dataDir = process.env['OPENWEB_DATA_DIR']
    ? resolve(process.env['OPENWEB_DATA_DIR'])
    : join(app.getPath('appData'), 'OpenWeb')
  logFile = join(dataDir, 'openweb.log')
  mkdirSync(dataDir, { recursive: true })
  trimLog()

  Menu.setApplicationMenu(null)
  installDesktopHeader()

  if (app.isPackaged) app.setAsDefaultProtocolClient('openweb')

  await createWindow()
  sendStatus('starting your node…')

  try {
    stack = await startStack({
      dir: dataDir,
      siteFolder: siteFolder(),
      chooseFolder: () => pickFolder(),
      onStatus: (message) => sendStatus(message),
      onError: (error) => log('stack:', messageOf(error)),
    })

    sendStatus('ready')
    createTab(initialTarget() ?? HOME, true)
    setupUpdates()
    log(`ready: ${stack.address} on gateway :${stack.gatewayPort}`)

    if (process.env.OPENWEB_CAPTURE) {
      const file = process.env.OPENWEB_CAPTURE
      setTimeout(() => void captureAndQuit(file), 8_000)
    } else if (process.env.OPENWEB_SMOKE) {
      setTimeout(() => void runSmoke(), 1_000)
    }
  } catch (error) {
    await fatal(error)
  }
}

/** Development aid: drive the real chrome and content views, then exit. */
async function runSmoke(): Promise<void> {
  const report: Record<string, unknown> = {}
  const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

  try {
    report.launcher = listLauncherSites(dataDir).map((site) => ({
      title: site.title,
      source: site.source,
    }))

    await shellView?.webContents.executeJavaScript(
      `(() => {
        const input = document.getElementById('address');
        input.focus();
        input.value = 'coffee';
        document.getElementById('addressForm').requestSubmit();
        return true;
      })()`,
    )
    await wait(2_500)
    report.search = await inspectTab()

    if (stack) {
      navigateActive(`openweb://${stack.address}/`)
      await wait(2_500)
      report.site = await inspectTab()
    }

    // Publish through the same HTTP forms a person would submit, read the
    // result back out of the gateway, then clean up everything it created.
    if (stack) {
      const folder = join(app.getPath('temp'), `openweb-smoke-${Date.now()}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(
        join(folder, 'index.html'),
        '<!doctype html><meta charset="utf-8"><title>Smoke test</title><p>smoke-test-page</p>',
      )

      const publish = await smokePublish(folder)
      report.publish = publish
      const address = publish.address
      if (typeof address === 'string' && address !== '') {
        navigateActive(`openweb://${address}/`)
        await wait(2_000)
        report.publishedSite = await inspectTab()
        report.publishCleanup = await smokeForget(address)
      }
      rmSync(folder, { recursive: true, force: true })
    }

    await shellView?.webContents.executeJavaScript(
      `document.getElementById('apps').click(); true`,
    )
    await wait(900)
    report.launcherPanel = await launcherView?.webContents
      .executeJavaScript(
        `({
          items: document.querySelectorAll('#appsList .app').length,
          sections: [...document.querySelectorAll('#appsList .section')].map((section) => section.textContent),
          quick: document.querySelectorAll('#quick button').length
        })`,
      )
      .catch(() => null)
    report.launcherOpen = launcherOpen
    closeLauncher()
    await wait(300)
    report.launcherClosed = !launcherOpen

    createTab(HOME, true)
    await wait(600)
    report.tabsAfterNew = currentState().tabs.length
    if (activeTabId !== null) closeTab(activeTabId)
    await wait(600)
    report.tabsAfterClose = currentState().tabs.length
    report.display = currentState().address
  } catch (error) {
    report.error = messageOf(error)
  }

  log('smoke:', JSON.stringify(report, null, 2))
  app.quit()
}

/** Publish a folder through the browser form and verify the gateway serves it. */
async function smokePublish(folder: string): Promise<Record<string, unknown>> {
  if (!stack) return { error: 'the stack did not start' }
  const base = stack.gatewayUrl.replace(/\/+$/, '')

  const posted = await fetch(`${base}/publish`, {
    method: 'POST',
    body: new URLSearchParams({ action: 'folder', folder, title: 'Smoke test' }),
    redirect: 'manual',
  })
  const location = posted.headers.get('location') ?? ''
  const address = new URL(location, base).searchParams.get('published') ?? ''
  if (address === '') return { error: 'no address in the redirect', status: posted.status, location }

  const page = await fetch(`${base}/${address}/`)
  const text = await page.text()
  const known = listLauncherSites(dataDir).find((site) => site.address === address)

  return {
    status: posted.status,
    address,
    served: page.status === 200 && text.includes('smoke-test-page'),
    launcher: known?.title ?? null,
  }
}

/** Take the smoke site offline and delete the state it created. */
async function smokeForget(address: string): Promise<Record<string, unknown>> {
  if (!stack) return { error: 'the stack did not start' }
  const base = stack.gatewayUrl.replace(/\/+$/, '')
  const record = readPublishedSites(dataDir).find((site) => site.address === address)

  const posted = await fetch(`${base}/publish`, {
    method: 'POST',
    body: new URLSearchParams({ action: 'forget', address }),
    redirect: 'manual',
  })

  if (record) rmSync(record.stateDir, { recursive: true, force: true })

  return {
    status: posted.status,
    forgotten: !readPublishedSites(dataDir).some((site) => site.address === address),
  }
}

async function inspectTab(): Promise<Record<string, unknown> | null> {
  const tab = activeTab()
  if (!tab) return null
  let text = ''
  try {
    text = await tab.view.webContents.executeJavaScript(
      '(document.body && document.body.innerText || "").slice(0, 220)',
    )
  } catch {
    // A page may be mid-navigation.
  }
  return {
    display: tab.display,
    title: tab.title,
    text,
    chrome: await tab.view.webContents
      .executeJavaScript('Boolean(document.querySelector("[data-openweb-chrome]"))')
      .catch(() => null),
  }
}

/** Development aid: render the window to PNGs and exit. */
async function captureAndQuit(file: string): Promise<void> {
  try {
    if (!win) return

    openLauncher()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 900))

    try {
      if (launcherView) {
        const sheet = await launcherView.webContents.capturePage()
        writeFileSync(file.replace(/\.png$/i, '-launcher.png'), sheet.toPNG())
      }
    } catch (error) {
      log('launcher capture:', messageOf(error))
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1280, height: 840 },
      })
      const source = sources.find((entry) => entry.name.includes('OpenWeb'))
      if (source) {
        writeFileSync(file.replace(/\.png$/i, '-desktop.png'), source.thumbnail.toPNG())
      } else {
        log('desktop capture: no OpenWeb window in ' + sources.map((entry) => entry.name).join(', '))
      }
    } catch (error) {
      log('desktop capture:', messageOf(error))
    }

    if (shellView) {
      try {
        const image = await shellView.webContents.capturePage()
        writeFileSync(file, image.toPNG())
      } catch (error) {
        log('shell capture:', messageOf(error))
      }

      try {
        const shellInfo = await shellView.webContents.executeJavaScript(
          '({ status: document.getElementById("status")?.textContent, address: document.getElementById("address")?.value, tabs: document.querySelectorAll(".tab").length, body: document.body.className })',
        )
        log('shell:', JSON.stringify(shellInfo))
      } catch (error) {
        log('shell inspect:', messageOf(error))
      }
    }

    const tab = activeTab()
    if (tab) {
      try {
        const view = await tab.view.webContents.capturePage()
        writeFileSync(file.replace(/\.png$/i, '-view.png'), view.toPNG())
      } catch (error) {
        log('view capture:', messageOf(error))
      }

      try {
        const info = await tab.view.webContents.executeJavaScript(
          '({ title: document.title, text: (document.body && document.body.innerText || "").slice(0, 240), chrome: Boolean(document.querySelector("[data-openweb-chrome]")), url: location.href })',
        )
        log('view:', JSON.stringify(info))
      } catch (error) {
        log('view inspect:', messageOf(error))
      }
    }

    log(`capture: ${file}`)
  } catch (error) {
    log('capture:', messageOf(error))
  }
  app.quit()
}

function siteFolder(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'app')
  // __dirname is packages/desktop/dist; the repo's app/ is three levels up.
  return join(here, '..', '..', '..', 'app')
}

/**
 * The native folder picker behind "choose a folder…" on the publish page.
 * Returning null means the user cancelled, and the gateway reports that
 * without publishing anything.
 */
async function pickFolder(): Promise<string | null> {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to publish',
    buttonLabel: 'Publish this folder',
    properties: ['openDirectory'],
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** A deep link passed by Windows: OpenWeb-1.0.0.exe openweb://ow1… */
function initialTarget(): string | null {
  return process.argv.find((argument) => /^openweb:\/\//i.test(argument)) ?? null
}

/* -------------------------------------------------------------------------- */
/* Launcher sheet                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The launcher is a sibling view stacked above the page, not part of the chrome
 * view. Chrome and page are separate native rectangles, so a dropdown inside the
 * 96px chrome view would be painted underneath the page. This view covers the
 * page area, dims it, and takes the clicks that dismiss it.
 */
function ensureLauncherView(): WebContentsView {
  if (launcherView) return launcherView

  const view = new WebContentsView({
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  view.setBackgroundColor('#08080a')
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  attachShortcuts(view.webContents)
  void view.webContents.loadFile(join(here, 'chrome', 'launcher.html'))

  launcherView = view
  return view
}

function openLauncher(): void {
  if (!win || launcherOpen) return
  const view = ensureLauncherView()
  launcherOpen = true
  layout()

  win.contentView.addChildView(view)
  view.webContents.send('launcher:open')
  view.webContents.focus()
}

function closeLauncher(): void {
  if (!win || !launcherOpen) return
  launcherOpen = false

  if (launcherView) {
    try {
      win.contentView.removeChildView(launcherView)
    } catch {
      // Already detached.
    }
  }

  activeTab()?.view.webContents.focus()
}

function toggleLauncher(): void {
  if (launcherOpen) closeLauncher()
  else openLauncher()
}


async function createWindow(): Promise<void> {
  const icon = join(here, '..', 'build', 'icon.png')
  win = new BaseWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'OpenWeb',
    ...(existsSync(icon) ? { icon } : {}),
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#0a0a0b',
            symbolColor: '#d8d5cc',
            height: 40,
          },
        }
      : {}),
  })

  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: true,
    },
  })
  chrome.setBackgroundColor('#0a0a0b')
  shellView = chrome
  win.contentView.addChildView(chrome)

  win.setMenuBarVisibility(false)
  win.on('resize', layout)
  win.on('maximize', layout)
  win.on('unmaximize', layout)
  win.on('enter-full-screen', layout)
  win.on('leave-full-screen', layout)

  chrome.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  attachShortcuts(chrome.webContents)

  win.on('closed', () => {
    tabs = []
    activeTabId = null
    launcherOpen = false
    launcherView = null
    shellView = null
    win = null
  })

  const loaded = new Promise<void>((resolvePromise) => {
    chrome.webContents.once('did-finish-load', () => resolvePromise())
  })
  await chrome.webContents.loadFile(join(here, 'chrome', 'index.html'))
  await loaded
  layout()
  win.show()
}

function installDesktopHeader(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    if (stack) {
      try {
        const gateway = new URL(stack.gatewayUrl)
        if (new URL(details.url).origin === gateway.origin) {
          headers[DESKTOP_HEADER] = '1'
        }
      } catch {
        // Ignore malformed URLs; Chromium will reject them anyway.
      }
    }
    callback({ requestHeaders: headers })
  })
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/** Page JavaScript is off except for the dev helpers that inspect the view. */
function pageScriptsEnabled(): boolean {
  return process.env['OPENWEB_PAGE_JS'] === '1' || Boolean(process.env['OPENWEB_SMOKE'] || process.env['OPENWEB_CAPTURE'])
}

function createTab(input: string, activate: boolean): Tab {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      backgroundThrottling: false,
      // Published pages are static by design. Keeping JavaScript off means a
      // site cannot script the gateway's publish forms. The smoke and capture
      // helpers need to evaluate strings in the view, so they opt back in.
      javascript: pageScriptsEnabled(),
    },
  })
  view.setBackgroundColor('#0a0a0b')

  const tab: Tab = {
    id: nextTabId++,
    view,
    display: HOME,
    title: 'New tab',
    loading: true,
    closed: false,
  }
  tabs.push(tab)
  wireTab(tab)

  if (activate) activateTab(tab.id)
  else broadcast()

  navigateTab(tab, input)
  return tab
}

function wireTab(tab: Tab): void {
  const contents = tab.view.webContents
  attachShortcuts(contents)

  contents.setWindowOpenHandler(({ url }) => {
    openFromContent(url)
    return { action: 'deny' }
  })

  contents.on('did-start-loading', () => {
    if (tab.closed) return
    tab.loading = true
    broadcast()
  })

  contents.on('did-stop-loading', () => {
    if (tab.closed) return
    tab.loading = false
    broadcast()
  })

  contents.on('did-navigate', (_event, url) => {
    if (tab.closed) return
    applyUrl(tab, url)
  })

  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (tab.closed || !isMainFrame) return
    applyUrl(tab, url)
  })

  contents.on('page-title-updated', (_event, title) => {
    if (tab.closed) return
    tab.title = title.trim() === '' ? 'New tab' : title
    broadcast()
  })

  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (tab.closed || !isMainFrame || code === -3) return
    log(`load failed (${code} ${description}): ${redact(url)}`)
    if (code === -105 || code === -102) {
      // The gateway went away. Leave a readable page instead of a blank view.
      tab.title = 'Offline'
      tab.loading = false
      broadcast()
    }
  })

  contents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: ${details.reason}`)
    if (tab.closed) return
    tab.title = 'Page crashed'
    tab.loading = false
    broadcast()
  })
}

function navigateTab(tab: Tab, input: string): void {
  if (tab.closed) return
  closeLauncher()
  const resolved = resolveAddressInput(input)
  tab.display = resolved.display
  tab.loading = true

  if (resolved.kind === 'external') {
    void tab.view.webContents.loadURL(resolved.display)
  } else if (stack) {
    void tab.view.webContents.loadURL(internalUrl(stack.gatewayUrl, resolved.path))
  }

  broadcast()
}

function navigateActive(input: string): void {
  const tab = activeTab()
  if (tab) navigateTab(tab, input)
  else createTab(input, true)
}

function applyUrl(tab: Tab, url: string): void {
  if (!stack) return
  const display = displayForUrl(url, gatewayOrigin())
  if (display) {
    tab.display = display
    broadcast()
  }
}

function activateTab(id: number): void {
  if (!win || activeTabId === id) return
  closeLauncher()
  const previous = activeTab()
  if (previous) win.contentView.removeChildView(previous.view)

  activeTabId = id
  const next = activeTab()
  if (next) {
    win.contentView.addChildView(next.view)
    layout()
    next.view.webContents.focus()
  }
  broadcast()
}

function closeTab(id: number): void {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return

  const [tab] = tabs.splice(index, 1)
  if (!tab) return
  tab.closed = true

  if (win && activeTabId === id) win.contentView.removeChildView(tab.view)
  try {
    tab.view.webContents.close()
  } catch {
    // Already gone.
  }

  if (activeTabId === id) {
    activeTabId = null
    const next = tabs[Math.min(index, tabs.length - 1)]
    if (next) activateTab(next.id)
    else createTab(HOME, true)
  }

  broadcast()
}

function activeTab(): Tab | null {
  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

function layout(): void {
  if (!win) return
  const [width, height] = win.getContentSize()
  const size = { width: Math.max(0, width), height: Math.max(0, height) }

  shellView?.setBounds({ x: 0, y: 0, ...size })

  const tab = activeTab()
  if (tab) {
    tab.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: size.width,
      height: Math.max(0, size.height - CHROME_HEIGHT),
    })
  }

  if (launcherView && launcherOpen) {
    launcherView.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: size.width,
      height: Math.max(0, size.height - CHROME_HEIGHT),
    })
  }
}

function openFromContent(url: string): void {
  if (!stack) return
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (url.startsWith(gatewayOrigin())) {
      const display = displayForUrl(url, gatewayOrigin())
      createTab(display ?? HOME, true)
    } else {
      createTab(url, true)
    }
    return
  }

  if (/^openweb:\/\//i.test(url)) {
    createTab(url, true)
    return
  }

  if (url.startsWith('about:blank')) {
    createTab(HOME, true)
    return
  }

  void shell.openExternal(url).catch(() => undefined)
}

/* -------------------------------------------------------------------------- */
/* Chrome state and commands                                                  */
/* -------------------------------------------------------------------------- */

function broadcast(): void {
  if (!win || win.isDestroyed() || !shellView) return
  shellView.webContents.send('browser:state', currentState())

  const tab = activeTab()
  const title = tab && tab.title && tab.title !== 'New tab' ? `${tab.title} — OpenWeb` : 'OpenWeb'
  if (win.getTitle() !== title) win.setTitle(title)
}

function currentState(): BrowserState {
  const tab = activeTab()
  return {
    tabs: tabs.map((entry) => ({
      id: entry.id,
      title: entry.title,
      display: entry.display,
      loading: entry.loading,
    })),
    activeId: activeTabId,
    address: tab?.display ?? HOME,
    title: tab?.title ?? 'New tab',
    loading: tab?.loading ?? false,
    canGoBack: tab ? canGo(tab, 'back') : false,
    canGoForward: tab ? canGo(tab, 'forward') : false,
    status: statusText,
    online: stack !== null,
  }
}

function canGo(tab: Tab, direction: 'back' | 'forward'): boolean {
  try {
    const history = tab.view.webContents.navigationHistory
    return direction === 'back' ? history.canGoBack() : history.canGoForward()
  } catch {
    return false
  }
}

function goBack(): void {
  const tab = activeTab()
  if (tab && canGo(tab, 'back')) tab.view.webContents.navigationHistory.goBack()
}

function goForward(): void {
  const tab = activeTab()
  if (tab && canGo(tab, 'forward')) tab.view.webContents.navigationHistory.goForward()
}

function reload(ignoreCache = false): void {
  const contents = activeTab()?.view.webContents
  if (!contents) return
  if (ignoreCache) contents.reloadIgnoringCache()
  else contents.reload()
}

function stop(): void {
  activeTab()?.view.webContents.stop()
}

function focusAddress(): void {
  closeLauncher()
  shellView?.webContents.send('browser:focus-address')
}

function sendStatus(message: string): void {
  statusText = message
  broadcast()
}

function gatewayOrigin(): string {
  if (!stack) return ''
  try {
    return new URL(stack.gatewayUrl).origin
  } catch {
    return ''
  }
}

function attachShortcuts(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const control = input.control || input.meta

    if (control && key === 'l') {
      event.preventDefault()
      focusAddress()
    } else if ((control && key === 'r') || key === 'f5') {
      event.preventDefault()
      reload(input.shift)
    } else if (control && key === 't') {
      event.preventDefault()
      createTab(HOME, true)
    } else if (control && key === 'w') {
      event.preventDefault()
      if (activeTabId !== null) closeTab(activeTabId)
    } else if (input.alt && key === 'arrowleft') {
      event.preventDefault()
      goBack()
    } else if (input.alt && key === 'arrowright') {
      event.preventDefault()
      goForward()
    } else if (control && key === 'tab') {
      event.preventDefault()
      cycleTab(input.shift ? -1 : 1)
    } else if (key === 'f12' || (control && input.shift && key === 'i')) {
      event.preventDefault()
      activeTab()?.view.webContents.toggleDevTools()
    }
  })
}

function cycleTab(step: number): void {
  if (tabs.length < 2 || activeTabId === null) return
  const index = tabs.findIndex((tab) => tab.id === activeTabId)
  const next = (index + step + tabs.length) % tabs.length
  const tab = tabs[next]
  if (tab) activateTab(tab.id)
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                        */
/* -------------------------------------------------------------------------- */

function fromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    win !== null &&
    !win.isDestroyed() &&
    shellView !== null &&
    event.sender === shellView.webContents
  )
}

/** Messages may come from the chrome or from the launcher sheet above the page. */
function fromChrome(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (fromShell(event)) return true
  return (
    win !== null &&
    !win.isDestroyed() &&
    launcherView !== null &&
    event.sender === launcherView.webContents
  )
}

ipcMain.handle('browser:state', (event) => (fromShell(event) ? currentState() : null))

ipcMain.handle('browser:launcher', (event) => {
  if (!fromChrome(event) || dataDir === '') return []
  try {
    return listLauncherSites(dataDir)
  } catch (error) {
    log('launcher:', messageOf(error))
    return []
  }
})

ipcMain.on('browser:launcher', (event, action: unknown) => {
  if (!fromChrome(event) || typeof action !== 'string') return
  if (action === 'open') openLauncher()
  else if (action === 'close') closeLauncher()
  else if (action === 'toggle') toggleLauncher()
})

ipcMain.on('browser:navigate', (event, input: unknown) => {
  if (!fromChrome(event) || typeof input !== 'string') return
  navigateActive(input)
})

ipcMain.on('browser:action', (event, action: unknown, argument: unknown) => {
  if (!fromChrome(event) || typeof action !== 'string') return

  switch (action) {
    case 'back':
      goBack()
      break
    case 'forward':
      goForward()
      break
    case 'reload':
      reload()
      break
    case 'stop':
      stop()
      break
    case 'home':
      navigateActive(HOME)
      break
    case 'new-tab':
      createTab(HOME, true)
      break
    case 'close-tab':
      if (typeof argument === 'number') closeTab(argument)
      break
    case 'select-tab':
      if (typeof argument === 'number') activateTab(argument)
      break
    default:
      break
  }
})

ipcMain.on('browser:ready', (event) => {
  if (!fromShell(event)) return
  broadcast()
})

/* -------------------------------------------------------------------------- */
/* Updates, logging, shutdown                                                 */
/* -------------------------------------------------------------------------- */

function setupUpdates(): void {
  if (!app.isPackaged || __OPENWEB_CHANNEL__ === 'dev' || __OPENWEB_CHANNEL__ === 'test') return

  const channel = __OPENWEB_CHANNEL__
  autoUpdater.logger = {
    info: (message?: unknown) => log('update:', messageOf(message)),
    warn: (message?: unknown) => log('update:', messageOf(message)),
    error: (message?: unknown) => log('update:', messageOf(message)),
    debug: () => undefined,
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  if (channel !== 'latest') {
    autoUpdater.channel = channel
    autoUpdater.allowPrerelease = true
  }

  autoUpdater.on('error', (error) => log('update:', messageOf(error)))
  autoUpdater.on('update-downloaded', (info) => {
    void (async () => {
      if (!win) return
      const answer = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'OpenWeb update',
        message: `OpenWeb ${info.version} is ready.`,
        detail: 'Restart to finish installing it. Your sites and index stay in place.',
      })
      if (answer.response === 0) {
        installingUpdate = true
        autoUpdater.quitAndInstall()
      }
    })()
  })

  const check = (): void => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      log('update check:', messageOf(error))
    })
  }
  setTimeout(check, 15_000).unref()
  setInterval(check, 6 * 60 * 60 * 1000).unref()
}

function trimLog(): void {
  try {
    if (statSync(logFile).size > 2 * 1024 * 1024) appendFileSync(logFile, '\n--- log trimmed ---\n')
  } catch {
    // The log does not exist yet.
  }
}

function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map(messageOf).join(' ')}\n`
  try {
    if (logFile !== '') appendFileSync(logFile, line)
  } catch {
    // Logging must never take the browser down.
  }
  if (isDev) process.stdout.write(line)
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function redact(url: string): string {
  const origin = gatewayOrigin()
  return origin && url.startsWith(origin) ? url.slice(origin.length) : url
}

async function shutdown(): Promise<void> {
  launcherOpen = false
  if (launcherView) {
    try {
      launcherView.webContents.close()
    } catch {
      // Already closed.
    }
    launcherView = null
  }

  for (const tab of tabs) {
    tab.closed = true
    try {
      tab.view.webContents.close()
    } catch {
      // Already closed.
    }
  }
  tabs = []
  activeTabId = null

  const running = stack
  stack = null
  if (running) await running.close().catch(() => undefined)
}

async function fatal(error: unknown): Promise<void> {
  log('fatal:', messageOf(error))
  const detail = messageOf(error)
  if (win && !win.isDestroyed()) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'OpenWeb could not start',
      message: 'The local node or gateway did not start.',
      detail,
      buttons: ['Close'],
    })
  } else {
    dialog.showErrorBox('OpenWeb could not start', detail)
  }
  await shutdown().catch(() => undefined)
  app.exit(1)
}
