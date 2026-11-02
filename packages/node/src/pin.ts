/**
 * Pinning: volunteer to keep somebody else's site online.
 *
 * A pin is a full replica, not a bookmark. We join the site's DHT topic, keep
 * a Corestore open, download every block, and stay connected so other peers can
 * fetch from us while this process runs. It is the BitTorrent seeding model,
 * with a Hyperdrive instead of a torrent.
 *
 * Pin state lives in `pins.json`; the blocks live in `pins/store`. Removing a
 * pin stops seeding and forgets the address. Delete the directory to reclaim
 * the disk space.
 */

import { encodeAddress, decodeAddress, isAddress } from '@openweb/core'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface PinRecord {
  version: 1
  address: string
  added: number
  lastSync: number
  driveVersion: number
  /** Bytes downloaded so far, when known. */
  bytes?: number
}

interface PinFile {
  version: 1
  pins: PinRecord[]
}

export interface PinOptions {
  dir?: string
  /** Give up waiting for metadata after this long. Downloading can continue. */
  timeoutMs?: number
  onStatus?: (message: string) => void
}

export interface PinnedSite {
  address: string
  record: PinRecord
  /** Resolves when the drive is fully replicated, false if the wait timed out. */
  complete: Promise<boolean>
  close(): Promise<void>
}

export function pinsFile(dir: string): string {
  return join(resolve(dir), 'pins.json')
}

export function readPins(dir: string): PinRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(pinsFile(dir), 'utf8')) as PinFile
    if (parsed.version !== 1 || !Array.isArray(parsed.pins)) return []
    return parsed.pins.filter((pin) => isAddress(pin.address))
  } catch {
    return []
  }
}

function writePins(dir: string, pins: PinRecord[]): void {
  mkdirSync(resolve(dir), { recursive: true })
  const file: PinFile = { version: 1, pins }
  writeFileSync(pinsFile(dir), JSON.stringify(file, null, 2))
}

function upsertPin(dir: string, record: PinRecord): PinRecord {
  const pins = readPins(dir).filter((pin) => pin.address !== record.address)
  pins.push(record)
  writePins(dir, pins)
  return record
}

export function removePin(dir: string, address: string): boolean {
  const pins = readPins(dir)
  const next = pins.filter((pin) => pin.address !== address)
  if (next.length === pins.length) return false
  writePins(dir, next)
  return true
}

export async function startPin(address: string, options: PinOptions = {}): Promise<PinnedSite> {
  if (!isAddress(address)) throw new Error(`not an OpenWeb address: ${address}`)

  const dir = resolve(options.dir ?? '.openweb')
  const timeoutMs = options.timeoutMs ?? 20_000
  const status = options.onStatus ?? (() => undefined)
  const key = decodeAddress(address)

  const store = new Corestore(join(dir, 'pins', 'store'))
  await store.ready()
  const drive = new Hyperdrive(store, key)
  await drive.ready()

  const swarm = new Hyperswarm()
  let connected = false
  swarm.on('connection', (socket) => {
    connected = true
    status('peer connected')
    store.replicate(socket)
  })

  const discovery = swarm.join(drive.discoveryKey)
  status(`announcing ${address.slice(0, 12)}…`)
  await Promise.race([
    discovery.flushed().catch(() => undefined),
    delay(Math.min(timeoutMs, 5_000)),
  ])

  // Wait for the signed metadata before starting the content download. If no
  // peer is online yet, that is not an error: the swarm stays open and the
  // download will start when somebody appears.
  await waitForMetadata(drive, Math.min(timeoutMs, 5_000))
  status(connected ? 'replicating full drive' : 'waiting for a peer; still seeding')

  let currentDownload: { done(): Promise<void>; destroy(): void } | null = null
  let syncing = false
  let lastRecord = upsertPin(dir, {
    version: 1,
    address,
    added: Date.now(),
    lastSync: Date.now(),
    driveVersion: (drive as unknown as { version: number }).version,
  })

  const sync = (): void => {
    if (syncing) return
    syncing = true
    currentDownload?.destroy()
    currentDownload = drive.download('/')
    void currentDownload
      .done()
      .then(() => {
        lastRecord = upsertPin(dir, {
          ...lastRecord,
          lastSync: Date.now(),
          driveVersion: (drive as unknown as { version: number }).version,
        })
        status('full drive replicated; seeding')
      })
      .catch(() => undefined)
      .finally(() => {
        syncing = false
      })
  }

  drive.core.on('append', () => {
    status('new version; fetching the delta')
    sync()
  })

  const complete = (async (): Promise<boolean> => {
    sync()
    const deadline = Date.now() + Math.max(timeoutMs, 10_000)
    while (Date.now() < deadline) {
      const core = drive.core as unknown as { length: number; contiguousLength: number }
      if (core.length > 0 && core.contiguousLength >= core.length) return true
      await delay(100)
    }
    return false
  })()

  return {
    address: encodeAddress(drive.key),
    record: lastRecord,
    complete,
    async close() {
      currentDownload?.destroy()
      await discovery.destroy().catch(() => undefined)
      await swarm.destroy().catch(() => undefined)
      await drive.close().catch(() => undefined)
      await store.close().catch(() => undefined)
    },
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
