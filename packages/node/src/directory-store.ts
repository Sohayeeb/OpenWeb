/**
 * Publishing a signed directory as a drive.
 *
 * The file is plain JSON with one signature per entry. The drive gives it an
 * address; the signatures give it meaning. A mirror can copy the file, but it
 * cannot make a different list verify.
 */

import {
  canonicalJSON,
  decodeAddress,
  encodeAddress,
  parseDirectory,
  verifyDirectory,
  type DirectoryDocument,
  type Signed,
} from '@openweb/core'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import { join, resolve } from 'node:path'

export const DIRECTORY_FILE = 'directory.json'

export interface ShareDirectoryOptions {
  dir?: string
  signed: Signed<DirectoryDocument>
  timeoutMs?: number
  onStatus?: (message: string) => void
}

export interface SharedDirectoryDrive {
  address: string
  version: number
  close(): Promise<void>
}

export async function publishDirectory(
  options: ShareDirectoryOptions,
): Promise<SharedDirectoryDrive> {
  const dir = resolve(options.dir ?? '.openweb')
  const status = options.onStatus ?? (() => undefined)

  const store = new Corestore(join(dir, 'directory-drive'))
  await store.ready()
  const drive = new Hyperdrive(store)
  await drive.ready()

  await drive.put(DIRECTORY_FILE, new TextEncoder().encode(JSON.stringify(options.signed, null, 2)))
  const version = (drive as unknown as { version: number }).version
  const address = encodeAddress(drive.key)

  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => {
    status('peer connected; serving directory')
    store.replicate(socket)
  })
  const discovery = swarm.join(drive.discoveryKey)
  await Promise.race([
    discovery.flushed().catch(() => undefined),
    delay(Math.min(options.timeoutMs ?? 5_000, 5_000)),
  ])

  return {
    address,
    version,
    async close() {
      await discovery.destroy().catch(() => undefined)
      await swarm.destroy().catch(() => undefined)
      await drive.close().catch(() => undefined)
      await store.close().catch(() => undefined)
    },
  }
}

export interface FetchDirectoryOptions {
  dir?: string
  timeoutMs?: number
}

export interface FetchedDirectory {
  address: string
  signed: Signed<DirectoryDocument>
  raw: string
  close(): Promise<void>
}

export async function fetchDirectory(
  address: string,
  options: FetchDirectoryOptions = {},
): Promise<FetchedDirectory> {
  const dir = resolve(options.dir ?? '.openweb')
  const timeoutMs = options.timeoutMs ?? 20_000

  const store = new Corestore(join(dir, 'directory-cache'))
  await store.ready()
  const drive = new Hyperdrive(store, decodeKey(address))
  await drive.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (socket) => store.replicate(socket))
  const discovery = swarm.join(drive.discoveryKey)
  await Promise.race([
    discovery.flushed().catch(() => undefined),
    delay(3_000),
  ])
  await waitForMetadata(drive, Math.min(timeoutMs, 8_000))

  const bytes = await drive.get(DIRECTORY_FILE, { timeout: timeoutMs })
  if (!bytes) {
    await closeAll()
    throw new Error('that address has no directory.json')
  }

  const raw = new TextDecoder().decode(bytes)
  const signed = parseDirectory(raw)
  verifyDirectory(signed)

  async function closeAll(): Promise<void> {
    await discovery.destroy().catch(() => undefined)
    await swarm.destroy().catch(() => undefined)
    await drive.close().catch(() => undefined)
    await store.close().catch(() => undefined)
  }

  return {
    address,
    signed,
    raw,
    close: closeAll,
  }
}

/** Deterministic digest, useful for logs without dumping the whole file. */
export function directoryDigest(signed: Signed<DirectoryDocument>): string {
  return canonicalJSON(signed).length.toString(16)
}

function decodeKey(address: string): Uint8Array {
  return decodeAddress(address)
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
