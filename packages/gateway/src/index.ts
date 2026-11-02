/**
 * The gateway: how a normal browser reads OpenWeb.
 *
 *   GET /                      the new-tab page (one search bar + app launcher)
 *   GET /<address>/<path>      fetch a page from a peer
 *   GET /search?q=…            search the local SQLite index
 *   GET /sites                 every site this machine has crawled
 *   GET /open?to=…             the address bar: resolve an address and redirect
 *   GET /directory             the signed human directory, local or remote
 *   GET /shared?address=…&q=…  query somebody else's published index
 *   GET /builder               make a static page without a framework
 *   GET /manifest.webmanifest  make the gateway installable as an app window
 *
 * It decodes the address back into a drive key, joins that drive's DHT topic,
 * replicates from whoever is online, and streams the file back as plain HTTP.
 *
 * This is the only component that talks to both worlds, which makes it the
 * place we enforce the rules: no cookies, no visitor logging, no scripts added,
 * and cross-site links rewritten so they work in a normal browser.
 */

import {
  decodeAddress,
  drivePathFor,
  isAddress,
  loadDirectory,
  mergeDirectoryEntries,
  parseGatewayPath,
  parseOpenWebUrl,
  readFromDrive,
  verifyDirectory,
  type DirectoryDocument,
  type DirectoryVerification,
  type Signed,
} from '@openweb/core'
import {
  SqliteIndex,
  indexFileFor,
  type IndexManifest,
  type PageSummary,
  type SearchResponse,
  type SiteSummary,
} from '@openweb/index'
import { SharedIndexClient, fetchDirectory } from '@openweb/node'
import { defaultSpec, renderSite, specFromFields, type SiteSpec } from '@openweb/builder'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { SERVICE_WORKER, WEB_MANIFEST, iconPng } from './pwa.js'

export const DEFAULT_GATEWAY_DIR = '.openweb'
export const DEFAULT_GATEWAY_PORT = 8080

export interface GatewayOptions {
  /** Where gateway state, the index, and signed records live. */
  dir?: string
  port?: number
  /** How long to wait for a peer before giving up. */
  timeoutMs?: number
}

export interface Gateway {
  url: string
  /** Wait until the read-only drive has caught up to a published version. */
  waitForVersion(address: string, version: number, timeoutMs?: number): Promise<boolean>
  indexStats(): { documents: number; terms: number; built: number }
  close(): Promise<void>
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const dir = resolve(options.dir ?? DEFAULT_GATEWAY_DIR)
  const port = options.port ?? DEFAULT_GATEWAY_PORT
  const timeoutMs = options.timeoutMs ?? 20_000
  const debug = Boolean(process.env['OPENWEB_DEBUG'])
  const indexPath = indexFileFor(dir)

  const store = new Corestore(join(dir, 'gateway'))
  await store.ready()

  /**
   * The index is cached and invalidated by mtime. Reading a SQLite page is
   * cheap, but reopening it on every keystroke is not. The stamp includes the
   * WAL because a crawler in another process appends there.
   */
  let indexCache: { stamp: string; index: SqliteIndex } | null = null
  const searchCache = new Map<string, SearchResponse>()
  const SEARCH_CACHE_LIMIT = 256

  let sharedClient: SharedIndexClient | null = null

