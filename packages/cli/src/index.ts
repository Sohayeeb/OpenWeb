#!/usr/bin/env node
/**
 * openweb — the only interface most people will ever touch.
 *
 *   openweb start [folder]        serve, bridge, crawl, and index in one process
 *   openweb browser [folder]      the same, opened as an installed app window
 *   openweb init                  create a site and print its address
 *   openweb serve <folder>        publish a folder from this machine
 *   openweb gateway               run the local gateway on :8080
 *   openweb open <address>        start a gateway and print the URL
 *   openweb crawl <address...>    crawl sites into a local search index
 *   openweb search <words>        query that index
 *   openweb new <folder>          generate a static site with the builder
 *   openweb pin <address>         keep a copy of somebody's site online
 *   openweb index <subcommand>    publish, fetch, query, or import an index
 *   openweb directory <subcmd>    signed lists: init, add, verify, publish
 *   openweb install               write launchers and an optional startup entry
 *   openweb bench                 measure the engine on synthetic data
 */

import {
  addDirectoryEntry,
  createSignedDirectory,
  ensureIdentity,
  identityAddress,
  isAddress,
  loadDirectory,
  mergeDirectoryEntries,
  removeDirectoryEntry,
  saveDirectory,
  signDirectory,
  verifyDirectory,
  type DirectoryDocument,
  type DirectorySite,
  type Signed,
} from '@openweb/core'
import { DEFAULT_GATEWAY_PORT, startGateway } from '@openweb/gateway'
import {
  SqliteIndex,
  crawl,
  indexFileFor,
  sqliteIndexExists,
  type Document,
} from '@openweb/index'
import {
  DEFAULT_DIR,
  DEFAULT_PORT,
  SharedIndexClient,
  fetchDirectory,
  initNode,
  publishDirectory,
  publishIndex,
  readPins,
  removePin,
  startNode,
  startPin,
} from '@openweb/node'
import { defaultSpec, writeSite, type SiteSpec } from '@openweb/builder'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchAppWindow, writeLaunchers } from './browser.js'

interface Args {
  positionals: string[]
  port?: number
  gatewayPort?: number
  dir?: string
  timeout?: number
  gateway?: string
  max?: number
  concurrency?: number
  queries?: number
  docs?: number
  json: boolean
  fresh: boolean
  noCrawl: boolean
  window: boolean
  autostart: boolean
  name?: string
  title?: string
  tagline?: string
  description?: string
  author?: string
  theme?: string
  note?: string
  tags: string[]
}

function parse(argv: string[]): Args {
  const args: Args = {
    positionals: [],
    json: false,
    fresh: false,
    noCrawl: false,
    window: false,
    autostart: false,
    tags: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--port':
        args.port = number(argv[++i], '--port')
        break
      case '--gateway-port':
        args.gatewayPort = number(argv[++i], '--gateway-port')
        break
      case '--dir':
        args.dir = argv[++i]
        break
      case '--timeout':
        args.timeout = number(argv[++i], '--timeout')
        break
      case '--gateway':
        args.gateway = argv[++i]
        break
      case '--max':
        args.max = number(argv[++i], '--max')
        break
      case '--concurrency':
        args.concurrency = number(argv[++i], '--concurrency')
        break
      case '--queries':
        args.queries = number(argv[++i], '--queries')
        break
      case '--docs':
        args.docs = number(argv[++i], '--docs')
        break
      case '--name':
        args.name = argv[++i]
        break
      case '--title':
        args.title = argv[++i]
        break
      case '--tagline':
        args.tagline = argv[++i]
        break
      case '--description':
        args.description = argv[++i]
        break
      case '--author':
        args.author = argv[++i]
        break
      case '--theme':
        args.theme = argv[++i]
        break
      case '--note':
        args.note = argv[++i]
        break
      case '--tag':
        args.tags.push(argv[++i] ?? '')
        break
      case '--json':
        args.json = true
        break
      case '--fresh':
        args.fresh = true
        break
      case '--no-crawl':
        args.noCrawl = true
        break
      case '--browser':
        args.window = true
        break
      case '--autostart':
        args.autostart = true
        break
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          throw new Error(`unknown option: ${arg}`)
        }
        if (arg !== undefined) args.positionals.push(arg)
    }
  }

  return args
}

function number(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} needs a number`)
  }
  return parsed
}

function usage(): void {
  console.log(`openweb — a web with no ads, no trackers, no AI

