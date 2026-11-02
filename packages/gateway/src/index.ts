/**
 * The gateway: how a normal browser reads OpenWeb.
 *
 *   GET /                      the new-tab page (search + crawled sites)
 *   GET /<address>/<path>      fetch a page from a peer
 *   GET /search?q=…            search the local index
 *   GET /sites                 every site this machine has crawled
 *   GET /open?to=…             the address bar: resolve an address and redirect
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
  parseGatewayPath,
  parseOpenWebUrl,
  readFromDrive,
} from '@openweb/core'
import { emptyIndex, loadIndex, search, type IndexFile, type SearchResponse } from '@openweb/index'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'

export const DEFAULT_GATEWAY_DIR = '.openweb'
export const DEFAULT_GATEWAY_PORT = 8080

export interface GatewayOptions {
  /** Where gateway state and index.json live. */
  dir?: string
  port?: number
  /** How long to wait for a peer before giving up. */
  timeoutMs?: number
}

export interface Gateway {
  url: string
  /** Wait until the read-only drive has caught up to a published version. */
  waitForVersion(address: string, version: number, timeoutMs?: number): Promise<boolean>
  close(): Promise<void>
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const dir = resolve(options.dir ?? DEFAULT_GATEWAY_DIR)
  const port = options.port ?? DEFAULT_GATEWAY_PORT
  const timeoutMs = options.timeoutMs ?? 20_000
  const debug = Boolean(process.env['OPENWEB_DEBUG'])

  const store = new Corestore(join(dir, 'gateway'))
  await store.ready()

  /**
   * The index is cached and invalidated by mtime. Re-parsing a JSON file on
   * every keystroke was the slowest part of searching before.
   */
  let indexCache: { mtimeMs: number; index: IndexFile } | null = null

  /** Recent queries, keyed by index version too, so an edit invalidates them. */
  const SEARCH_CACHE_LIMIT = 256
  const searchCache = new Map<string, SearchResponse>()

  function currentIndex(): IndexFile {
    try {
      const mtimeMs = statSync(join(dir, 'index.json')).mtimeMs
      if (!indexCache || indexCache.mtimeMs !== mtimeMs) {
        indexCache = { mtimeMs, index: loadIndex(join(dir, 'index.json')) }
        searchCache.clear()
      }
      return indexCache.index
    } catch {
      return indexCache?.index ?? emptyIndex()
    }
  }

  function searchCached(
    index: IndexFile,
    query: string,
    limit: number,
  ): { found: SearchResponse; cached: boolean } {
    const key = `${indexCache?.mtimeMs ?? 0}\u0000${limit}\u0000${query}`
    const hit = searchCache.get(key)
    if (hit) {
      // Refresh recency: Map iteration order is insertion order.
      searchCache.delete(key)
      searchCache.set(key, hit)
      return { found: hit, cached: true }
    }

    const found = search(index, query, limit)
    searchCache.set(key, found)
    if (searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldest = searchCache.keys().next().value
      if (oldest !== undefined) searchCache.delete(oldest)
    }
    return { found, cached: false }
  }

  const swarm = new Hyperswarm()
  let connected = false

  swarm.on('connection', (socket) => {
    connected = true
    if (debug) console.error('[gateway] peer connected')
    store.replicate(socket)
  })

