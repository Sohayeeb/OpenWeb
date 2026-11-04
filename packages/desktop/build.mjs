/**
 * Build the desktop shell.
 *
 *   node build.mjs           type-checked bundle in dist/ (development)
 *   node build.mjs --dir     unpacked Windows app in release/win-unpacked
 *   node build.mjs --package NSIS installer in release/
 *
 * Everything written by this script is generated: dist/, build/icon.ico,
 * build/icon.png. Source lives in src/.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const dist = join(here, 'dist')
const buildDir = join(here, 'build')

/** Native modules stay outside the bundle so Electron can load their N-API binaries. */
const EXTERNAL = [
  'electron',
  'electron-updater',
  'sodium-native',
  'udx-native',
  'fs-native-extensions',
  'quickbit-native',
  'rabin-native',
  'rocksdb-native',
  'simdle-native',
]

function detectChannel() {
  const explicit = process.env.OPENWEB_CHANNEL?.trim()
  if (explicit) return normalizeChannel(explicit)

  const fromCi = process.env.GITHUB_REF_NAME?.trim()
  if (fromCi) return normalizeChannel(fromCi)

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return normalizeChannel(branch)
  } catch {
    return 'dev'
  }
}

function normalizeChannel(value) {
  switch (value.toLowerCase()) {
    case 'main':
    case 'master':
    case 'stable':
    case 'latest':
      return 'latest'
    case 'beta':
      return 'beta'
    case 'nightly':
      return 'nightly'
    case 'test':
      return 'test'
    default:
      return 'dev'
  }
}

function makeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length

  images.forEach(({ size, data }, index) => {
    const at = index * 16
    // 0 means 256 in the ICO directory.
    entries.writeUInt8(size >= 256 ? 0 : size, at)
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1)
    entries.writeUInt8(0, at + 2)
    entries.writeUInt8(0, at + 3)
    entries.writeUInt16LE(1, at + 4)
    entries.writeUInt16LE(32, at + 6)
    entries.writeUInt32LE(data.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.data)])
}

async function icons() {
  const pwa = join(repo, 'packages', 'gateway', 'dist', 'pwa.js')
  if (!existsSync(pwa)) {
    throw new Error('gateway build missing; run `npm run build` at the repo root first')
  }

  const { iconPng } = await import(pathToFileURL(pwa).href)
  mkdirSync(buildDir, { recursive: true })

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map((size) => ({ size, data: iconPng(size) }))
  writeFileSync(join(buildDir, 'icon.ico'), makeIco(images))
  writeFileSync(join(buildDir, 'icon.png'), iconPng(512))
  console.log(`icon: ${sizes.length} sizes -> build/icon.ico`)
}

async function bundle(channel) {
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })

  await esbuild({
    entryPoints: [join(here, 'src', 'main.ts')],
    outfile: join(dist, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: EXTERNAL,
    define: { __OPENWEB_CHANNEL__: JSON.stringify(channel) },
    logLevel: 'warning',
    sourcemap: false,
  })

  await esbuild({
    entryPoints: [join(here, 'src', 'preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
    sourcemap: false,
  })

  cpSync(join(here, 'src', 'chrome'), join(dist, 'chrome'), { recursive: true })
  console.log(`bundle: dist/main.cjs, dist/preload.cjs, dist/chrome (channel ${channel})`)
}

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/**
 * Native packages ship a prebuilt binary for every platform. Only one of them
 * can run in this build, so drop the rest before the installer is compressed.
 */
function prunePrebuilds(context) {
  const platform = context.electronPlatformName
  const arch = ARCH_NAMES[context.arch] ?? 'x64'
  const root = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules')
  if (!existsSync(root)) return

  let removed = 0
  for (const name of readdirSync(root)) {
    const prebuilds = join(root, name, 'prebuilds')
    if (!existsSync(prebuilds)) continue
    for (const entry of readdirSync(prebuilds)) {
      const keep =
        entry === `${platform}-${arch}` ||
        entry === `${platform}-${arch}-gnu` ||
        entry === `${platform}-${arch}-musl`
      if (keep) continue
      rmSync(join(prebuilds, entry), { recursive: true, force: true })
      removed += 1
    }
  }

  if (removed > 0) console.log(`pruned ${removed} foreign prebuild(s), kept ${platform}-${arch}`)
}

function builderConfig(channel, dirOnly) {
  const appDir = join(repo, 'app')
  const publishChannel = channel === 'dev' || channel === 'test' ? 'latest' : channel

  return {
    appId: 'com.openweb.browser',
    productName: 'OpenWeb',
    copyright: `Copyright © ${new Date().getFullYear()} OpenWeb`,
    directories: {
      output: join(repo, 'release'),
      buildResources: 'build',
    },
    files: ['dist/**/*', 'package.json', '!**/*.map'],
    extraResources: [{ from: appDir, to: 'app' }],
    asar: true,
    asarUnpack: [
      '**/*.node',
      'node_modules/{sodium-native,udx-native,fs-native-extensions,quickbit-native,rabin-native,rocksdb-native,simdle-native}/**/*',
    ],
    protocols: [{ name: 'OpenWeb', schemes: ['openweb'] }],
    npmRebuild: false,
    generateUpdatesFilesForAllChannels: false,
    afterPack: (context) => prunePrebuilds(context),
    publish: [
      {
        provider: 'github',
        owner: 'Sohayeeb',
        repo: 'OpenWeb',
        channel: publishChannel,
        releaseType: publishChannel === 'latest' ? 'release' : 'prerelease',
      },
    ],
    win: {
      ...(dirOnly ? {} : { target: [{ target: 'nsis', arch: ['x64'] }] }),
      icon: join(buildDir, 'icon.ico'),
      artifactName: 'OpenWeb-${version}-${arch}.${ext}',
      signAndEditExecutable: true,
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'OpenWeb',
      uninstallDisplayName: 'OpenWeb',
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
    },
  }
}

async function packageApp(channel, dirOnly) {
  const { default: electronBuilder } = await import('electron-builder')
  const { Platform, Arch } = electronBuilder

  const config = builderConfig(channel, dirOnly)

  // electron-builder only compiles and writes metadata (app-update.yml,
  // latest.yml); the release itself is created by `gh release create` in CI.
  // Its own GitHub publisher races the release creation and drops the .yml.
  const publish = 'never'

  console.log(`packaging ${dirOnly ? 'unpacked app' : 'NSIS installer'} for ${channel}`)

  const options = dirOnly
    ? { dir: true, publish, config, projectDir: here }
    : {
        targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        publish,
        config,
        projectDir: here,
      }

  await electronBuilder.build(options)

  console.log(`done: ${join(repo, 'release')}`)
}

async function main() {
  const channel = detectChannel()
  await bundle(channel)
  await icons()

  if (process.argv.includes('--dir')) await packageApp(channel, true)
  else if (process.argv.includes('--package')) await packageApp(channel, false)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