usage:
  openweb start [folder]          serve, bridge, crawl, and index in one process
  openweb browser [folder]        the same stack, opened as an app window
  openweb init                    create a site, print its address
  openweb serve <folder>          publish a folder from this machine
  openweb gateway                 run the local gateway on :8080
  openweb open <address>          start a gateway and print the URL
  openweb crawl <address...>      crawl sites into the local SQLite index
  openweb search <words>          query the local index
  openweb new <folder>            generate a static page with the builder
  openweb pin <address>           keep a full replica of a site and seed it
  openweb pin list                show pinned sites
  openweb pin remove <address>    stop seeding a site
  openweb index publish           publish the local index as a drive
  openweb index fetch <address>   download and verify a shared index
  openweb index query <a> <words> query somebody else's index
  openweb index import <address>  merge a shared index into the local one
  openweb index stats             show local index size and counts
  openweb directory init          create an identity and a signed directory
  openweb directory add <addr>    add a site to the local signed directory
  openweb directory remove <addr> remove a site from it
  openweb directory verify [file] verify signatures offline
  openweb directory publish       publish the directory as a drive
  openweb directory fetch <addr>  fetch and verify a remote directory
  openweb install                 write launchers (add --autostart on Windows)
  openweb bench                   measure the engine on synthetic data

query syntax:
  word word        both words must appear
  "exact phrase"   consecutive words, in order
  -word            exclude pages containing the word
  title:word       word must appear in the title
  word OR word     either word may appear
  Misspellings and common synonyms are tried when an exact word is missing.

options:
  --dir <path>                    state directory (default ${DEFAULT_DIR})
  --port <n>                      node port for serve/start (default ${DEFAULT_PORT})
  --gateway-port <n>              gateway port for start (default ${DEFAULT_GATEWAY_PORT})
  --gateway <url>                 gateway used by crawl
  --max <n>                       max pages to crawl (default 200, start: 50)
  --concurrency <n>               parallel fetches (default 4)
  --fresh                         rebuild the index instead of merging
  --no-crawl                      start: do not crawl the local site
  --browser                       start: open an app window when ready
  --autostart                     install: add a Startup entry (Windows)
  --name <text>                   directory init: directory name
  --title <text>                  directory add / new: site title
  --tagline <text>                new: subtitle
  --description <text>            directory add / new: description
  --author <text>                 new: name shown on the page
  --theme <forest|paper>          new: page theme
  --tag <text>                    directory add: tag (repeatable)
  --note <text>                   directory add: note shown with the entry
  --json                          machine-readable output
  --docs <n>                      bench: synthetic documents (default 20000)
  --queries <n>                   bench: query count (default 2000)