  /** Discovery is async. Reading before any peer exists answers "not found". */
  async function waitForPeers(ms: number): Promise<boolean> {
    if (connected) return true
    await Promise.race([
      swarm.flush().catch(() => undefined),
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)),
    ])
    return connected
  }

  /**
   * Hypercore reports `length` as the signed tree size and `contiguousLength`
   * as the part actually downloaded. The first read needs both to agree, or
   * every entry looks missing while the tree is still arriving.
   */
  async function waitForMetadata(drive: Hyperdrive, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      // The bundled types expose `length` only; the runtime core also has
      // `contiguousLength`, which is the part actually downloaded.
      const core = drive.core as unknown as { length: number; contiguousLength: number }
      if (core.length > 0 && core.contiguousLength >= core.length) return
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }

  const drives = new Map<string, Hyperdrive>()
  const joined = new Set<string>()

  async function driveFor(address: string): Promise<Hyperdrive> {
    const key = decodeAddress(address)
    const id = Buffer.from(key).toString('hex')

    const cached = drives.get(id)
    if (cached) return cached

    // Read-only: we have the public key, not the secret.
    const drive = new Hyperdrive(store, key)
    await drive.ready()

    if (!joined.has(id)) {
      joined.add(id)
      swarm.join(drive.discoveryKey)
      const found = await waitForPeers(Math.min(timeoutMs, 5_000))
      if (debug) console.error(`[gateway] ${id.slice(0, 8)} peer ${found ? 'found' : 'timed out'}`)

      // A peer answering the topic does not mean the metadata has arrived.
      // Reading during that gap looks exactly like a 404, so wait for the
      // first full metadata view before answering the first request.
      if (found) await waitForMetadata(drive, Math.min(timeoutMs, 5_000))
    }

    drives.set(id, drive)
    return drive
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

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

      if (url.pathname === '/sites') {
        send(response, 200, 'text/html; charset=utf-8', sitesPage(currentIndex()), {
          'cache-control': 'no-store',
        })
        return
      }

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
              indexed: index.documents.length,
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
          searchPage(query, found, index.documents.length, tookMs, cached),
          { 'cache-control': 'no-store' },
        )
        return
      }

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

        // The site chooses whether it wants the browser bar. The crawler asks
        // for the page without it, so chrome text never enters the index.
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

  // Parse the index once at startup. A 20k-page index is tens of megabytes;
  // doing that inside the first search made the first search take over a second.
  const warmIndex = currentIndex()
  const warmTerm = Object.keys(warmIndex.postings)[0]
  if (warmTerm) searchCached(warmIndex, warmTerm, 20)

  await listen(server, port)

  return {
    url: `http://127.0.0.1:${port}/`,
    async waitForVersion(address: string, version: number, ms = 10_000): Promise<boolean> {
      const drive = await driveFor(address)
      const current = (): number => (drive as unknown as { version: number }).version
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (current() >= version) return true
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      }
      return current() >= version
    },
    async close() {
      await closing(server)
      await swarm.destroy()
      await store.close()
    },
  }
}

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
        return `${attribute}=${quote}/${address}${path}${quote}`
      },
    )
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

interface SiteSummary {
  address: string
  pages: Array<{ title: string; path: string }>
}

