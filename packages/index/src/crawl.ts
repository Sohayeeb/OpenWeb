/**
 * The crawler.
 *
 * It starts from seeds (addresses you trust), fetches pages through a gateway,
 * extracts text and links, and follows links to other addresses. There is no
 * global list of sites to crawl — coverage is whatever is reachable from the
 * seeds. That is the point: a search engine with a small, accountable web.
 *
 * Fetches run in parallel (default 4). Crawling is IO-bound, so this is most of
 * the speedup; the index build is already fast.
 */

import { extractPage } from './extract.js'
import type { Document } from './index-file.js'

export interface CrawlOptions {
  /** Gateway base URL, e.g. http://127.0.0.1:8080 */
  gateway: string
  seeds: string[]
  maxPages?: number
  maxDepth?: number
  timeoutMs?: number
  concurrency?: number
  onPage?: (document: Document) => void
}

interface QueueItem {
  address: string
  path: string
  depth: number
}

export async function crawl(options: CrawlOptions): Promise<Document[]> {
  const gateway = options.gateway.replace(/\/+$/, '')
  const maxPages = options.maxPages ?? 200
  const maxDepth = options.maxDepth ?? 4
  const timeoutMs = options.timeoutMs ?? 30_000
  const concurrency = Math.max(1, options.concurrency ?? 4)

  const queue: QueueItem[] = options.seeds.map((address) => ({
    address,
    path: '/index.html',
    depth: 0,
  }))
  const seen = new Set<string>()
  const documents: Document[] = []
  let active = 0

  async function visit(item: QueueItem): Promise<void> {
    const key = `${item.address}${item.path}`
    if (seen.has(key)) return
    seen.add(key)

    const html = await fetchPage(gateway, item.address, item.path, timeoutMs)
    if (html === null) return

    const page = extractPage(html, item.address, item.path)
    const document: Document = {
      address: item.address,
      path: item.path,
      title: page.title || item.path,
      text: page.text,
    }
    documents.push(document)
    options.onPage?.(document)

    if (item.depth >= maxDepth) return
    for (const link of page.links) {
      const path = canonicalPath(link.path)
      if (!seen.has(`${link.address}${path}`)) {
        queue.push({ address: link.address, path, depth: item.depth + 1 })
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      while (
        active < concurrency &&
        queue.length > 0 &&
        documents.length + active < maxPages
      ) {
        const item = queue.shift()
        if (!item) break
        active++
        visit(item).then(
          () => {
            active--
            pump()
          },
          (error: unknown) => {
            active--
            reject(error instanceof Error ? error : new Error(String(error)))
          },
        )
      }

      if (active === 0 && (queue.length === 0 || documents.length >= maxPages)) {
        resolve()
      }
    }
    pump()
  })

  return documents
}

export function canonicalPath(path: string): string {
  const clean = path.split('?')[0]?.split('#')[0] ?? '/'
  if (clean === '' || clean === '/') return '/index.html'
  // A directory and its index.html are the same page; index it once.
  if (clean.endsWith('/')) return `${clean}index.html`
  return clean
}

async function fetchPage(
  gateway: string,
  address: string,
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const response = await fetch(`${gateway}/${address}${path}`, {
      // The gateway injects a browser bar into pages that opt in. Ask for the
      // page without it so chrome text never ends up in the index.
      headers: { accept: 'text/html', 'x-openweb-crawl': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null

    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('text/html')) return null

    return await response.text()
  } catch {
    return null
  }
}
