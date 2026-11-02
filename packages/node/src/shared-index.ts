/**
 * Fetching and querying somebody else's crawl index.
 *
 * A remote index is a normal OpenWeb drive. We join its topic, wait for the
 * metadata, download `index.db`, verify the manifest hash, and open the SQLite
 * file read-only. The result can be queried exactly like a local index.
 */

import { decodeAddress, isAddress } from '@openweb/core'
import {
  INDEX_DRIVE_FILE,
  INDEX_MANIFEST_FILE,
  SqliteIndex,
  parseManifest,
  sharedIndexPath,
  verifyIndexFile,
  type IndexManifest,
} from '@openweb/index'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface SharedIndexOptions {
  dir?: string
  timeoutMs?: number
}

export interface FetchedIndex {
  address: string
  manifest: IndexManifest
  file: string
  index: SqliteIndex
}

interface CachedIndex extends FetchedIndex {
  sha256: string
}

export class SharedIndexClient {
  private readonly dir: string
  private readonly timeoutMs: number
  private store: Corestore | null = null
  private swarm: Hyperswarm | null = null
  private readonly drives = new Map<string, Hyperdrive>()
  private readonly joined = new Set<string>()
  private readonly cache = new Map<string, CachedIndex>()
  private connected = false

  constructor(options: SharedIndexOptions = {}) {
    this.dir = resolve(options.dir ?? '.openweb')
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  private async ensureNetwork(): Promise<{ store: Corestore; swarm: Hyperswarm }> {
    if (this.store && this.swarm) return { store: this.store, swarm: this.swarm }

    const store = new Corestore(join(this.dir, 'shared-store'))
    await store.ready()
    const swarm = new Hyperswarm()
    swarm.on('connection', (socket) => {
      this.connected = true
      store.replicate(socket)
    })
    this.store = store
    this.swarm = swarm
    return { store, swarm }
  }

  private async driveFor(address: string): Promise<Hyperdrive> {
    const { store, swarm } = await this.ensureNetwork()
    const key = decodeAddress(address)
    const id = Buffer.from(key).toString('hex')
    const cached = this.drives.get(id)
    if (cached) return cached

    const drive = new Hyperdrive(store, key)
    await drive.ready()

    if (!this.joined.has(id)) {
      this.joined.add(id)
      swarm.join(drive.discoveryKey)
      await Promise.race([swarm.flush().catch(() => undefined), delay(3_000)])
      await waitForMetadata(drive, Math.min(this.timeoutMs, 8_000))
    }

    this.drives.set(id, drive)
    return drive
  }

  async fetch(address: string): Promise<FetchedIndex> {
    if (!isAddress(address)) throw new Error(`not an OpenWeb address: ${address}`)
    const drive = await this.driveFor(address)

    const manifestBytes = await drive.get(INDEX_MANIFEST_FILE, { timeout: this.timeoutMs })
    if (!manifestBytes) throw new Error('that address has no OpenWeb index manifest')
    const manifest = parseManifest(manifestBytes)

    const hit = this.cache.get(address)
    if (hit && hit.sha256 === manifest.sha256) return hit

    const file = sharedIndexPath(this.dir, address, manifest.sha256)
    mkdirSync(dirname(file), { recursive: true })

    const download = drive.download(INDEX_DRIVE_FILE)
    const done = await Promise.race([
      download.done().then(() => true),
      delay(this.timeoutMs).then(() => false),
    ])
    if (!done) {
      download.destroy()
      throw new Error('timed out downloading the shared index')
    }

    const stream = drive.createReadStream(INDEX_DRIVE_FILE)
    const out = createWriteStream(file)
    try {
      for await (const chunk of stream) {
        if (!out.write(chunk)) await once(out, 'drain')
      }
      await new Promise<void>((resolvePromise, reject) => {
        out.once('error', reject)
        out.end(() => resolvePromise())
      })
    } catch (error) {
      out.destroy()
      rmSync(file, { force: true })
      throw error
    }

    await verifyIndexFile(file, manifest)

    hit?.index.close()
    const index = SqliteIndex.open(file, { readOnly: true })
    const fetched: CachedIndex = {
      address,
      manifest,
      file,
      index,
      sha256: manifest.sha256,
    }
    this.cache.set(address, fetched)
    return fetched
  }

  async close(): Promise<void> {
    for (const entry of this.cache.values()) entry.index.close()
    this.cache.clear()
    for (const drive of this.drives.values()) await drive.close().catch(() => undefined)
    this.drives.clear()
    await this.swarm?.destroy().catch(() => undefined)
    await this.store?.close().catch(() => undefined)
    this.swarm = null
    this.store = null
  }
}

async function waitForMetadata(drive: Hyperdrive, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const core = drive.core as unknown as { length: number; contiguousLength: number }
    if (core.length > 0 && core.contiguousLength >= core.length) return
    await delay(50)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
