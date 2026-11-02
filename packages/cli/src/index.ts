#!/usr/bin/env node
/**
 * openweb — the only interface most people will ever touch.
 *
 *   openweb start [folder]        serve, bridge, crawl, and index in one process
 *   openweb init                  create a site and print its address
 *   openweb serve <folder>        publish a folder from this machine
 *   openweb gateway               run the local gateway on :8080
 *   openweb open <address>        start a gateway and print the URL
 *   openweb crawl <address...>    crawl sites into a local search index
 *   openweb search <words>        query that index
 *   openweb bench                 measure the engine on synthetic data
 */

import { isAddress } from '@openweb/core'
import { DEFAULT_GATEWAY_PORT, startGateway } from '@openweb/gateway'
import {
  buildIndex,
  crawl,
  loadIndex,
  mergeDocuments,
  saveIndex,
  search,
  type Document,
  type IndexFile,
} from '@openweb/index'
import { DEFAULT_DIR, DEFAULT_PORT, initNode, startNode } from '@openweb/node'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
}

function parse(argv: string[]): Args {
  const args: Args = { positionals: [], json: false, fresh: false, noCrawl: false }

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
      case '--json':
        args.json = true
        break
      case '--fresh':
        args.fresh = true
        break
      case '--no-crawl':
        args.noCrawl = true
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
  openweb init                    create a site, print its address
  openweb serve <folder>          publish a folder from this machine
  openweb gateway                 run the local gateway on :8080
  openweb open <address>          start a gateway and print the URL
  openweb crawl <address...>      crawl sites into a local search index
  openweb search <words>          query the local index
  openweb bench                   measure the engine on synthetic data

query syntax:
  word word        both words must appear
  "exact phrase"   consecutive words, in order
  -word            exclude pages containing the word
  title:word       word must appear in the title
  word OR word     either word may appear

options:
  --dir <path>                    state directory (default ${DEFAULT_DIR})
  --port <n>                      node port for serve/start (default ${DEFAULT_PORT})
  --gateway-port <n>              gateway port for start (default ${DEFAULT_GATEWAY_PORT})
  --gateway <url>                 gateway used by crawl
  --max <n>                       max pages to crawl (default 200, start: 50)
  --concurrency <n>               parallel fetches (default 4)
  --fresh                         rebuild the index instead of merging
  --no-crawl                      start: do not crawl the local site
  --json                          machine-readable search output
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
  const dir = args.dir ?? DEFAULT_DIR

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

    case 'start': {
      const folder = args.positionals[0] ?? 'app'
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
          const previous = args.fresh ? null : loadIndex(join(dir, 'index.json'))
          const merged = mergeDocuments(previous, documents)
          const index = buildIndex(merged)
          mkdirSync(dir, { recursive: true })
          saveIndex(index, join(dir, 'index.json'))
          console.log(
            `  indexed ${documents.length} page(s); ${merged.length} document(s) in the local index`,
          )
        } catch (error) {
          console.error(
            '  crawl skipped: ' + (error instanceof Error ? error.message : String(error)),
          )
        }
        console.log('')
      }

      console.log('Open ' + gateway.url + ' in a browser. Ctrl+C to stop.')
      onShutdown(async () => {
        await gateway.close()
        await node.close()
      })
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

      const previous = args.fresh ? null : loadIndex(join(dir, 'index.json'))
      const merged = mergeDocuments(previous, documents)
      const index = buildIndex(merged)

      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'index.json')
      saveIndex(index, file)
      const elapsed = performance.now() - started

      console.log('')
      console.log(
        `crawled ${documents.length} page(s) in ${(elapsed / 1000).toFixed(1)}s; index has ${merged.length} document(s), ${Object.keys(index.postings).length} terms`,
      )
      console.log('  ' + file)
      return
    }

    case 'search': {
      const query = args.positionals.join(' ')
      if (query.trim() === '') {
        console.error('search needs some words')
        process.exit(1)
      }

      const index = loadIndex(join(dir, 'index.json'))
      // Warm the JIT so the reported time is the engine, not the compiler.
      search(index, query, 10)
      const started = performance.now()
      const found = search(index, query, 10)
      const took = performance.now() - started

      if (args.json) {
        console.log(
          JSON.stringify(
            {
              query,
              tookMs: Number(took.toFixed(3)),
              total: found.total,
              indexed: index.documents.length,
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
        `${found.total} result(s) for "${query}" in ${took.toFixed(2)}ms — ${index.documents.length} page(s) indexed\n`,
      )
      for (const result of found.results) {
        console.log(result.document.title)
        console.log(`  openweb://${result.document.address}${result.document.path}`)
        console.log(`  ${result.snippet}`)
        console.log('')
      }
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

function measure(index: IndexFile, queries: string[], limit = 10): number[] {
  const times: number[] = []
  for (const query of queries) {
    const started = performance.now()
    search(index, query, limit)
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

  const buildStart = performance.now()
  const index = buildIndex(documents)
  const buildMs = performance.now() - buildStart

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
  const bytes = Buffer.byteLength(JSON.stringify(index))

  const totalTime = times.reduce((sum, time) => sum + time, 0)

  // Worst case, reported separately: the head of a Zipf distribution appears
  // in most documents, so these queries deliberately score thousands of pages.
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
  console.log(`terms          ${Object.keys(index.postings).length.toLocaleString()}`)
  console.log(`index size     ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`build          ${buildMs.toFixed(0)} ms`)
  console.log(`queries        ${queryCount.toLocaleString()} (common, mid, rare, AND, phrase, title, negation)`)
  console.log(`median         ${percentile(times, 0.5).toFixed(3)} ms`)
  console.log(`p95            ${percentile(times, 0.95).toFixed(3)} ms`)
  console.log(`p99            ${percentile(times, 0.99).toFixed(3)} ms`)
  console.log(`mean           ${(totalTime / Math.max(1, times.length)).toFixed(3)} ms`)
  console.log(`throughput     ${Math.round(queryCount / (totalTime / 1000)).toLocaleString()} queries/s`)
  console.log('')
  console.log('head terms (most pages match):')
  for (const entry of stress) {
    console.log(`  ${entry.query.padEnd(18)} ${entry.median.toFixed(3)} ms median`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