Addresses look like ow1x7f2k... and are public keys. Nothing to register.
`)
}

function onShutdown(close: () => Promise<void>): void {
  let closing = false
  const stop = (): void => {
    if (closing) process.exit(1)
    closing = true
    console.log('\ngoing offline…')
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parse(rest)
  const dir = resolve(args.dir ?? DEFAULT_DIR)

  switch (command) {
    case 'init': {
      const address = await initNode(dir)
      console.log('site created\n')
      console.log('  address   ' + address)
      console.log('  state     ' + dir)
      console.log('')
      console.log('Run `openweb serve .` to bring it online.')
      return
    }

    case 'start':
    case 'serve-all': {
      await startStack(args, args.positionals[0] ?? 'app', false)
      return
    }

    case 'browser': {
      await startStack(args, args.positionals[0] ?? 'app', true)
      return
    }

    case 'serve': {
      const folder = args.positionals[0] ?? '.'
      const node = await startNode({ dir, folder, port: args.port ?? DEFAULT_PORT })

      console.log('online\n')
      console.log('  address   ' + node.address)
      console.log('  preview   ' + node.previewUrl)
      console.log('  published ' + node.published + ' file(s) from ' + folder)
      console.log('')
      console.log('Anyone with the gateway can read it while this process runs.')
      console.log('Ctrl+C to go offline.')

      onShutdown(() => node.close())
      return
    }

    case 'gateway': {
      const gateway = await startGateway({
        dir,
        port: args.port ?? DEFAULT_GATEWAY_PORT,
        timeoutMs: args.timeout,
      })

      console.log('gateway listening\n')
      console.log('  ' + gateway.url)
      console.log('  ' + gateway.url + 'search?q=…')
      console.log('')
      console.log('Ctrl+C to stop.')

      onShutdown(() => gateway.close())
      return
    }

    case 'open': {
      const address = args.positionals[0]
      if (!address || !isAddress(address)) {
        console.error('open needs a valid address, e.g. ow1x7f2k...')
        process.exit(1)
      }

      const gateway = await startGateway({
        dir,
        port: args.port ?? DEFAULT_GATEWAY_PORT,
        timeoutMs: args.timeout,
      })

      console.log(gateway.url + address + '/')
      console.log('')
      console.log('Ctrl+C to stop.')

      onShutdown(() => gateway.close())
      return
    }

    case 'crawl': {
      const seeds = args.positionals
      if (seeds.length === 0) {
        console.error('crawl needs at least one address')
        process.exit(1)
      }

      const gateway = args.gateway ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`
      console.log(`crawling ${seeds.length} seed(s) through ${gateway}\n`)

      const started = performance.now()
      const documents = await crawl({
        gateway,
        seeds,
        maxPages: args.max ?? 200,
        concurrency: args.concurrency ?? 4,
        onPage: (document) => {
          console.log(`  + ${document.address.slice(0, 8)}…${document.path}  ${document.title}`)
        },
      })

      const stats = addDocuments(dir, documents, args.fresh)
      const elapsed = performance.now() - started

      console.log('')
      console.log(
        `crawled ${documents.length} page(s) in ${(elapsed / 1000).toFixed(1)}s; index has ${stats.documents} document(s), ${stats.terms} terms`,
      )
      console.log('  ' + indexFileFor(dir))
      return
    }

    case 'search': {
      const query = args.positionals.join(' ')
      if (query.trim() === '') {
        console.error('search needs some words')
        process.exit(1)
      }

      const file = indexFileFor(dir)
      if (!sqliteIndexExists(file)) {
        console.error(`no index yet at ${file}; run \`openweb crawl <address>\` first`)
        process.exit(1)
      }

      const index = SqliteIndex.open(file, { readOnly: true })
      try {
        // Warm the JIT so the reported time is the engine, not the compiler.
        index.search(query, 10)
        const started = performance.now()
        const found = index.search(query, 10)
        const took = performance.now() - started

        if (args.json) {
          console.log(
            JSON.stringify(
              {
                query,
                tookMs: Number(took.toFixed(3)),
                total: found.total,
                indexed: index.documentCount,
                matchedTerms: found.matchedTerms,
                results: found.results.map((result) => ({
                  title: result.document.title,
                  url: `openweb://${result.document.address}${result.document.path}`,
                  address: result.document.address,
                  path: result.document.path,
                  score: Number(result.score.toFixed(4)),
                  snippet: result.snippet,
                })),
              },
              null,
              2,
            ),
          )
          return
        }

        console.log(
          `${found.total} result(s) for "${query}" in ${took.toFixed(2)}ms — ${index.documentCount} page(s) indexed\n`,
        )
        for (const result of found.results) {
          console.log(result.document.title)
          console.log(`  openweb://${result.document.address}${result.document.path}`)
          console.log(`  ${result.snippet}`)
          console.log('')
        }
      } finally {
        index.close()
      }
      return
    }

    case 'new': {
      const folder = args.positionals[0]
      if (!folder) {
        console.error('new needs a folder, e.g. openweb new my-site')
        process.exit(1)
      }
      const spec = builderSpec(args)
      const built = writeSite(resolve(folder), spec)
      console.log('page created\n')
      console.log('  folder    ' + resolve(folder))
      console.log('  file      ' + join(resolve(folder), 'index.html'))
      console.log('  bytes     ' + Buffer.byteLength(built.html))
      console.log('')
      console.log('Publish it with: openweb serve ' + folder)
      return
    }

    case 'pin': {
      const sub = args.positionals[0]
      if (sub === 'list' || sub === undefined) {
        const pins = readPins(dir)
        if (args.json) {
          console.log(JSON.stringify({ pins }, null, 2))
          return
        }
        if (pins.length === 0) {
          console.log('no pins yet. Add one with `openweb pin <address>`.')
          return
        }
        console.log(`${pins.length} pinned site(s) in ${join(dir, 'pins')}\n`)
        for (const pin of pins) {
          const synced = pin.lastSync ? new Date(pin.lastSync).toISOString() : 'never'
          console.log(pin.address)
          console.log(`  added ${new Date(pin.added).toISOString()} · last sync ${synced}`)
          console.log('')
        }
        return
      }

      if (sub === 'remove') {
        const address = args.positionals[1]
        if (!address || !isAddress(address)) {
          console.error('pin remove needs a valid address')
          process.exit(1)
        }
        const removed = removePin(dir, address)
        console.log(removed ? 'pin removed: ' + address : 'that address was not pinned')
        return
      }

      if (!isAddress(sub)) {
        console.error('pin needs an address, `pin list`, or `pin remove <address>`')
        process.exit(1)
      }

      const pinned = await startPin(sub, {
        dir,
        timeoutMs: (args.timeout ?? 20) * 1000,
        onStatus: (message) => console.log('  ' + message),
      })
      console.log('\npinning ' + pinned.address)
      const complete = await Promise.race([
        pinned.complete,
        new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 15_000)),
      ])
      console.log(
        complete
          ? '  full replica downloaded; seeding while this process runs.'
          : '  still downloading in the background; seeding while this process runs.',
      )
      console.log('\nCtrl+C to stop seeding.')
      onShutdown(() => pinned.close())
      return
    }

    case 'index': {
      const sub = args.positionals[0]
      if (sub === 'publish') {
        const shared = await publishIndex({
          dir,
          publisher: tryIdentityAddress(dir),
          onStatus: (message) => console.log('  ' + message),
        })
        console.log('\nshared index published\n')
        console.log('  address   ' + shared.address)
        console.log('  documents ' + shared.manifest.documents)
        console.log('  terms     ' + shared.manifest.terms)
        console.log('  sha256    ' + shared.manifest.sha256)
        console.log('')
        console.log('Query it with: openweb index query ' + shared.address + ' "words"')
        console.log('Ctrl+C to stop serving it.')
        onShutdown(() => shared.close())
        return
      }

      if (sub === 'fetch' || sub === 'import' || sub === 'query') {
        const address = args.positionals[1]
        if (!address || !isAddress(address)) {
          console.error(`index ${sub} needs a valid index address`)
          process.exit(1)
        }

        const client = new SharedIndexClient({ dir, timeoutMs: (args.timeout ?? 30) * 1000 })
        try {
          const fetched = await client.fetch(address)
          const manifest = fetched.manifest
          if (sub === 'fetch') {
            console.log('shared index fetched and verified\n')
            console.log('  address   ' + address)
            console.log('  file      ' + fetched.file)
            console.log('  documents ' + manifest.documents)
            console.log('  terms     ' + manifest.terms)
            console.log('  bytes     ' + manifest.bytes)
            console.log('  sha256    ' + manifest.sha256)
            return
          }

          if (sub === 'import') {
            const local = SqliteIndex.openOrCreate(indexFileFor(dir))
            let imported = 0
            let batch: Document[] = []
            try {
              for (const document of fetched.index.iterateDocuments(500)) {
                batch.push(document)
                if (batch.length >= 500) {
                  local.addDocuments(batch)
                  imported += batch.length
                  batch = []
                }
              }
              if (batch.length > 0) {
                local.addDocuments(batch)
                imported += batch.length
              }
              const stats = local.stats()
              console.log(
                `imported ${imported} document(s) from ${address}; local index now has ${stats.documents} document(s), ${stats.terms} terms`,
              )
              console.log('  ' + indexFileFor(dir))
            } finally {
              local.close()
            }
            return
          }

          const query = args.positionals.slice(2).join(' ')
          if (query.trim() === '') {
            console.error('index query needs some words')
            process.exit(1)
          }
          const found = fetched.index.search(query, 20)
          if (args.json) {
            console.log(
              JSON.stringify(
                {
                  address,
                  manifest,
                  query,
                  total: found.total,
                  results: found.results.map((result) => ({
                    title: result.document.title,
                    url: `openweb://${result.document.address}${result.document.path}`,
                    address: result.document.address,
                    path: result.document.path,
                    score: Number(result.score.toFixed(4)),
                    snippet: result.snippet,
                  })),
                },
                null,
                2,
              ),
            )
            return
          }
          console.log(
            `${found.total} result(s) for "${query}" in shared index ${address.slice(0, 12)}… (${manifest.documents} pages)\n`,
          )
          for (const result of found.results) {
            console.log(result.document.title)
            console.log(`  openweb://${result.document.address}${result.document.path}`)
            console.log(`  ${result.snippet}`)
            console.log('')
          }
        } finally {
          await client.close()
        }
        return
      }

      if (sub === 'stats' || sub === undefined) {
        const file = indexFileFor(dir)
        if (!sqliteIndexExists(file)) {
          console.log(`no index yet at ${file}`)
          return
        }
        const index = SqliteIndex.open(file, { readOnly: true })
        try {
          const stats = index.stats()
          if (args.json) {
            console.log(JSON.stringify(stats, null, 2))
            return
          }
          console.log('local index\n')
          console.log('  file      ' + file)
          console.log('  documents ' + stats.documents)
          console.log('  terms     ' + stats.terms)
          console.log('  size      ' + (stats.bytes / 1024 / 1024).toFixed(1) + ' MB')
          console.log('  built     ' + (stats.built ? new Date(stats.built).toISOString() : 'never'))
        } finally {
          index.close()
        }
        return
      }

      console.error('unknown index subcommand: ' + sub)
      console.error('try: publish, fetch, query, import, stats')
      process.exit(1)
    }

    case 'directory': {
      await directoryCommand(args, dir)
      return
    }

    case 'install': {
      const folder = args.positionals[0] ?? 'app'
      const paths = writeLaunchers({ dir, folder, autostart: args.autostart })
      console.log('launchers written\n')
      console.log('  open browser   ' + paths.browser)
      console.log('  start silently ' + paths.start)
      if (paths.autostart) console.log('  startup entry  ' + paths.autostart)
      console.log('')
      console.log('Next: run `openweb browser` once to install the app window,')
      console.log('or open `openweb install --autostart` to start it at login.')
      return
    }

    case 'bench': {
      bench(args.docs ?? 20_000, args.queries ?? 2_000)
      return
    }

    case undefined:
    case 'help':
    case '-h':
    case '--help':
      usage()
      return

    default:
      console.error(`unknown command: ${command}`)
      usage()
      process.exit(1)
  }
}