  function indexStamp(): string {
    const parts: string[] = []
    for (const file of [indexPath, `${indexPath}-wal`]) {
      try {
        const stat = statSync(file)
        parts.push(`${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push('0')
      }
    }
    return parts.join('|')
  }

  function currentIndex(): SqliteIndex {
    const stamp = indexStamp()
    if (indexCache && indexCache.stamp === stamp) return indexCache.index

    const previous = indexCache
    let index: SqliteIndex
    try {
      index = SqliteIndex.open(indexPath, { readOnly: true })
    } catch {
      try {
        const created = SqliteIndex.openOrCreate(indexPath)
        created.close()
      } catch {
        // Fall through to the empty writable index below.
      }
      index = SqliteIndex.openOrCreate(indexPath)
    }

    previous?.index.close()
    indexCache = { stamp: indexStamp(), index }
    searchCache.clear()
    if (debug) console.error(`[gateway] index opened: ${index.documentCount} document(s)`)
    return index
  }

  function searchCached(
    index: SqliteIndex,
    query: string,
    limit: number,
  ): { found: SearchResponse; cached: boolean } {
    const key = `${indexCache?.stamp ?? '0'}\u0000${limit}\u0000${query}`
    const hit = searchCache.get(key)
    if (hit) {
      searchCache.delete(key)
      searchCache.set(key, hit)
      return { found: hit, cached: true }
    }

    const found = index.search(query, limit)
    searchCache.set(key, found)
    if (searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldest = searchCache.keys().next().value
      if (oldest !== undefined) searchCache.delete(oldest)
    }
    return { found, cached: false }
  }

  function getSharedClient(): SharedIndexClient {
    sharedClient ??= new SharedIndexClient({ dir, timeoutMs })
    return sharedClient
  }

  const swarm = new Hyperswarm()
  let connected = false
  swarm.on('connection', (socket) => {
    connected = true
    if (debug) console.error('[gateway] peer connected')
    store.replicate(socket)
  })

  async function waitForPeers(ms: number): Promise<boolean> {
    if (connected) return true
    await Promise.race([
      swarm.flush().catch(() => undefined),
      delay(ms),
    ])
    return connected
  }

  async function waitForMetadata(drive: Hyperdrive, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const core = drive.core as unknown as { length: number; contiguousLength: number }
      if (core.length > 0 && core.contiguousLength >= core.length) return
      await delay(50)
    }
  }

  const drives = new Map<string, Hyperdrive>()
  const joined = new Set<string>()

  async function driveFor(address: string): Promise<Hyperdrive> {
    const key = decodeAddress(address)
    const id = Buffer.from(key).toString('hex')
    const cached = drives.get(id)
    if (cached) return cached

    const drive = new Hyperdrive(store, key)
    await drive.ready()

    if (!joined.has(id)) {
      joined.add(id)
      swarm.join(drive.discoveryKey)
      const found = await waitForPeers(Math.min(timeoutMs, 5_000))
      if (debug) console.error(`[gateway] ${id.slice(0, 8)} peer ${found ? 'found' : 'timed out'}`)
      if (found) await waitForMetadata(drive, Math.min(timeoutMs, 5_000))
    }

    drives.set(id, drive)
    return drive
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      // --- installable shell -------------------------------------------------
      if (url.pathname === '/manifest.webmanifest') {
        send(response, 200, 'application/manifest+json; charset=utf-8', JSON.stringify(WEB_MANIFEST), {
          'cache-control': 'public, max-age=3600',
        })
        return
      }
      if (url.pathname === '/sw.js') {
        send(response, 200, 'application/javascript; charset=utf-8', SERVICE_WORKER, {
          'cache-control': 'no-store',
        })
        return
      }
      if (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png') {
        const size = url.pathname.includes('192') ? 192 : 512
        sendBuffer(response, 200, 'image/png', iconPng(size), {
          'cache-control': 'public, max-age=3600',
        })
        return
      }

      // --- the address bar ---------------------------------------------------
      if (url.pathname === '/open') {
        const target = resolveAddressInput(url.searchParams.get('to') ?? '')
        if (!target) {
          send(
            response,
            400,
            'text/html; charset=utf-8',
            messagePage(
              'Not an address',
              'An OpenWeb address looks like <code>ow1</code> followed by 52 base32 characters. Paste a key or a full <code>openweb://</code> link.',
            ),
            { 'cache-control': 'no-store' },
          )
          return
        }
        response.writeHead(302, { location: target, 'cache-control': 'no-store' })
        response.end()
        return
      }

      // --- sites -------------------------------------------------------------
      if (url.pathname === '/sites') {
        const index = currentIndex()
        const address = url.searchParams.get('address') ?? ''
        const pages = address && isAddress(address) ? index.pagesFor(address) : null
        send(
          response,
          200,
          'text/html; charset=utf-8',
          pages ? siteDetailPage(address, pages, index) : sitesPage(index),
          { 'cache-control': 'no-store' },
        )
        return
      }

      // --- search ------------------------------------------------------------
      if (url.pathname === '/search') {
        const query = url.searchParams.get('q') ?? ''
        const index = currentIndex()
        const started = performance.now()
        const { found, cached } = searchCached(index, query, 20)
        const tookMs = performance.now() - started

        if (url.searchParams.get('format') === 'json') {
          send(
            response,
            200,
            'application/json; charset=utf-8',
            JSON.stringify({
              query,
              cached,
              tookMs: Number(tookMs.toFixed(3)),
              total: found.total,
              indexed: index.documentCount,
              matchedTerms: found.matchedTerms,
              results: found.results.map((result) => ({
                title: result.document.title,
                address: result.document.address,
                path: result.document.path,
                url: `openweb://${result.document.address}${result.document.path}`,
                score: Number(result.score.toFixed(4)),
                snippet: result.snippet,
              })),
            }),
            { 'cache-control': 'no-store' },
          )
          return
        }

        send(
          response,
          200,
          'text/html; charset=utf-8',
          searchPage(query, found, index.documentCount, tookMs, cached),
          { 'cache-control': 'no-store' },
        )
        return
      }

      // --- signed directory --------------------------------------------------
      if (url.pathname === '/directory') {
        const remote = url.searchParams.get('address') ?? ''
        let verification: DirectoryVerification | null = null
        let signed: Signed<DirectoryDocument> | null = null
        let source = 'local'
        let sourceAddress: string | null = null
        let error = ''

        if (remote !== '') {
          if (!isAddress(remote)) {
            error = 'That is not an OpenWeb address.'
          } else {
            try {
              const fetched = await fetchDirectory(remote, { dir, timeoutMs })
              signed = fetched.signed
              verification = verifyDirectory(fetched.signed)
              source = 'remote'
              sourceAddress = remote
              await fetched.close()
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught)
            }
          }
        } else {
          try {
            signed = loadDirectory(join(dir, 'directory.json'))
            verification = verifyDirectory(signed)
          } catch {
            verification = null
          }
        }

        // The extension and other tools need the exact signed bytes, not the
        // rendered page. `signed` is passed through untouched so a client can
        // verify it without trusting this gateway.
        if (url.searchParams.get('format') === 'json') {
          const sites = verification ? mergeDirectoryEntries(verification) : []
          send(
            response,
            200,
            'application/json; charset=utf-8',
            JSON.stringify({
              source,
              address: sourceAddress,
              valid: verification?.valid ?? false,
              errors: verification?.errors ?? (error ? [error] : []),
              author: verification?.document.author ?? null,
              name: verification?.document.name ?? null,
              entries: verification?.entries.length ?? 0,
              sites: sites.map((site) => ({
                address: site.address,
                title: site.title,
                description: site.description ?? null,
                tags: site.tags ?? [],
                recommenders: site.recommenders,
              })),
              signed,
            }),
            { 'cache-control': 'no-store' },
          )
          return
        }

        let localDirectoryAddress: string | null = null
        try {
          localDirectoryAddress = readFileSync(join(dir, 'directory-address.txt'), 'utf8').trim()
        } catch {
          localDirectoryAddress = null
        }

        send(
          response,
          200,
          'text/html; charset=utf-8',
          directoryPage(verification, { source, sourceAddress, localDirectoryAddress, error }),
          { 'cache-control': 'no-store' },
        )
        return
      }

      // --- shared index ------------------------------------------------------
      if (url.pathname === '/shared') {
        const address = url.searchParams.get('address') ?? ''
        const query = url.searchParams.get('q') ?? ''

        if (address === '') {
          send(response, 200, 'text/html; charset=utf-8', sharedPage(null, null, '', null, 0, ''), {
            'cache-control': 'no-store',
          })
          return
        }
        if (!isAddress(address)) {
          send(response, 400, 'text/html; charset=utf-8', messagePage('Not an address', 'A shared index is addressed by its drive key, just like a site.'), {
            'cache-control': 'no-store',
          })
          return
        }

        const started = performance.now()
        try {
          const fetched = await getSharedClient().fetch(address)
          const found = query === '' ? null : fetched.index.search(query, 20)
          const tookMs = performance.now() - started

          if (url.searchParams.get('format') === 'json') {
            send(
              response,
              200,
              'application/json; charset=utf-8',
              JSON.stringify({
                address,
                manifest: fetched.manifest,
                query,
                tookMs: Number(tookMs.toFixed(3)),
                total: found?.total ?? 0,
                results:
                  found?.results.map((result) => ({
                    title: result.document.title,
                    address: result.document.address,
                    path: result.document.path,
                    url: `openweb://${result.document.address}${result.document.path}`,
                    score: Number(result.score.toFixed(4)),
                    snippet: result.snippet,
                  })) ?? [],
              }),
              { 'cache-control': 'no-store' },
            )
            return
          }

          send(
            response,
            200,
            'text/html; charset=utf-8',
            sharedPage(address, fetched.manifest, query, found, tookMs, ''),
            { 'cache-control': 'no-store' },
          )
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught)
          if (url.searchParams.get('format') === 'json') {
            send(response, 502, 'application/json; charset=utf-8', JSON.stringify({ error: message }))
          } else {
            send(
              response,
              502,
              'text/html; charset=utf-8',
              sharedPage(address, null, query, null, 0, message),
              { 'cache-control': 'no-store' },
            )
          }
        }
        return
      }

      // --- builder -----------------------------------------------------------
      if (url.pathname === '/builder') {
        if (request.method === 'POST') {
          const body = await readBody(request)
          const fields = Object.fromEntries(new URLSearchParams(body))
          const spec = specFromFields(fields)
          if (spec.title.trim() === '') spec.title = 'A small page'
          if (spec.tagline.trim() === '') spec.tagline = 'Written by a person, served from a computer.'
          const built = renderSite(spec)

          if (fields['download'] === '1') {
            send(response, 200, 'text/html; charset=utf-8', built.html, {
              'content-disposition': 'attachment; filename="index.html"',
              'cache-control': 'no-store',
            })
            return
          }

          send(
            response,
            200,
            'text/html; charset=utf-8',
            builderPage(spec, built.html, true),
            { 'cache-control': 'no-store' },
          )
          return
        }

        send(response, 200, 'text/html; charset=utf-8', builderPage(defaultSpec(), null, false), {
          'cache-control': 'no-store',
        })
        return
      }

      // --- pages -------------------------------------------------------------
      const segments = url.pathname.split('/').filter((segment) => segment !== '')
      if (segments.length === 0) {
        send(response, 200, 'text/html; charset=utf-8', landing(currentIndex()), {
          'cache-control': 'no-store',
        })
        return
      }

      const address = segments[0] ?? ''
      if (!isAddress(address)) {
        send(response, 400, 'text/plain; charset=utf-8', 'not an OpenWeb address\n')
        return
      }

      const sitePath = url.pathname.slice(address.length + 1) || '/'
      const drive = await driveFor(address)
      const file = await readWhenSynced(drive, sitePath, Date.now() + timeoutMs)

      let body: Uint8Array = file.body
      if (file.status === 200 && file.type.startsWith('text/html')) {
        let html = rewriteHtml(new TextDecoder().decode(body), address)

        const isCrawler = request.headers['x-openweb-crawl'] === '1'
        if (!isCrawler && wantsBrowserChrome(html)) {
          html = injectBrowserChrome(html, address, sitePath)
        }

        body = new TextEncoder().encode(html)
      }

      if (debug) console.error(`[gateway] ${address.slice(0, 8)}…${sitePath} -> ${file.status}`)

      send(response, file.status, file.type, body, {
        'x-openweb-address': address,
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; form-action 'self'",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (debug) console.error('[gateway] error: ' + message)
      const status = error instanceof URIError ? 400 : message.includes('timed out') ? 504 : 500
      send(response, status, 'text/plain; charset=utf-8', `${message}\n`)
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  // Force the empty index into existence once, so the first search and a
  // crawler in another process do not race creation.
  const warmIndex = currentIndex()
  warmIndex.search('warmup', 1)

  await listen(server, port)

  return {
    url: `http://127.0.0.1:${port}/`,
    async waitForVersion(address: string, version: number, ms = 10_000): Promise<boolean> {
      const drive = await driveFor(address)
      const current = (): number => (drive as unknown as { version: number }).version
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (current() >= version) return true
        await delay(50)
      }
      return current() >= version
    },
    indexStats() {
      const stats = currentIndex().stats()
      return { documents: stats.documents, terms: stats.terms, built: stats.built }
    },
    async close() {
      await closing(server)
      indexCache?.index.close()
      indexCache = null
      if (sharedClient) await sharedClient.close()
      await swarm.destroy()
      await store.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Root-relative links in a site assume it is served at the root. On the gateway
 * it lives at /<address>/, so rewrite them. Cross-site links written as
 * openweb://<address>/… become gateway paths.
 *
 * This runs before the browser bar is injected, so the bar's own gateway links
 * (/open, /sites, /search) are left alone.
 */
export function rewriteHtml(html: string, address: string): string {
  return html
    .replace(
      /openweb:\/\/(ow1[a-z2-7]{52})(\/[^"'<>\s]*)?/g,
      (_match, target: string, path?: string) => `/${target}${path ?? '/'}`,
    )
    .replace(
      /\b(href|src)=("|')(\/[^"']*)\2/gi,
      (whole, attribute: string, quote: string, path: string) => {
        if (/^\/ow1[a-z2-7]{52}(\/|$)/.test(path)) return whole
        // Gateway routes are not site files. Without this exception a link to
        // /builder on a published page would become /<address>/builder.
        if (isGatewayRoute(path)) return whole
        return `${attribute}=${quote}/${address}${path}${quote}`
      },
    )
}

const GATEWAY_ROUTES = new Set([
  '/',
  '/search',
  '/sites',
  '/directory',
  '/shared',
  '/builder',
  '/open',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
])

export function isGatewayRoute(path: string): boolean {
  const pathname = path.split(/[?#]/)[0] ?? path
  return GATEWAY_ROUTES.has(pathname)
}

/** A site opts into the browser bar with a meta tag; ordinary sites stay plain. */
export function wantsBrowserChrome(html: string): boolean {
  return /<meta[^>]+name=["']openweb:browser["'][^>]*>/i.test(html)
}

export function injectBrowserChrome(html: string, address: string, path: string): string {
  const chrome = `<style>${CHROME_CSS}</style>${browserBar(`${address}${path}`)}`
  const body = /<body[^>]*>/i.exec(html)
  if (!body || body.index === undefined) return chrome + html
  const at = body.index + body[0].length
  return html.slice(0, at) + chrome + html.slice(at)
}

/**
 * The address bar accepts a bare key, an openweb:// link, or a gateway path.
 * It always returns an internal path, so this cannot be used as an open
 * redirect.
 */
export function resolveAddressInput(input: string): string | null {
  const value = input.trim()
  if (value === '') return null

  const openweb = parseOpenWebUrl(value)
  if (openweb) return `/${openweb.address}${openweb.path}`

  const gateway = parseGatewayPath(value)
  if (gateway) return value

  if (isAddress(value)) return `/${value}/`

  const slash = value.indexOf('/')
  const address = slash === -1 ? value : value.slice(0, slash)
  if (!isAddress(address)) return null

  const path = slash === -1 ? '/' : value.slice(slash)
  return `/${address}${path.startsWith('/') ? path : `/${path}`}`
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': type, ...headers })
  response.end(body)
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  type: string,
  body: Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': type, 'content-length': body.length, ...headers })
  response.end(body)
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(input: string): string {
  return escapeHtml(input)
}

/* -------------------------------------------------------------------------- */
/* Browser chrome                                                             */
/* -------------------------------------------------------------------------- */

const CHROME_CSS = `
.ow-browser{position:sticky;top:0;z-index:100;background:rgba(8,8,9,.95);border-bottom:1px solid #26262a;color:#ece9e2;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;backdrop-filter:blur(12px)}
.ow-browser *{box-sizing:border-box}
.ow-browser .ow-inner{max-width:80rem;margin:0 auto;display:flex;align-items:center;gap:.45rem;padding:.45rem .8rem;flex-wrap:wrap}
.ow-browser .ow-mark{color:#ece9e2;font-size:.72rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;white-space:nowrap}
.ow-browser .ow-mark span{color:#9ae6b4}
.ow-browser form{display:flex;align-items:center;gap:.3rem;margin:0}
.ow-browser .ow-address{flex:1 1 22rem;min-width:12rem}
.ow-browser .ow-scheme{color:#6d6a64;font-size:.72rem;white-space:nowrap}
.ow-browser input{min-width:0;padding:.35rem .5rem;border:1px solid #303036;background:#121214;color:#ece9e2;font:inherit}
.ow-browser input:focus{border-color:#4f7a5f;outline:1px solid rgba(154,230,180,.25);outline-offset:0}
.ow-browser .ow-address input{flex:1}
.ow-browser .ow-search{flex:0 1 15rem}
.ow-browser .ow-search input{flex:1}
.ow-browser button{padding:.35rem .6rem;border:0;background:#ece9e2;color:#0a0a0b;font:inherit;cursor:pointer}
.ow-browser button:hover{background:#9ae6b4}
.ow-browser .ow-links{display:flex;gap:.7rem;margin-left:auto}
.ow-browser .ow-links a{color:#9a968d;font-size:.72rem;text-decoration:none;white-space:nowrap}
.ow-browser .ow-links a:hover{color:#ece9e2;text-decoration:underline;text-underline-offset:3px}
.ow-apps{position:relative;margin-left:.15rem}
.ow-apps summary{display:grid;grid-template-columns:repeat(3,4px);gap:3px;place-items:center;padding:.42rem .38rem;border:1px solid transparent;border-radius:50%;cursor:pointer;list-style:none}
.ow-apps summary::-webkit-details-marker{display:none}
.ow-apps summary:hover,.ow-apps[open] summary{background:#17171a;border-color:#26262a}
.ow-apps summary i{display:block;width:4px;height:4px;border-radius:50%;background:#9a968d}
.ow-apps[open] summary i{background:#9ae6b4}
.ow-app-panel{position:absolute;right:0;top:calc(100% + .55rem);display:grid;grid-template-columns:repeat(3,5.4rem);gap:.4rem;padding:.7rem;border:1px solid #34343a;background:#121214;box-shadow:0 18px 50px rgba(0,0,0,.55);z-index:120}
.ow-app-panel a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.35rem;min-height:4.4rem;padding:.5rem .25rem;border:1px solid transparent;color:#ece9e2;font-size:.66rem;text-align:center;text-decoration:none}
.ow-app-panel a:hover{background:#17171a;border-color:#26262a;text-decoration:none}
.ow-app-panel .ow-glyph{display:grid;place-items:center;width:1.5rem;height:1.5rem;border:1px solid #4f7a5f;color:#9ae6b4;font-size:.72rem;border-radius:2px}
@media (max-width:720px){
  .ow-browser .ow-search{flex:1 1 12rem}
  .ow-browser .ow-links{display:none}
  .ow-app-panel{grid-template-columns:repeat(3,4.6rem)}
}
`

function browserBar(location?: string): string {
  const value = location ? escapeHtml(location) : ''
  return `<div class="ow-browser" data-openweb-chrome="1">
  <div class="ow-inner">
    <a class="ow-mark" href="/" title="OpenWeb new tab">Open<span>Web</span></a>
    <form class="ow-address" action="/open" method="get">
      <span class="ow-scheme">openweb://</span>
      <input name="to" value="${value}" placeholder="ow1… or paste a key" aria-label="OpenWeb address" autocomplete="off" spellcheck="false" />
      <button type="submit">go</button>
    </form>
    <form class="ow-search" action="/search" method="get" role="search">
      <input name="q" placeholder="search" aria-label="Search OpenWeb" autocomplete="off" />
      <button type="submit">find</button>
    </form>
    <nav class="ow-links" aria-label="Browser">
      <a href="/">new tab</a>
      <a href="/sites">sites</a>
      <a href="/directory">directory</a>
    </nav>
    <details class="ow-apps">
      <summary aria-label="OpenWeb apps" title="OpenWeb apps"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></summary>
      <div class="ow-app-panel">
        <a href="/"><span class="ow-glyph">⌂</span>new tab</a>
        <a href="/search"><span class="ow-glyph">⌕</span>search</a>
        <a href="/sites"><span class="ow-glyph">▤</span>sites</a>
        <a href="/directory"><span class="ow-glyph">✓</span>directory</a>
        <a href="/shared"><span class="ow-glyph">⇄</span>shared index</a>
        <a href="/builder"><span class="ow-glyph">✎</span>builder</a>
      </div>
    </details>
  </div>
</div>`
}

/* -------------------------------------------------------------------------- */
/* Gateway pages                                                              */
/* -------------------------------------------------------------------------- */

const PAGE_CSS = `
:root{color-scheme:dark;--bg:#0a0a0b;--panel:#121214;--panel-2:#17171a;--fg:#ece9e2;--dim:#9a968d;--faint:#6d6a64;--line:#26262a;--line-2:#34343a;--accent:#9ae6b4;--accent-dim:#4f7a5f;--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(55rem 28rem at 50% -10%,#152018 0%,transparent 60%),var(--bg);color:var(--fg);font:15px/1.65 var(--mono);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
::selection{background:var(--accent);color:#07130c}
.ow-wrap{width:min(68rem,100% - 2rem);margin:0 auto}
main{padding:2.8rem 0 5rem}
.ow-kicker{margin:0;color:var(--accent);font-size:.7rem;letter-spacing:.2em;text-transform:uppercase}
.ow-h1{max-width:20ch;margin:.45rem 0 1rem;font-family:var(--serif);font-size:clamp(2.1rem,5vw,3.6rem);font-weight:400;letter-spacing:-.025em;line-height:1.04}
.ow-lede{max-width:62ch;margin:0 0 2rem;color:var(--dim)}
.ow-bigsearch{display:flex;max-width:46rem;margin:2rem 0 .7rem;gap:.5rem}
.ow-bigsearch input,.ow-open input,.ow-form input,.ow-form textarea,.ow-form select{flex:1;min-width:0;padding:.85rem 1rem;border:1px solid var(--line-2);border-radius:0;background:var(--panel);color:var(--fg);font:inherit}
.ow-form textarea{min-height:7rem;resize:vertical}
.ow-bigsearch input:focus,.ow-open input:focus,.ow-form input:focus,.ow-form textarea:focus,.ow-form select:focus{border-color:var(--accent-dim);outline:2px solid rgba(154,230,180,.18);outline-offset:1px}
.ow-bigsearch button,.ow-open button,.ow-form button{padding:.85rem 1.15rem;border:0;background:var(--accent);color:#07130c;font:inherit;font-weight:700;cursor:pointer}
.ow-bigsearch button:hover,.ow-open button:hover,.ow-form button:hover{background:#b5f0c8}
.ow-open{display:flex;max-width:46rem;margin:0 0 .6rem;gap:.5rem}
.ow-hint{margin:0;color:var(--faint);font-size:.76rem}
.ow-section{margin-top:3.4rem}
.ow-section h2{margin:0 0 .4rem;font-family:var(--serif);font-size:clamp(1.4rem,3vw,2rem);font-weight:400;letter-spacing:-.015em}
.ow-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14.5rem,1fr));gap:.8rem;margin-top:1.2rem}
.ow-card{display:block;min-height:7.5rem;padding:1rem;border:1px solid var(--line);background:linear-gradient(160deg,var(--panel-2),var(--panel));color:var(--fg);transition:border-color 120ms ease,transform 120ms ease}
.ow-card:hover{border-color:var(--accent-dim);text-decoration:none;transform:translateY(-2px)}
.ow-card strong{display:block;margin:.35rem 0;font-family:var(--serif);font-size:1.15rem;font-weight:400;line-height:1.2}
.ow-card code{display:block;color:var(--faint);font-size:.66rem;word-break:break-all}
.ow-empty{margin-top:1.2rem;padding:1.3rem;border:1px dashed var(--line-2);color:var(--dim);font-size:.86rem}
.ow-empty strong{display:block;margin-bottom:.35rem;color:var(--fg);font-family:var(--serif);font-size:1.15rem;font-weight:400}
.ow-empty code{color:var(--accent)}
.ow-site-full{padding:1.2rem 0;border-top:1px solid var(--line)}
.ow-site-full header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.ow-site-full h2{margin:.2rem 0;font-family:var(--serif);font-size:1.35rem;font-weight:400;line-height:1.2}
.ow-site-full header>code{max-width:30rem;color:var(--faint);font-size:.66rem;word-break:break-all;text-align:right}
.ow-site-full ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:0 1.2rem;margin:1rem 0 0;padding:0;list-style:none}
.ow-site-full li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--line);font-size:.8rem}
.ow-site-full li a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ow-site-full li span{color:var(--faint);font-size:.66rem;white-space:nowrap}
.ow-results{margin:1.6rem 0 0;padding:0;list-style:none}
.ow-results li{padding:1.1rem 0;border-bottom:1px solid var(--line)}
.ow-results h2{margin:0 0 .25rem;font-family:var(--serif);font-size:1.3rem;font-weight:400;line-height:1.25}
.ow-results p{margin:.3rem 0;color:var(--dim);font-size:.84rem}
.ow-results code{color:var(--faint);font-size:.66rem;word-break:break-all}
.ow-meta{margin:0 0 1.2rem;color:var(--faint);font-size:.76rem}
.ow-chips{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:1.1rem}
.ow-chips a{padding:.35rem .7rem;border:1px solid var(--line);color:var(--dim);font-size:.72rem}
.ow-chips a:hover{border-color:var(--accent-dim);color:var(--fg);text-decoration:none}
.ow-home{min-height:calc(100vh - 3.1rem);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem 1rem 4rem}
.ow-home-mark{margin:0 0 .4rem;font-family:var(--serif);font-size:clamp(2.8rem,9vw,5.6rem);font-weight:400;letter-spacing:-.045em;line-height:1}
.ow-home-mark span{color:var(--accent)}
.ow-home-kicker{margin:0 0 2.2rem;color:var(--faint);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase}
.ow-home-search{display:flex;width:min(44rem,100%);gap:.45rem;padding:.32rem .32rem .32rem 1.15rem;border:1px solid var(--line-2);border-radius:999px;background:var(--panel);align-items:center}
.ow-home-search:focus-within{border-color:var(--accent-dim);box-shadow:0 0 0 3px rgba(154,230,180,.1)}
.ow-home-search input{flex:1;min-width:0;padding:.7rem 0;border:0;background:transparent;color:var(--fg);font:inherit;outline:0}
.ow-home-search button{padding:.62rem 1.15rem;border:0;border-radius:999px;background:var(--accent);color:#07130c;font:inherit;font-weight:700;cursor:pointer}
.ow-home-search button:hover{background:#b5f0c8}
.ow-home-note{margin:1rem 0 0;color:var(--faint);font-size:.72rem}
.ow-home-sites{display:flex;flex-wrap:wrap;justify-content:center;gap:.4rem 1.1rem;margin-top:2.6rem;max-width:48rem}
.ow-home-sites a{color:var(--dim);font-size:.76rem}
.ow-home-sites a:hover{color:var(--fg)}
.ow-foot{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--line);color:var(--faint);font-size:.74rem}
.ow-foot strong{color:var(--dim);font-weight:500}
.ow-form{display:grid;gap:.7rem;max-width:48rem;margin-top:1.4rem}
.ow-form label{display:grid;gap:.25rem;color:var(--dim);font-size:.76rem}
.ow-form fieldset{display:grid;gap:.6rem;margin:0;padding:.9rem;border:1px solid var(--line)}
.ow-form legend{padding:0 .4rem;color:var(--faint);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase}
.ow-form .ow-row{display:flex;gap:.6rem;flex-wrap:wrap}
.ow-preview{width:100%;height:34rem;margin-top:1.2rem;border:1px solid var(--line);background:#0a0a0b}
.ow-tag{display:inline-block;margin-right:.4rem;padding:.1rem .4rem;border:1px solid var(--line-2);color:var(--faint);font-size:.66rem}
.ow-error{padding:.8rem 1rem;border:1px solid #7a3b45;background:rgba(122,59,69,.12);color:#f0b8c0;font-size:.82rem}
@media (max-width:720px){
  .ow-bigsearch,.ow-open{flex-direction:column}
  .ow-bigsearch button,.ow-open button{width:100%}
  .ow-site-full header>code{text-align:left}
}
`

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — OpenWeb</title>
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0a0a0b" />
<style>${CHROME_CSS}${PAGE_CSS}</style>
<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});</script>
</head>
<body>
${browserBar()}
${body}
</body>
</html>
`
}

function landing(index: SqliteIndex): string {
  const stats = index.stats()
  const sites = index.listSites(8)
  const siteLinks =
    sites.length === 0
      ? `<p class="ow-home-note">Nothing crawled yet. Publish a folder with <code>openweb serve app</code>, then <code>openweb crawl &lt;address&gt;</code>.</p>`
      : `<div class="ow-home-sites">${sites
          .map(
            (site) =>
              `<a href="/${site.address}/" title="${escapeHtml(site.address)}">${escapeHtml(site.title)}</a>`,
          )
          .join('')}</div>`

  return page(
    'New tab',
    `<main class="ow-home">
  <p class="ow-home-mark">Open<span>Web</span></p>
  <p class="ow-home-kicker">${stats.documents.toLocaleString()} pages on this machine · no query leaves it</p>
  <form class="ow-home-search" action="/search" method="get" role="search">
    <input name="q" placeholder="search the local web…" aria-label="Search OpenWeb" autocomplete="off" autofocus />
    <button type="submit">search</button>
  </form>
  <p class="ow-home-note">or paste an address into the bar above · <a href="/builder">build a page</a> · <a href="/directory">signed directory</a> · <a href="/shared">shared index</a></p>
  ${siteLinks}
</main>`,
  )
}

function siteCard(site: SiteSummary): string {
  return `<a class="ow-card" href="/sites?address=${site.address}">
  <p class="ow-kicker">${site.pages} page${site.pages === 1 ? '' : 's'}</p>
  <strong>${escapeHtml(site.title)}</strong>
  <code>${escapeHtml(site.address)}</code>
</a>`
}

function sitesPage(index: SqliteIndex): string {
  const sites = index.listSites(500)
  const body =
    sites.length === 0
      ? `<div class="ow-empty">
  <strong>No sites yet.</strong>
  Run <code>openweb crawl &lt;address&gt;</code> with a gateway running, then come back.
</div>`
      : `<div class="ow-grid">${sites.map(siteCard).join('')}</div>`

  return page(
    'Sites',
    `<main class="ow-wrap">
  <p class="ow-kicker">Directory · ${sites.length} site(s) · ${index.documentCount.toLocaleString()} page(s)</p>
  <h1 class="ow-h1">Everything this machine has read.</h1>
  <p class="ow-lede">Grouped by address, because a site is a key. Anybody can run a crawler; this is the list yours found.</p>
  ${body}
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — a directory of what you chose to crawl.</footer>
</main>`,
  )
}

function siteDetailPage(address: string, pages: PageSummary[], index: SqliteIndex): string {
  return page(
    'Site',
    `<main class="ow-wrap">
  <p class="ow-kicker">Site · ${pages.length} page(s)</p>
  <h1 class="ow-h1">${escapeHtml(pages[0]?.title ?? address)}</h1>
  <p class="ow-meta"><code>${escapeHtml(address)}</code></p>
  <ul class="ow-results">
    ${pages
      .map(
        (page) =>
          `<li><h2><a href="/${address}${escapeHtml(page.path)}">${escapeHtml(page.title)}</a></h2><code>${escapeHtml(page.path)}</code></li>`,
      )
      .join('\n')}
  </ul>
  <p class="ow-hint" style="margin-top:1.5rem">${index.documentCount.toLocaleString()} page(s) in the local index. <a href="/sites">← all sites</a></p>
</main>`,
  )
}

function searchPage(
  query: string,
  found: SearchResponse,
  documentCount: number,
  tookMs: number,
  cached: boolean,
): string {
  const rows =
    found.results.length === 0
      ? `<p class="ow-empty">No results for <strong>${escapeHtml(query)}</strong>. Try fewer words, a different spelling, or crawl another site into the index.</p>`
      : `<ol class="ow-results">${found.results
          .map(
            (result) => `<li>
  <h2><a href="/${result.document.address}${escapeHtml(result.document.path)}">${escapeHtml(result.document.title)}</a></h2>
  <p>${escapeHtml(result.snippet)}</p>
  <code>${escapeHtml(result.document.address)}${escapeHtml(result.document.path)}</code>
</li>`,
          )
          .join('\n')}</ol>`

  return page(
    'Search',
    `<main class="ow-wrap">
  <p class="ow-kicker">Search · local index</p>
  <h1 class="ow-h1">${query === '' ? 'Search the pages this machine has read.' : 'Results for your words.'}</h1>
  <form class="ow-bigsearch" action="/search" method="get" role="search">
    <input name="q" value="${escapeHtml(query)}" aria-label="Search OpenWeb" autocomplete="off" autofocus />
    <button type="submit">search</button>
  </form>
  <p class="ow-meta">${found.total} result(s) from ${documentCount.toLocaleString()} indexed page(s) in ${tookMs.toFixed(2)} ms${cached ? ' (cached)' : ''} — fuzzy words and synonyms are tried when an exact word is missing</p>
  ${rows}
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — <a href="/sites">browse the indexed sites</a>. The index is a SQLite file on this computer.</footer>
</main>`,
  )
}

interface DirectoryPageOptions {
  source: string
  sourceAddress: string | null
  localDirectoryAddress: string | null
  error: string
}

function directoryPage(
  verification: DirectoryVerification | null,
  options: DirectoryPageOptions,
): string {
  const sites = verification ? mergeDirectoryEntries(verification) : []
  const entries = verification?.entries.length ?? 0
  const cards =
    sites.length === 0
      ? `<div class="ow-empty">
  <strong>No signed entries yet.</strong>
  Create an identity and a directory with <code>openweb directory init</code>, then add a site with <code>openweb directory add &lt;address&gt;</code>.
</div>`
      : `<div class="ow-grid">${sites
          .map(
            (site) => `<a class="ow-card" href="/${site.address}/">
  <p class="ow-kicker">${site.tags?.join(' · ') || 'recommended'}</p>
  <strong>${escapeHtml(site.title)}</strong>
  ${site.description ? `<p class="ow-hint">${escapeHtml(site.description)}</p>` : ''}
  <code>${site.recommenders.length} signature${site.recommenders.length === 1 ? '' : 's'} · ${escapeHtml(site.address)}</code>
</a>`,
          )
          .join('')}</div>`

  const status = verification
    ? verification.valid
      ? `<p class="ow-meta">✓ signatures verified · ${entries} entry/entries · ${options.source}${options.sourceAddress ? ` · <code>${escapeHtml(options.sourceAddress)}</code>` : ''}</p>`
      : `<p class="ow-error">This directory failed verification: ${escapeHtml(verification.errors.join('; '))}</p>`
    : ''

  return page(
    'Directory',
    `<main class="ow-wrap">
  <p class="ow-kicker">Signed directory</p>
  <h1 class="ow-h1">A list a human signed.</h1>
  <p class="ow-lede">Every entry carries the key of the person who added it. No registry, no allow-once button: a mirror can repeat this list or refuse it, but it cannot quietly edit it.</p>
  ${options.error ? `<p class="ow-error">${escapeHtml(options.error)}</p>` : ''}
  ${status}
  ${cards}
  <section class="ow-section">
    <p class="ow-kicker">Load another directory</p>
    <p class="ow-lede">Paste the address of a published directory drive. It is fetched over the DHT and verified locally.</p>
    <form class="ow-open" action="/directory" method="get">
      <input name="address" placeholder="ow1… directory drive address" aria-label="Directory address" autocomplete="off" spellcheck="false" />
      <button type="submit">verify &amp; load</button>
    </form>
    <p class="ow-hint">Local author identity: <code>${verification ? escapeHtml(verification.document.author) : 'not initialised'}</code>${options.localDirectoryAddress ? ` · published at <code>${escapeHtml(options.localDirectoryAddress)}</code>` : ''}</p>
  </section>
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — signatures are checked before a link is rendered.</footer>
</main>`,
  )
}

function sharedPage(
  address: string | null,
  manifest: IndexManifest | null,
  query: string,
  found: SearchResponse | null,
  tookMs: number,
  error: string,
): string {
  const results =
    found === null
      ? ''
      : found.results.length === 0
        ? `<p class="ow-empty">No results for <strong>${escapeHtml(query)}</strong> in this shared index.</p>`
        : `<ol class="ow-results">${found.results
            .map(
              (result) => `<li>
  <h2><a href="/${result.document.address}${escapeHtml(result.document.path)}">${escapeHtml(result.document.title)}</a></h2>
  <p>${escapeHtml(result.snippet)}</p>
  <code>${escapeHtml(result.document.address)}${escapeHtml(result.document.path)}</code>
</li>`,
            )
            .join('\n')}</ol>`

  const info =
    manifest === null
      ? ''
      : `<p class="ow-meta">${manifest.documents.toLocaleString()} pages · ${manifest.terms.toLocaleString()} terms · ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB · sha256 <code>${escapeHtml(manifest.sha256.slice(0, 16))}…</code>${found ? ` · ${found.total} result(s) in ${tookMs.toFixed(2)} ms` : ''}</p>`

  return page(
    'Shared index',
    `<main class="ow-wrap">
  <p class="ow-kicker">Peer-published index</p>
  <h1 class="ow-h1">Query somebody else's crawl.</h1>
  <p class="ow-lede">A shared index is a Hyperdrive containing a verified SQLite snapshot. Fetch it once, query it locally, and skip the crawling.</p>
  ${error ? `<p class="ow-error">${escapeHtml(error)}</p>` : ''}
  <form class="ow-open" action="/shared" method="get" style="margin-top:1.4rem">
    <input name="address" value="${address ? escapeHtml(address) : ''}" placeholder="ow1… index drive address" aria-label="Shared index address" autocomplete="off" spellcheck="false" />
    <input name="q" value="${escapeHtml(query)}" placeholder="words" aria-label="Search the shared index" autocomplete="off" />
    <button type="submit">query</button>
  </form>
  ${info}
  ${results}
  <section class="ow-section">
    <p class="ow-kicker">Publish yours</p>
    <p class="ow-lede">Snapshot the local index into a drive and stay online. Anyone with the address can query it without crawling.</p>
    <pre><code>openweb index publish
openweb index query &lt;address&gt; "slow garden"</code></pre>
  </section>
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — a shared index is verified by SHA-256 before it is opened.</footer>
</main>`,
  )
}

function builderPage(spec: SiteSpec, preview: string | null, generated: boolean): string {
  const sections = Array.from({ length: 3 }, (_, index) => spec.sections?.[index])
  const links = Array.from({ length: 2 }, (_, index) => spec.links?.[index])

  const sectionFields = sections
    .map(
      (section, index) => `<fieldset>
  <legend>Section ${index + 1}</legend>
  <label>Heading <input name="section${index + 1}Heading" value="${escapeAttribute(section?.heading ?? '')}" /></label>
  <label>Text <textarea name="section${index + 1}Body">${escapeHtml(section?.body ?? '')}</textarea></label>
</fieldset>`,
    )
    .join('\n')

  const linkFields = links
    .map(
      (link, index) => `<div class="ow-row">
  <label style="flex:1">Link ${index + 1} label <input name="link${index + 1}Label" value="${escapeAttribute(link?.label ?? '')}" /></label>
  <label style="flex:2">URL <input name="link${index + 1}Url" value="${escapeAttribute(link?.url ?? '')}" /></label>
</div>`,
    )
    .join('\n')

  const hidden = generated
    ? `<form method="post" action="/builder" style="margin-top:.7rem">
  ${hiddenFields(spec)}
  <input type="hidden" name="download" value="1" />
  <button type="submit">download index.html</button>
</form>`
    : ''

  return page(
    'Builder',
    `<main class="ow-wrap">
  <p class="ow-kicker">Website builder · static, signed, yours</p>
  <h1 class="ow-h1">Make a page without a framework.</h1>
  <p class="ow-lede">Fill this in, download one HTML file, and publish the folder with <code>openweb serve</code>. No account, no scripts, no build step.</p>
  ${generated ? `<p class="ow-meta">Preview below. The file is self-contained; links starting with <code>/</code> are resolved by the gateway.</p>` : ''}
  ${preview ? `<iframe class="ow-preview" sandbox title="Generated page preview" srcdoc="${escapeAttribute(preview)}"></iframe>${hidden}` : ''}
  <form class="ow-form" method="post" action="/builder">
    <label>Title <input name="title" value="${escapeAttribute(spec.title)}" required /></label>
    <label>Tagline <input name="tagline" value="${escapeAttribute(spec.tagline)}" required /></label>
    <label>Intro <textarea name="description">${escapeHtml(spec.description ?? '')}</textarea></label>
    <label>Your name <input name="author" value="${escapeAttribute(spec.author ?? '')}" /></label>
    <label>Theme
      <select name="theme">
        <option value="forest"${spec.theme !== 'paper' ? ' selected' : ''}>forest (dark green)</option>
        <option value="paper"${spec.theme === 'paper' ? ' selected' : ''}>paper (warm light)</option>
      </select>
    </label>
    ${sectionFields}
    ${linkFields}
    <div class="ow-row">
      <button type="submit">preview</button>
      <button type="submit" name="download" value="1">download index.html</button>
    </div>
  </form>
  <p class="ow-hint" style="margin-top:1rem">Prefer the terminal? <code>openweb new my-site --title "My page"</code></p>
  <footer class="ow-foot"><strong>OpenWeb builder</strong> — one file, no JavaScript, nothing fetched from somebody else's server.</footer>
</main>`,
  )
}

function hiddenFields(spec: SiteSpec): string {
  const fields: Array<[string, string]> = [
    ['title', spec.title],
    ['tagline', spec.tagline],
    ['description', spec.description ?? ''],
    ['author', spec.author ?? ''],
    ['theme', spec.theme ?? 'forest'],
  ]
  for (let i = 0; i < 3; i++) {
    fields.push([`section${i + 1}Heading`, spec.sections?.[i]?.heading ?? ''])
    fields.push([`section${i + 1}Body`, spec.sections?.[i]?.body ?? ''])
  }
  for (let i = 0; i < 2; i++) {
    fields.push([`link${i + 1}Label`, spec.links?.[i]?.label ?? ''])
    fields.push([`link${i + 1}Url`, spec.links?.[i]?.url ?? ''])
  }
  return fields
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}" />`,
    )
    .join('\n  ')
}

function messagePage(title: string, message: string): string {
  return page(
    title,
    `<main class="ow-wrap">
  <p class="ow-kicker">OpenWeb</p>
  <h1 class="ow-h1">${escapeHtml(title)}.</h1>
  <p class="ow-lede">${message}</p>
  <p><a href="/">← back to the new tab</a></p>
</main>`,
  )
}

/**
 * The first read after a connection can race the metadata sync: locally the
 * drive is still empty, so a lookup answers "not found" instead of waiting.
 * Retry only while the drive has never synced — once it has a length, a 404
 * is the site's actual answer.
 */
async function readWhenSynced(
  drive: Hyperdrive,
  path: string,
  deadline: number,
): Promise<Awaited<ReturnType<typeof readFromDrive>>> {
  for (;;) {
    const remaining = deadline - Date.now()
    const slice = Math.min(Math.max(remaining, 1), 3_000)
    const file = await withTimeout(readFromDrive(drive, path, { timeout: slice }), slice + 500)
    if (file.status !== 404) return file

    let exists = false
    try {
      exists = (await drive.entry(drivePathFor(path), { timeout: slice })) !== null
    } catch {
      exists = false
    }
    if (!exists) return file
    if (Date.now() >= deadline) return file

    await delay(200)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a peer')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolvePromise())
  })
}

function closing(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}
