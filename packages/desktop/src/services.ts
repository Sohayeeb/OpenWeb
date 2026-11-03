/**
 * The OpenWeb stack in one process.
 *
 * The Electron main process owns the node (publishing), the gateway (reading),
 * the crawler/indexer, and any pinned seeds. They are the same packages the
 * CLI and the web gateway use; only the lifecycle is different: start on app
 * launch, stay quietly in the background, close when the window closes.
 */

import { startGateway, type Gateway } from '@openweb/gateway'
import { SqliteIndex, crawl, indexFileFor, type Document } from '@openweb/index'
import { readPins, startNode, startPin, type OpenWebNode, type PinnedSite } from '@openweb/node'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface IndexSummary {
  /** Pages in the index after this crawl. */
  documents: number
  /** Pages added by this crawl. */
  pages: number
  terms: number
}

export interface StackOptions {
  dir: string
  /** Folder published by the local node. Omit to serve the starter page. */
  siteFolder?: string
  /** Re-crawl the local site this often. Defaults to 30 minutes. */
  indexIntervalMs?: number
  onStatus?: (message: string) => void
  onError?: (error: unknown) => void
}

export interface Stack {
  dir: string
  address: string
  gatewayUrl: string
  gatewayPort: number
  /** Resolves when the first local index pass is done (never rejects). */
  initialIndex: Promise<IndexSummary | null>
  refreshIndex(): Promise<IndexSummary | null>
  stats(): IndexSummary | null
  close(): Promise<void>
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const dir = resolve(options.dir)
  const status = options.onStatus ?? (() => undefined)
  const onError = options.onError ?? (() => undefined)
  const intervalMs = options.indexIntervalMs ?? 30 * 60 * 1000

  mkdirSync(dir, { recursive: true })

  status('publishing your site…')
  const node: OpenWebNode = await startNode({
    dir,
    ...(options.siteFolder ? { folder: options.siteFolder } : {}),
    port: 0,
  })

  status('opening the gateway…')
  const gateway: Gateway = await startGateway({ dir, port: 0, timeoutMs: 20_000 })

  // A read-only drive can sync an older version first. Wait for the version
  // this process just published, exactly like `openweb start` does.
  await gateway.waitForVersion(node.address, node.version, 15_000).catch(() => false)

  let closing = false
  let indexing: Promise<IndexSummary | null> | null = null

  const refreshIndex = (): Promise<IndexSummary | null> => {
    if (indexing) return indexing

    indexing = (async (): Promise<IndexSummary | null> => {
      try {
        status('indexing this machine’s web…')
        const documents: Document[] = await crawl({
          gateway: gateway.url.replace(/\/+$/, ''),
          seeds: [node.address],
          maxPages: 50,
          concurrency: 4,
        })

        const index = SqliteIndex.openOrCreate(indexFileFor(dir))
        try {
          index.addDocuments(documents)
          const stats = index.stats()
          status(
            documents.length > 0
              ? `${documents.length} page(s) indexed · ${stats.documents.toLocaleString()} in search`
              : 'ready',
          )
          return { documents: stats.documents, pages: documents.length, terms: stats.terms }
        } finally {
          index.close()
        }
      } catch (error) {
        onError(error)
        return null
      } finally {
        indexing = null
      }
    })()

    return indexing
  }

  const initialIndex = refreshIndex()

  // Keep the local site searchable while the app stays open.
  const timer = setInterval(() => {
    if (!closing) void refreshIndex()
  }, intervalMs)
  timer.unref()

  // Pins are full replicas, not bookmarks. Seed them in the background so a
  // slow peer never delays the window.
  const pins: PinnedSite[] = []
  const pinRecords = readPins(dir)
  if (pinRecords.length > 0) status(`seeding ${pinRecords.length} pinned site(s)…`)
  for (const record of pinRecords) {
    void startPin(record.address, { dir, timeoutMs: 8_000 })
      .then(async (pin) => {
        if (closing) {
          await pin.close().catch(() => undefined)
          return
        }
        pins.push(pin)
      })
      .catch((error: unknown) => onError(error))
  }

  return {
    dir,
    address: node.address,
    gatewayUrl: gateway.url,
    gatewayPort: gateway.port,
    initialIndex,
    refreshIndex,
    stats(): IndexSummary | null {
      try {
        const index = SqliteIndex.open(indexFileFor(dir), { readOnly: true })
        try {
          const stats = index.stats()
          return { documents: stats.documents, pages: 0, terms: stats.terms }
        } finally {
          index.close()
        }
      } catch {
        return null
      }
    },
    async close(): Promise<void> {
      if (closing) return
      closing = true
      clearInterval(timer)

      const pending = indexing
      await Promise.allSettled(pins.map((pin) => pin.close()))
      if (pending) {
        await Promise.race([
          pending,
          new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ])
      }
      await gateway.close().catch(() => undefined)
      await node.close().catch(() => undefined)
    },
  }
}
