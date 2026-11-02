/**
 * Publishing an index as a drive.
 *
 * A shared index is a snapshot plus a tiny manifest. The manifest has the
 * document count, schema version, timestamp, and a SHA-256 of the database, so
 * a peer can verify the bytes after fetching them. There is no live connection
 * to the publisher and no trust in the transport.
 */

import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { INDEX_SCHEMA_VERSION, type SqliteIndex } from './sqlite-index.js'

export const INDEX_MANIFEST_FILE = 'manifest.json'
export const INDEX_DRIVE_FILE = 'index.db'

export interface IndexManifest {
  version: 1
  kind: 'openweb-index'
  schema: number
  built: number
  documents: number
  terms: number
  bytes: number
  sha256: string
  /** Identity address of the publisher, when known. */
  publisher?: string
  /** Optional site address this crawl started from. */
  site?: string
}

export interface SnapshotResult {
  file: string
  manifest: IndexManifest
}

/** Write a consistent, compact copy of an index and hash it. */
export async function snapshotIndex(
  index: SqliteIndex,
  output: string,
  options: { publisher?: string; site?: string } = {},
): Promise<SnapshotResult> {
  mkdirSync(dirname(output), { recursive: true })
  rmSync(output, { force: true })
  index.snapshot(output)

  const stats = index.stats()
  const manifest: IndexManifest = {
    version: 1,
    kind: 'openweb-index',
    schema: INDEX_SCHEMA_VERSION,
    built: stats.built,
    documents: stats.documents,
    terms: stats.terms,
    bytes: statSync(output).size,
    sha256: await sha256File(output),
    ...(options.publisher ? { publisher: options.publisher } : {}),
    ...(options.site ? { site: options.site } : {}),
  }

  return { file: output, manifest }
}

export function encodeManifest(manifest: IndexManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2))
}

export function parseManifest(input: Uint8Array | string): IndexManifest {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input)
  const manifest = JSON.parse(text) as IndexManifest
  if (manifest.version !== 1 || manifest.kind !== 'openweb-index') {
    throw new Error('not an OpenWeb index manifest')
  }
  if (typeof manifest.sha256 !== 'string' || manifest.sha256.length !== 64) {
    throw new Error('index manifest has no valid sha256')
  }
  return manifest
}

export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export async function verifyIndexFile(file: string, manifest: IndexManifest): Promise<void> {
  const bytes = statSync(file).size
  if (bytes !== manifest.bytes) {
    throw new Error(`shared index size mismatch: expected ${manifest.bytes}, got ${bytes}`)
  }
  const hash = await sha256File(file)
  if (hash !== manifest.sha256) {
    throw new Error('shared index failed its sha256 check')
  }
}

export function sharedIndexPath(dir: string, address: string, sha: string): string {
  return join(dir, 'shared', `${address}-${sha.slice(0, 16)}.db`)
}

export function readIndexManifest(file: string): IndexManifest {
  return parseManifest(readFileSync(file, 'utf8'))
}