/* -------------------------------------------------------------------------- */
/* Stack                                                                      */
/* -------------------------------------------------------------------------- */

async function startStack(args: Args, folder: string, openWindow: boolean): Promise<void> {
  const dir = resolve(args.dir ?? DEFAULT_DIR)
  const node = await startNode({ dir, folder, port: args.port ?? DEFAULT_PORT })
  const gateway = await startGateway({
    dir,
    port: args.gatewayPort ?? DEFAULT_GATEWAY_PORT,
    timeoutMs: args.timeout,
  })

  // A read-only drive can sync an older version of the site first. Wait for
  // the version we just published before crawling, or the index starts
  // with yesterday's page.
  await gateway.waitForVersion(node.address, node.version, 10_000)

  console.log('openweb is running\n')
  console.log('  site      ' + gateway.url + node.address + '/')
  console.log('  browser   ' + gateway.url)
  console.log('  address   ' + node.address)
  console.log('')

  if (!args.noCrawl) {
    console.log('indexing this site…')
    try {
      const documents = await crawl({
        gateway: gateway.url.replace(/\/+$/, ''),
        seeds: [node.address],
        maxPages: args.max ?? 50,
        concurrency: args.concurrency ?? 4,
      })
      const stats = addDocuments(dir, documents, args.fresh)
      console.log(
        `  indexed ${documents.length} page(s); ${stats.documents} document(s) in the local index`,
      )
    } catch (error) {
      console.error(
        '  crawl skipped: ' + (error instanceof Error ? error.message : String(error)),
      )
    }
    console.log('')
  }

  if (openWindow) {
    const opened = launchAppWindow(gateway.url)
    console.log(
      opened
        ? 'opened the OpenWeb app window.'
        : 'No Chrome or Edge found; open ' + gateway.url + ' in any browser.',
    )
    console.log('')
  }

  if (!args.noCrawl && !args.fresh) seedExistingPins(dir)

  console.log('Open ' + gateway.url + ' in a browser. Ctrl+C to stop.')
  onShutdown(async () => {
    await gateway.close()
    await node.close()
  })
}