function groupSites(index: IndexFile): SiteSummary[] {
  const sites = new Map<string, SiteSummary>()
  for (const document of index.documents) {
    let site = sites.get(document.address)
    if (!site) {
      site = { address: document.address, pages: [] }
      sites.set(document.address, site)
    }
    site.pages.push({ title: document.title, path: document.path })
  }

  return [...sites.values()].sort(
    (a, b) => b.pages.length - a.pages.length || a.address.localeCompare(b.address),
  )
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* -------------------------------------------------------------------------- */
/* Browser chrome                                                             */
/* -------------------------------------------------------------------------- */

const CHROME_CSS = `
.ow-browser{position:sticky;top:0;z-index:100;background:rgba(8,8,9,.95);border-bottom:1px solid #26262a;color:#ece9e2;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;backdrop-filter:blur(12px)}
.ow-browser *{box-sizing:border-box}
.ow-browser .ow-inner{max-width:76rem;margin:0 auto;display:flex;align-items:center;gap:.45rem;padding:.45rem .8rem;flex-wrap:wrap}
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
@media (max-width:720px){
  .ow-browser .ow-search{flex:1 1 12rem}
  .ow-browser .ow-links{margin-left:0}
}
`

function browserBar(location?: string): string {
  const value = location ? escapeHtml(location) : ''
  return `<div class="ow-browser" data-openweb-chrome="1">
  <div class="ow-inner">
    <a class="ow-mark" href="/" title="OpenWeb new tab">Open<span>Web</span></a>
    <form class="ow-address" action="/open" method="get">
      <span class="ow-scheme">openweb://</span>
      <input name="to" value="${value}" placeholder="${addressPlaceholder()}" aria-label="OpenWeb address" autocomplete="off" spellcheck="false" />
      <button type="submit">go</button>
    </form>
    <form class="ow-search" action="/search" method="get" role="search">
      <input name="q" placeholder="search" aria-label="Search OpenWeb" autocomplete="off" />
      <button type="submit">find</button>
    </form>
    <nav class="ow-links" aria-label="Browser">
      <a href="/">new tab</a>
      <a href="/sites">sites</a>
    </nav>
  </div>
</div>`
}

function addressPlaceholder(): string {
  return 'ow1… or paste a key'
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
.ow-wrap{width:min(66rem,100% - 2rem);margin:0 auto}
main{padding:3.5rem 0 5rem}
.ow-kicker{margin:0;color:var(--accent);font-size:.7rem;letter-spacing:.2em;text-transform:uppercase}
.ow-h1{max-width:18ch;margin:.45rem 0 1rem;font-family:var(--serif);font-size:clamp(2.2rem,5.2vw,3.9rem);font-weight:400;letter-spacing:-.025em;line-height:1.03}
.ow-lede{max-width:62ch;margin:0 0 2rem;color:var(--dim)}
.ow-bigsearch{display:flex;max-width:46rem;margin:2rem 0 .7rem;gap:.5rem}
.ow-bigsearch input,.ow-open input{flex:1;min-width:0;padding:.9rem 1rem;border:1px solid var(--line-2);border-radius:0;background:var(--panel);color:var(--fg);font:inherit}
.ow-bigsearch input:focus,.ow-open input:focus{border-color:var(--accent-dim);outline:2px solid rgba(154,230,180,.18);outline-offset:1px}
.ow-bigsearch button,.ow-open button{padding:.9rem 1.2rem;border:0;background:var(--accent);color:#07130c;font:inherit;font-weight:700;cursor:pointer}
.ow-bigsearch button:hover,.ow-open button:hover{background:#b5f0c8}
.ow-open{display:flex;max-width:46rem;margin:0 0 .6rem;gap:.5rem}
.ow-hint{margin:0;color:var(--faint);font-size:.76rem}
.ow-section{margin-top:3.8rem}
.ow-section h2{margin:0 0 .4rem;font-family:var(--serif);font-size:clamp(1.5rem,3vw,2.2rem);font-weight:400;letter-spacing:-.015em}
.ow-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14.5rem,1fr));gap:.8rem;margin-top:1.3rem}
.ow-card{display:block;min-height:8.5rem;padding:1rem;border:1px solid var(--line);background:linear-gradient(160deg,var(--panel-2),var(--panel));color:var(--fg);transition:border-color 120ms ease,transform 120ms ease}
.ow-card:hover{border-color:var(--accent-dim);text-decoration:none;transform:translateY(-2px)}
.ow-card strong{display:block;margin:.4rem 0;font-family:var(--serif);font-size:1.2rem;font-weight:400;line-height:1.2}
.ow-card code{display:block;color:var(--faint);font-size:.68rem;word-break:break-all}
.ow-empty{margin-top:1.3rem;padding:1.4rem;border:1px dashed var(--line-2);color:var(--dim);font-size:.86rem}
.ow-empty strong{display:block;margin-bottom:.35rem;color:var(--fg);font-family:var(--serif);font-size:1.2rem;font-weight:400}
.ow-empty code{color:var(--accent)}
.ow-site-full{padding:1.5rem 0;border-top:1px solid var(--line)}
.ow-site-full header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.ow-site-full h2{margin:.2rem 0;font-family:var(--serif);font-size:1.45rem;font-weight:400;line-height:1.2}
.ow-site-full header>code{max-width:30rem;color:var(--faint);font-size:.68rem;word-break:break-all;text-align:right}
.ow-site-full ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:0 1.2rem;margin:1rem 0 0;padding:0;list-style:none}
.ow-site-full li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--line);font-size:.82rem}
.ow-site-full li a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ow-site-full li span{color:var(--faint);font-size:.68rem;white-space:nowrap}
.ow-results{margin:2rem 0 0;padding:0;list-style:none}
.ow-results li{padding:1.3rem 0;border-bottom:1px solid var(--line)}
.ow-results h2{margin:0 0 .3rem;font-family:var(--serif);font-size:1.4rem;font-weight:400;line-height:1.25}
.ow-results p{margin:.35rem 0;color:var(--dim);font-size:.88rem}
.ow-results code{color:var(--faint);font-size:.68rem;word-break:break-all}
.ow-meta{margin:0 0 1.5rem;color:var(--faint);font-size:.78rem}
.ow-foot{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--line);color:var(--faint);font-size:.74rem}
.ow-foot strong{color:var(--dim);font-weight:500}
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
<style>${CHROME_CSS}${PAGE_CSS}</style>
</head>
<body>
${browserBar()}
${body}
</body>
</html>
`
}

function landing(index: IndexFile): string {
  const sites = groupSites(index)
  const indexed = index.documents.length
  const cards =
    sites.length === 0
      ? `<div class="ow-empty">
  <strong>Nothing crawled yet.</strong>
  Publish a folder with <code>openweb serve app</code>, then crawl its address:
  <code>openweb crawl &lt;address&gt;</code>. Sites you index appear here.
