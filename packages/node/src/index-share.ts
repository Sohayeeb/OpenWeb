/**
 * Publishing a local index as a Hyperdrive.
 *
 * The drive is tiny: `index.db`, `manifest.json`, and a README. A peer fetches
 * the snapshot, verifies its SHA-256 against the manifest, opens it read-only,
 * and queries it. No crawling, no central server, and no trust in whoever
 * served the bytes.
 */

import { encodeAddress } from '@openweb/core'
import {
  INDEX_DRIVE_FILE,
  INDEX_MANIFEST_FILE,
  SqliteIndex,
  encodeManifest,
  snapshotIndex,
  type IndexManifest,
} from '@openweb/index'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ShareIndexOptions {
  dir?: string
  /** Defaults to `<dir>/index.db`. */
  indexFile?: string
  publisher?: string
  site?: string
  timeoutMs?: number
  onStatus?: (message: string) => void
}

export interface SharedIndexDrive {
  address: string
  manifest: IndexManifest
  version: number
  close(): Promise<void>
}

export async function publishIndex(options: ShareIndexOptions = {}): Promise<SharedIndexDrive> {
  const dir = resolve(options.dir ?? '.openweb')
  const indexFile = options.indexFile ?? join(dir, 'index.db')
  const status = options.onStatus ?? (() => undefined)

  const index = SqliteIndex.open(indexFile)
  if (index.documentCount === 0) {
    index.close()
    throw new Error(`nothing to publish: ${indexFile} has no documents`)
  }

  const snapshot = await snapshotIndex(index, join(dir, 'share', INDEX_DRIVE_FILE), {
    ...(options.publisher ? { publisher: options.publisher } : {}),
    ...(options.site ? { site: options.site } : {}),
  })
  index.close()
  status(`snapshot ${(snapshot.manifest.bytes / 1024 / 1024).toFixed(1)} MB, ${snapshot.manifest.documents} document(s)`)

  const store = new Corestore(join(dir, 'index-drive'))
  await store.ready()
  const drive = new Hyperdrive(store)
  await drive.ready()

  await drive.put(INDEX_DRIVE_FILE, readFileSync(snapshot.file))
  await drive.put(INDEX_MANIFEST_FILE, encodeManifest(snapshot.manifest))
  await drive.put(
    'README.txt',
    new TextEncoder().encode(
      `OpenWeb shared index\n\n` +
        `address: ${encodeAddress(drive.key)}\n` +
        `documents: ${snapshot.manifest.documents}\n` +
        `terms: ${snapshot.manifest.terms}\n` +
        `built: ${new Date(snapshot.manifest.built).toISOString()}\n\n` +
        `Fetch it with: openweb index fetch <address>\n` +
        `Query it with: openweb index query <address> <words>\n` +
        `Or through the gateway: /shared?address=<address>&q=<words>\n`,
    ),
  )
  const version = (drive as unknown as { version: number }).version
  const address = encodeAddress(drive.key)

  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => {
    status('peer connected; serving index')
    store.replicate(socket)
  })
  const discovery = swarm.join(drive.discoveryKey)
  await Promise.race([
    discovery.flushed().catch(() => undefined),
    delay(Math.min(options.timeoutMs ?? 5_000, 5_000)),
  ])

  return {
    address,
    manifest: snapshot.manifest,
    version,
    async close() {
      await discovery.destroy().catch(() => undefined)
      await swarm.destroy().catch(() => undefined)
      await drive.close().catch(() => undefined)
      await store.close().catch(() => undefined)
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