/** Pinned sites are seeded alongside the local site whenever the stack runs. */
function seedExistingPins(dir: string): void {
  const pins = readPins(dir)
  if (pins.length === 0) return
  console.log(`seeding ${pins.length} pinned site(s) in the background…`)
  for (const pin of pins) {
    void startPin(pin.address, { dir, timeoutMs: 8_000 }).catch(() => undefined)
  }
}

function addDocuments(
  dir: string,
  documents: Document[],
  fresh: boolean,
): { documents: number; terms: number; bytes: number } {
  mkdirSync(dir, { recursive: true })
  const file = indexFileFor(dir)
  const index = SqliteIndex.openOrCreate(file)
  try {
    if (fresh) index.reset()
    index.addDocuments(documents)
    return index.stats()
  } finally {
    index.close()
  }
}

function builderSpec(args: Args): SiteSpec {
  const spec = defaultSpec()
  if (args.title) spec.title = args.title
  if (args.tagline) spec.tagline = args.tagline
  if (args.description) spec.description = args.description
  if (args.author) spec.author = args.author
  if (args.theme === 'paper' || args.theme === 'forest') spec.theme = args.theme
  return spec
}

function tryIdentityAddress(dir: string): string | undefined {
  try {
    if (!existsSync(join(dir, 'identity.json'))) return undefined
    const identity = ensureIdentity(join(dir, 'identity.json'))
    return identityAddress(identity)
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Directory                                                                  */
/* -------------------------------------------------------------------------- */

async function directoryCommand(args: Args, dir: string): Promise<void> {
  const sub = args.positionals[0] ?? 'show'
  const file = join(dir, 'directory.json')
  const identityFile = join(dir, 'identity.json')

  if (sub === 'init') {
    const identity = ensureIdentity(identityFile)
    const signed = createSignedDirectory(
      identity,
      args.name ?? 'OpenWeb directory',
      args.description,
    )
    saveDirectory(file, signed)
    console.log('directory created\n')
    console.log('  author    ' + signed.payload.author)
    console.log('  identity  ' + identityFile)
    console.log('  file      ' + file)
    console.log('')
    console.log('Add a site: openweb directory add <address> --title "My site"')
    return
  }

  if (sub === 'add') {
    const address = args.positionals[1]
    if (!address || !isAddress(address)) {
      console.error('directory add needs a valid site address')
      process.exit(1)
    }
    const signed = ensureLocalDirectory(file, identityFile, args)
    const identity = ensureIdentity(identityFile)
    const site: Omit<DirectorySite, 'added'> = {
      address,
      title: args.title ?? address,
      ...(args.description ? { description: args.description } : {}),
      ...(args.tags.filter(Boolean).length > 0 ? { tags: args.tags.filter(Boolean) } : {}),
    }
    const updated = addDirectoryEntry(signed.payload, identity, site, {
      ...(args.note ? { note: args.note } : {}),
    })
    const reSigned = signDirectory(updated, identity)
    saveDirectory(file, reSigned)
    console.log('entry added\n')
    console.log('  site      ' + address)
    console.log('  title     ' + site.title)
    console.log('  signer    ' + identityAddress(identity))
    console.log('  entries   ' + reSigned.payload.entries.length)
    return
  }

  if (sub === 'remove') {
    const address = args.positionals[1]
    if (!address || !isAddress(address)) {
      console.error('directory remove needs a valid site address')
      process.exit(1)
    }
    const signed = ensureLocalDirectory(file, identityFile, args)
    const identity = ensureIdentity(identityFile)
    const updated = removeDirectoryEntry(signed.payload, identity, address)
    const reSigned = signDirectory(updated, identity)
    saveDirectory(file, reSigned)
    console.log(`removed ${address}; ${reSigned.payload.entries.length} entry/entries remain`)
    return
  }

  if (sub === 'verify') {
    const target = args.positionals[1] ? resolve(args.positionals[1]) : file
    if (!existsSync(target)) {
      console.error(`no directory at ${target}; run \`openweb directory init\` first`)
      process.exit(1)
    }
    const signed = loadDirectory(target)
    const verification = verifyDirectory(signed)
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            valid: verification.valid,
            author: verification.document.author,
            name: verification.document.name,
            entries: verification.entries.length,
            sites: mergeDirectoryEntries(verification).map((site) => ({
              address: site.address,
              title: site.title,
              recommenders: site.recommenders,
            })),
            errors: verification.errors,
          },
          null,
          2,
        ),
      )
    } else {
      console.log('directory verification\n')
      console.log('  file      ' + target)
      console.log('  valid     ' + (verification.valid ? 'yes' : 'no'))
      console.log('  author    ' + verification.document.author)
      console.log('  name      ' + verification.document.name)
      console.log('  entries   ' + verification.entries.length)
      for (const site of mergeDirectoryEntries(verification)) {
        console.log('')
        console.log('  ' + site.title + '  ' + site.address)
        console.log('    ' + site.recommenders.length + ' signature(s)')
        if (site.description) console.log('    ' + site.description)
      }
      if (!verification.valid) {
        console.error('\nerrors:')
        for (const error of verification.errors) console.error('  - ' + error)
      }
    }
    if (!verification.valid) process.exit(1)
    return
  }

  if (sub === 'publish') {
    if (!existsSync(file)) {
      console.error(`no directory at ${file}; run \`openweb directory init\` first`)
      process.exit(1)
    }
    const signed = loadDirectory(file)
    const verification = verifyDirectory(signed)
    if (!verification.valid) {
      console.error('refusing to publish an invalid directory: ' + verification.errors.join('; '))
      process.exit(1)
    }
    const shared = await publishDirectory({
      dir,
      signed,
      onStatus: (message) => console.log('  ' + message),
    })
    mkdirSync(dir, { recursive: true })
    writeText(join(dir, 'directory-address.txt'), shared.address + '\n')
    console.log('\ndirectory published\n')
    console.log('  address   ' + shared.address)
    console.log('  entries   ' + signed.payload.entries.length)
    console.log('')
    console.log('Load it in the gateway: /directory?address=' + shared.address)
    console.log('Ctrl+C to stop serving it.')
    onShutdown(() => shared.close())
    return
  }

  if (sub === 'fetch') {
    const address = args.positionals[1]
    if (!address || !isAddress(address)) {
      console.error('directory fetch needs a valid directory drive address')
      process.exit(1)
    }
    const fetched = await fetchDirectory(address, {
      dir,
      timeoutMs: (args.timeout ?? 30) * 1000,
    })
    try {
      const verification = verifyDirectory(fetched.signed)
      const saved = join(dir, 'directories', `${address}.json`)
      mkdirSync(join(dir, 'directories'), { recursive: true })
      writeText(saved, fetched.raw)
      console.log('directory fetched\n')
      console.log('  address   ' + address)
      console.log('  valid     ' + (verification.valid ? 'yes' : 'no'))
      console.log('  author    ' + verification.document.author)
      console.log('  entries   ' + verification.entries.length)
      console.log('  saved     ' + saved)
      for (const site of mergeDirectoryEntries(verification)) {
        console.log('')
        console.log('  ' + site.title + '  ' + site.address)
        console.log('    ' + site.recommenders.length + ' signature(s)')
      }
      if (!verification.valid) {
        console.error('\nerrors:')
        for (const error of verification.errors) console.error('  - ' + error)
        process.exit(1)
      }
    } finally {
      await fetched.close()
    }
    return
  }

  if (sub === 'show' || sub === undefined) {
    if (!existsSync(file)) {
      console.log('no local directory yet. Create one with `openweb directory init`.')
      return
    }
    const signed = loadDirectory(file)
    const verification = verifyDirectory(signed)
    console.log('local directory\n')
    console.log('  file      ' + file)
    console.log('  name      ' + verification.document.name)
    console.log('  author    ' + verification.document.author)
    console.log('  valid     ' + (verification.valid ? 'yes' : 'no'))
    console.log('  entries   ' + verification.entries.length)
    for (const site of mergeDirectoryEntries(verification)) {
      console.log('  ' + site.title + '  ' + site.address)
    }
    return
  }

  console.error('unknown directory subcommand: ' + sub)
  console.error('try: init, add, remove, verify, publish, fetch, show')
  process.exit(1)
}