</div>`
      : `<div class="ow-grid">${sites.map(siteCard).join('')}</div>`

  return page(
    'New tab',
    `<main class="ow-wrap">
  <p class="ow-kicker">New tab · ${indexed.toLocaleString()} page(s) indexed</p>
  <h1 class="ow-h1">The browser is the internet.</h1>
  <p class="ow-lede">
    Search the index on this machine, or open any OpenWeb address. Every result
    is a signed page served by a peer. Nothing here is ranked by clicks, and no
    query leaves this computer.
  </p>

  <form class="ow-bigsearch" action="/search" method="get" role="search">
    <input name="q" placeholder="search the pages this machine has read…" aria-label="Search OpenWeb" autocomplete="off" autofocus />
    <button type="submit">search</button>
  </form>
  <form class="ow-open" action="/open" method="get">
    <input name="to" placeholder="openweb://ow1… or just paste a key" aria-label="Open an OpenWeb address" autocomplete="off" spellcheck="false" />
    <button type="submit">open address</button>
  </form>
  <p class="ow-hint">No cookies. No accounts. No scripts added to pages. The gateway is only a bridge.</p>

  <section class="ow-section">
    <p class="ow-kicker">On this machine</p>
    <h2>Sites you have read.</h2>
    <p class="ow-lede">Coverage is exactly what you crawled. There is no global index.</p>
    ${cards}
    <p class="ow-hint" style="margin-top:1rem"><a href="/sites">See every indexed page →</a></p>
  </section>

  <section class="ow-section">
    <p class="ow-kicker">One site, connected</p>
    <h2>Publish, crawl, search.</h2>
    <div class="ow-grid">
      <a class="ow-card" href="/sites">
        <p class="ow-kicker">Directory</p>
        <strong>Sites this machine knows</strong>
        <code>every crawled address, grouped</code>
      </a>
      <a class="ow-card" href="/search">
        <p class="ow-kicker">Engine</p>
        <strong>Search the local index</strong>
        <code>BM25, phrases, negation, title:</code>
      </a>
      <div class="ow-card">
        <p class="ow-kicker">Address bar</p>
        <strong>Open a key</strong>
        <code>ow1… resolves with no registry</code>
      </div>
    </div>
  </section>

  <footer class="ow-foot">
    <strong>OpenWeb gateway</strong> — it does not crawl on its own, does not log visitors, and does not add scripts to pages.
  </footer>
</main>`,
  )
}

function siteCard(site: SiteSummary): string {
  const title = site.pages[0]?.title ?? site.address
  const count = site.pages.length
  return `<a class="ow-card" href="/${site.address}/">
  <p class="ow-kicker">${count} page${count === 1 ? '' : 's'}</p>
  <strong>${escapeHtml(title)}</strong>
  <code>${escapeHtml(site.address)}</code>
</a>`
}

function sitesPage(index: IndexFile): string {
  const sites = groupSites(index)
  const body =
    sites.length === 0
      ? `<div class="ow-empty">
  <strong>No sites yet.</strong>
  Run <code>openweb crawl &lt;address&gt;</code> with a gateway running, then come back.
</div>`
      : sites
          .map(
            (site) => `<article class="ow-site-full">
  <header>
    <div>
      <p class="ow-kicker">${site.pages.length} page${site.pages.length === 1 ? '' : 's'}</p>
      <h2><a href="/${site.address}/">${escapeHtml(site.pages[0]?.title ?? site.address)}</a></h2>
    </div>
    <code>${escapeHtml(site.address)}</code>
  </header>
  <ul>
    ${site.pages
      .map(
        (entry) =>
          `<li><a href="/${site.address}${escapeHtml(entry.path)}">${escapeHtml(entry.title)}</a><span>${escapeHtml(entry.path)}</span></li>`,
      )
      .join('\n    ')}
  </ul>
</article>`,
          )
          .join('\n')

  return page(
    'Sites',
    `<main class="ow-wrap">
  <p class="ow-kicker">Directory · ${sites.length} site(s)</p>
  <h1 class="ow-h1">Everything this machine has read.</h1>
  <p class="ow-lede">
    Grouped by address, because a site is a key. Anybody can run a crawler; this
    is the list yours found. Open a page here, or paste an address into the bar.
  </p>
  ${body}
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — a directory of what you chose to crawl.</footer>
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
      ? `<p class="ow-empty">No results for <strong>${escapeHtml(query)}</strong>. Try fewer words, or crawl another site into the index.</p>`
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
  <p class="ow-meta">${found.total} result(s) from ${documentCount.toLocaleString()} indexed page(s) in ${tookMs.toFixed(2)} ms${cached ? ' (cached)' : ''} — no ranking by clicks, no personalization</p>
  ${rows}
  <footer class="ow-foot"><strong>OpenWeb gateway</strong> — <a href="/sites">browse the indexed sites</a>. The index is a file on this computer.</footer>
</main>`,
  )
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
    const file = await withTimeout(
      readFromDrive(drive, path, { timeout: slice }),
      slice + 500,
    )
    if (file.status !== 404) return file

    // A 404 can mean the path really is missing, or that the drive metadata
    // arrived but the content block has not. Ask the metadata directly, and
    // only give up when the path is genuinely absent.
    let exists = false
    try {
      exists = (await drive.entry(drivePathFor(path), { timeout: slice })) !== null
    } catch {
      exists = false
    }
    if (!exists) return file
    if (Date.now() >= deadline) return file

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
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
