/**
 * Turning the gateway into an installed browser window.
 *
 * Two small pieces, no Electron and no bundled Chromium:
 *
 *   - `launchAppWindow` opens Chrome/Edge in `--app=` mode, so the gateway looks
 *     like an application rather than a tab.
 *   - `writeLaunchers` writes start scripts next to the state directory, and
 *     optionally a Windows startup entry, so the node + gateway + crawler stack
 *     comes back after a reboot.
 *
 * If no Chromium-family browser is installed the command still succeeds: it
 * prints the gateway URL and the user can open it in whatever they have.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WINDOWS = process.platform === 'win32'

const WINDOWS_BROWSERS = [
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Google',
    'Chrome',
    'Application',
    'chrome.exe',
  ),
  join(
    process.env['LOCALAPPDATA'] ?? '',
    'Google',
    'Chrome',
    'Application',
    'chrome.exe',
  ),
  join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft',
    'Edge',
    'Application',
    'msedge.exe',
  ),
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

const UNIX_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
]

export function findBrowser(): string | null {
  for (const candidate of IS_WINDOWS ? WINDOWS_BROWSERS : UNIX_BROWSERS) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/** Open a URL as an app window. Returns false when no browser was found. */
export function launchAppWindow(url: string): boolean {
  const browser = findBrowser()
  if (!browser) return false

  const child = spawn(
    browser,
    [
      `--app=${url}`,
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  return true
}

export interface LauncherPaths {
  /** "Open OpenWeb" — runs the whole stack and opens the window. */
  browser: string
  /** "Start OpenWeb in the background" — no window. */
  start: string
  /** Windows startup entry, when requested. */
  autostart: string | null
}

export interface LauncherOptions {
  /** State directory, e.g. .openweb */
  dir: string
  /** Folder to publish on every start. */
  folder: string
  /** Add a Windows startup entry. */
  autostart?: boolean
}

/**
 * Write portable start scripts. The absolute paths are resolved now, so the
 * launcher keeps working if the user moves their shell but not the install.
 */
export function writeLaunchers(options: LauncherOptions): LauncherPaths {
  const distDir = dirname(fileURLToPath(import.meta.url))
  const cli = join(distDir, 'index.js')
  const binDir = join(resolve(options.dir), 'bin')
  mkdirSync(binDir, { recursive: true })

  const folder = resolve(options.folder)
  const dir = resolve(options.dir)

  if (IS_WINDOWS) {
    const browser = join(binDir, 'openweb-browser.cmd')
    const start = join(binDir, 'openweb-start.cmd')
    writeFileSync(browser, cmdScript(process.execPath, cli, ['browser', folder, '--dir', dir]))
    writeFileSync(start, cmdScript(process.execPath, cli, ['start', folder, '--dir', dir]))

    let autostart: string | null = null
    if (options.autostart) {
      const startupDir = join(
        process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
      )
      mkdirSync(startupDir, { recursive: true })
      autostart = join(startupDir, 'OpenWeb.cmd')
      writeFileSync(autostart, cmdScript(process.execPath, cli, ['browser', folder, '--dir', dir]))
    }

    return { browser, start, autostart }
  }

  const browser = join(binDir, 'openweb-browser')
  const start = join(binDir, 'openweb-start')
  writeFileSync(browser, shellScript(process.execPath, cli, ['browser', folder, '--dir', dir]))
  writeFileSync(start, shellScript(process.execPath, cli, ['start', folder, '--dir', dir]))
  chmodSync(browser, 0o755)
  chmodSync(start, 0o755)

  return { browser, start, autostart: null }
}

function cmdScript(node: string, cli: string, args: string[]): string {
  return `@echo off\r\n"${node}" "${cli}" ${args.map(quoteWindows).join(' ')}\r\n`
}

function shellScript(node: string, cli: string, args: string[]): string {
  const quoted = [node, cli, ...args].map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(' ')
  return `#!/bin/sh\nexec ${quoted}\n`
}

function quoteWindows(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