function ensureLocalDirectory(
  file: string,
  identityFile: string,
  args: Args,
): Signed<DirectoryDocument> {
  if (existsSync(file)) return loadDirectory(file)
  const identity = ensureIdentity(identityFile)
  const signed = createSignedDirectory(identity, args.name ?? 'OpenWeb directory')
  saveDirectory(file, signed)
  return signed
}

function writeText(file: string, contents: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents)
}

/* -------------------------------------------------------------------------- */
/* Bench                                                                      */
/* -------------------------------------------------------------------------- */

const HEAD_WORDS = `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi
omicron pi rho sigma tau upsilon phi chi psi omega garden tomato coffee compost soil
water light search engine index crawl peer dht drive block key sign verify address
page link text word query document score rank title snippet crawler gateway node
human written slow fast quiet loud small large morning evening winter summer`
  .split(/\s+/)
  .filter(Boolean)

/** A synthetic vocabulary large enough to have a real long tail. */
const VOCAB_SIZE = 20_000

function vocabularyWord(rank: number): string {
  return HEAD_WORDS[rank] ?? `term${rank}`
}

/** Deterministic PRNG so every run reports the same corpus. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Zipf-ish rank draw: P(rank <= r) = sqrt((r + 1) / vocabulary). A handful of
 * words appear in most pages, a long tail appears in one or two — like prose,
 * not like a bag of every word in the language.
 */
function zipfRank(random: number): number {
  return Math.min(VOCAB_SIZE - 1, Math.floor(VOCAB_SIZE * random * random))
}

function percentile(times: number[], p: number): number {
  if (times.length === 0) return 0
  return times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0
}

function measure(index: SqliteIndex, queries: string[], limit = 10): number[] {
  const times: number[] = []
  for (const query of queries) {
    const started = performance.now()
    index.search(query, limit)
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  return times
}

function bench(docCount: number, queryCount: number): void {
  const random = mulberry32(42)
  const documents: Document[] = []
  let tokenCount = 0

  for (let i = 0; i < docCount; i++) {
    const length = 40 + Math.floor(random() * 200)
    const words: string[] = []
    for (let j = 0; j < length; j++) words.push(vocabularyWord(zipfRank(random())))

    const titleWords: string[] = []
    const titleLength = 3 + Math.floor(random() * 3)
    for (let j = 0; j < titleLength; j++) {
      titleWords.push(vocabularyWord(Math.floor(random() * random() * 500)))
    }

    tokenCount += length
    documents.push({
      address: 'ow1' + 'a'.repeat(52),
      path: `/page-${i}`,
      title: titleWords.join(' '),
      text: words.join(' '),
    })
  }

  const workDir = mkdtempSync(join(tmpdir(), 'openweb-bench-'))
  const file = join(workDir, 'index.db')

  try {
    const buildStart = performance.now()
    const index = SqliteIndex.build(file, documents, { fresh: true })
    const buildMs = performance.now() - buildStart

    try {
      // A query mix: head terms, mid terms, tail terms, AND, phrase, title, and
      // negation. None of these is the pathological "every page matches" case.
      const queries: string[] = []
      const qRandom = mulberry32(7)
      const head = (): string => vocabularyWord(Math.floor(qRandom() * qRandom() * 20))
      const rare = (): string => vocabularyWord(2_000 + Math.floor(qRandom() * 17_000))

      for (let i = 0; i < queryCount; i++) {
        switch (i % 8) {
          case 0:
            queries.push(vocabularyWord(zipfRank(qRandom())))
            break
          case 1:
            queries.push(vocabularyWord(50 + Math.floor(qRandom() * 450)))
            break
          case 2:
            queries.push(rare())
            break
          case 3:
            queries.push(`${head()} ${head()}`)
            break
          case 4:
            queries.push(`${head()} ${rare()}`)
            break
          case 5: {
            const document = documents[Math.floor(qRandom() * documents.length)]
            const words = document?.text.split(' ') ?? []
            const at = Math.floor(qRandom() * Math.max(1, words.length - 1))
            queries.push(`"${words[at] ?? 'word'} ${words[at + 1] ?? 'word'}"`)
            break
          }
          case 6:
            queries.push(`title:${vocabularyWord(Math.floor(qRandom() * 200))}`)
            break
          default:
            queries.push(`${head()} -${rare()}`)
        }
      }

      measure(index, queries.slice(0, 200)) // warm up the JIT
      const times = measure(index, queries)
      const stats = index.stats()

      const totalTime = times.reduce((sum, time) => sum + time, 0)

      const stressQueries = [
        vocabularyWord(0),
        `${vocabularyWord(0)} ${vocabularyWord(1)}`,
      ]
      measure(index, stressQueries, 10)
      const stress = stressQueries.map((query) => ({
        query,
        median: percentile(measure(index, Array(200).fill(query)), 0.5),
      }))

      console.log(`documents      ${docCount.toLocaleString()}`)
      console.log(`tokens         ${tokenCount.toLocaleString()}`)
      console.log(`terms          ${stats.terms.toLocaleString()}`)
      console.log(`index size     ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`)
      console.log(`build          ${buildMs.toFixed(0)} ms`)
      console.log(
        `queries        ${queryCount.toLocaleString()} (common, mid, rare, AND, phrase, title, negation)`,
      )
      console.log(`median         ${percentile(times, 0.5).toFixed(3)} ms`)
      console.log(`p95            ${percentile(times, 0.95).toFixed(3)} ms`)
      console.log(`p99            ${percentile(times, 0.99).toFixed(3)} ms`)
      console.log(`mean           ${(totalTime / Math.max(1, times.length)).toFixed(3)} ms`)
      console.log(
        `throughput     ${Math.round(queryCount / (totalTime / 1000)).toLocaleString()} queries/s`,
      )
      console.log('')
      console.log('head terms (most pages match):')
      for (const entry of stress) {
        console.log(`  ${entry.query.padEnd(18)} ${entry.median.toFixed(3)} ms median`)
      }
    } finally {
      index.close()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
