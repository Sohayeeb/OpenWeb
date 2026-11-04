/**
 * Publishing from inside the app.
 *
 * Every published folder gets its own drive, its own key, and its own node, so
 * "publish this folder" never overwrites a site that is already online. The
 * gateway reads those local drives directly (no DHT round trip, no waiting for
 * a peer) while the node seeds them for everybody else.
 *
 * The service also owns the long-lived shares that a browser page can start:
 * a published signed directory and a published search index. They stay online
 * with the app and come back automatically on the next launch.
 */

import {
  ensureIdentity,
  identityAddress,
  isAddress,
  loadDirectory,
  verifyDirectory,
  type DirectoryDocument,
  type FileResponse,
  type Signed,
} from '@openweb/core'
import type { Gateway } from '@openweb/gateway'
import {
  SqliteIndex,
  crawl,
  indexFileFor,
  type Document,
  type IndexManifest,
} from '@openweb/index'
import {
  SharedIndexClient,
  publishDirectory as publishDirectoryDrive,
  publishIndex as publishIndexDrive,
  readPins,
  removePin,
  startNode,
  startPin,
  type OpenWebNode,
  type PinnedSite,
  type SharedDirectoryDrive,
  type SharedIndexDrive,
} from '@openweb/node'
import { renderSite, type SiteSpec } from '@openweb/builder'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  readPublishedSites,
  writePublishedSites,
  type PublishedKind,
  type PublishedSiteRecord,
} from './published.js'

export interface PublishedSiteInfo {
  address: string
  title: string
  folder: string
  pages: number
  kind: PublishedKind | 'app'
  online: boolean
  builtin: boolean
}

export interface CrawlSummary {
  pages: number
  documents: number
  terms: number
}

export interface PublishOptions {
  title?: string
  /** Skip the immediate crawl when the caller will index later. */
  crawl?: boolean
  kind?: PublishedKind
}

export interface PublisherOptions {
  dir: string
  /** Native folder picker, supplied by the desktop shell. */
  chooseFolder?: () => Promise<string | null>
  onStatus?: (message: string) => void
  onError?: (error: unknown) => void
}

interface BuiltinSite {
  address: string
  title: string
  folder: string
  node: OpenWebNode
}

export class Publisher {
  private readonly dir: string
  private readonly chooseFolderFn: (() => Promise<string | null>) | undefined
  private readonly status: (message: string) => void
  private readonly onError: (error: unknown) => void

  private records: PublishedSiteRecord[]
  private readonly nodes = new Map<string, OpenWebNode>()
  private readonly pins = new Map<string, PinnedSite>()
  private builtin: BuiltinSite | null = null
  private gateway: Gateway | null = null
  private directoryShare: SharedDirectoryDrive | null = null
  private indexShare: SharedIndexDrive | null = null

  constructor(options: PublisherOptions) {
    this.dir = resolve(options.dir)
    this.chooseFolderFn = options.chooseFolder
    this.status = options.onStatus ?? (() => undefined)
    this.onError = options.onError ?? (() => undefined)
    this.records = readPublishedSites(this.dir)
  }

  /** The shell calls this once the gateway has bound its port. */
  setGateway(gateway: Gateway): void {
    this.gateway = gateway
  }

  registerBuiltin(address: string, title: string, folder: string, node: OpenWebNode): void {
    this.builtin = { address, title, folder, node }
  }

  canChooseFolder(): boolean {
    return this.chooseFolderFn !== undefined
  }

  async chooseFolder(): Promise<string | null> {
    return this.chooseFolderFn ? this.chooseFolderFn() : null
  }

  /** Every site the browser knows how to open locally, newest first. */
  list(): PublishedSiteInfo[] {
    const index = this.openIndex()
    try {
      const pagesFor = (address: string): number =>
        index ? index.pagesFor(address).length : 0

      const sites: PublishedSiteInfo[] = []

      if (this.builtin) {
        sites.push({
          address: this.builtin.address,
          title: this.builtin.title,
          folder: this.builtin.folder,
          pages: pagesFor(this.builtin.address),
          kind: 'app',
          online: true,
          builtin: true,
        })
      }

      for (const record of this.records) {
        sites.push({
          address: record.address,
          title: record.title,
          folder: record.folder,
          pages: pagesFor(record.address),
          kind: record.kind,
          online: this.nodes.has(record.address),
          builtin: false,
        })
      }

      return sites
    } finally {
      index?.close()
    }
  }

  /** Name the gateway uses for the same list. */
  listSites(): PublishedSiteInfo[] {
    return this.list()
  }

  /** Addresses the gateway can read from memory instead of the DHT. */
  localAddresses(): string[] {
    return [...this.nodes.keys(), ...(this.builtin ? [this.builtin.address] : [])]
  }

  async readLocal(address: string, path: string): Promise<FileResponse | null> {
    const node =
      this.nodes.get(address) ??
      (this.builtin?.address === address ? this.builtin.node : null)
    if (!node) return null
    return node.read(path)
  }

  /* ---------------------------------------------------------------------- */
  /* Publishing                                                             */
  /* ---------------------------------------------------------------------- */

  async publishFolder(
    folder: string,
    options: PublishOptions | string = {},
  ): Promise<PublishedSiteInfo> {
    const settings = typeof options === 'string' ? { title: options } : options
    const full = resolve(folder)
    let stat
    try {
      stat = statSync(full)
    } catch {
      throw new Error(`that folder does not exist: ${full}`)
    }
    if (!stat.isDirectory()) throw new Error(`that is a file, not a folder: ${full}`)

    // Choosing the same folder again means "update this site", not "make a
    // second key for the same files".
    const existing = this.records.find((record) => sameFolder(record.folder, full))
    if (existing) {
      if (settings.title?.trim()) existing.title = settings.title.trim()
      return this.restart(existing, settings)
    }

    const title = settings.title?.trim() || basename(full) || 'My site'
    const kind = settings.kind ?? 'folder'
    const stateDir = join(this.dir, 'sites', `${slug(title)}-${stamp()}`)

    this.status(`publishing ${title}…`)
    const node = await startNode({ dir: stateDir, folder: full, port: 0 })

    const record: PublishedSiteRecord = {
      address: node.address,
      folder: full,
      stateDir,
      title,
      kind,
      added: Date.now(),
      updated: Date.now(),
    }

    this.records = this.records.filter((entry) => entry.address !== record.address)
    this.records.push(record)
    this.save()
    this.nodes.set(record.address, node)

    return this.finish(record, settings)
  }

  /** Build one page and publish it as its own site. */
  async publishPage(spec: SiteSpec): Promise<PublishedSiteInfo> {
    const title = spec.title.trim() || 'A small page'
    const folder = join(this.dir, 'pages', `${slug(title)}-${stamp()}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'index.html'), renderSite(spec).html)

    return this.publishFolder(folder, { title, kind: 'page' })
  }

  async republish(address: string): Promise<PublishedSiteInfo> {
    if (!isAddress(address)) throw new Error('that is not an OpenWeb address')
    const record = this.records.find((entry) => entry.address === address)
    if (!record) throw new Error('that site was not published from this app')
    return this.restart(record, {})
  }

  async forget(address: string, options: { removeFiles?: boolean } = {}): Promise<boolean> {
    const record = this.records.find((entry) => entry.address === address)
    if (!record) return false

    await this.stopNode(address)
    this.records = this.records.filter((entry) => entry.address !== address)
    this.save()

    if (options.removeFiles) {
      rmSync(record.stateDir, { recursive: true, force: true })
      if (record.kind === 'page') rmSync(record.folder, { recursive: true, force: true })
    }

    this.status(`took ${record.title} offline`)
    return true
  }

  /**
   * Start every site from the last run. A missing state directory is not
   * recreated: doing so would silently mint a new key and change the address.
   */
  async restore(): Promise<void> {
    for (const record of this.records) {
      if (!existsSync(record.folder)) {
        this.status(`skipped ${record.title}: folder is gone`)
        continue
      }
      if (!existsSync(join(record.stateDir, 'store'))) {
        this.status(`skipped ${record.title}: its key is gone`)
        continue
      }

      try {
        const node = await startNode({ dir: record.stateDir, folder: record.folder, port: 0 })
        this.nodes.set(record.address, node)
        record.updated = Date.now()
      } catch (error) {
        this.onError(error)
      }
    }
    this.save()
  }

  /** Re-open the directory and index shares that were online last time. */
  async restoreShares(): Promise<void> {
    const directoryFile = join(this.dir, 'directory.json')

    if (this.directoryAddress() && existsSync(directoryFile)) {
      try {
        const signed = loadDirectory(directoryFile)
        if (verifyDirectory(signed).valid) await this.publishDirectory(signed)
      } catch (error) {
        this.onError(error)
      }
    }

    if (this.indexAddress() && existsSync(indexFileFor(this.dir))) {
      try {
        await this.publishIndex()
      } catch (error) {
        this.onError(error)
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Crawling, pinning, sharing                                             */
  /* ---------------------------------------------------------------------- */

  async crawlSite(address: string, maxPages = 100): Promise<CrawlSummary> {
    if (!isAddress(address)) throw new Error('that is not an OpenWeb address')
    if (!this.gateway) throw new Error('the gateway is still starting')

    this.status('indexing this machine’s web…')
    const documents: Document[] = await crawl({
      gateway: this.gateway.url.replace(/\/+$/, ''),
      seeds: [address],
      maxPages,
      concurrency: 4,
    })

    const stats = this.addDocuments(documents)
    this.status(
      documents.length > 0
        ? `${documents.length} page(s) indexed · ${stats.documents.toLocaleString()} in search`
        : 'ready',
    )
    return { pages: documents.length, ...stats }
  }

  async pinSite(address: string): Promise<{ address: string; complete: boolean }> {
    if (!isAddress(address)) throw new Error('that is not an OpenWeb address')

    const existing = this.pins.get(address)
    if (existing) return { address, complete: false }

    this.status(`pinning ${address.slice(0, 12)}…`)
    const pin = await startPin(address, {
      dir: this.dir,
      timeoutMs: 8_000,
      onStatus: (message) => this.status(message),
    })
    this.pins.set(address, pin)
    return { address, complete: false }
  }

  async unpinSite(address: string): Promise<boolean> {
    const pin = this.pins.get(address)
    if (pin) {
      this.pins.delete(address)
      await pin.close().catch(() => undefined)
    }
    return removePin(this.dir, address)
  }

  pinnedAddresses(): string[] {
    return readPins(this.dir).map((pin) => pin.address)
  }

  async publishDirectory(signed: Signed<DirectoryDocument>): Promise<{ address: string; entries: number }> {
    const verification = verifyDirectory(signed)
    if (!verification.valid) {
      throw new Error(`refusing to publish an invalid directory: ${verification.errors.join('; ')}`)
    }

    await this.directoryShare?.close().catch(() => undefined)
    this.status('publishing the signed directory…')
    const share = await publishDirectoryDrive({
      dir: this.dir,
      signed,
      onStatus: (message) => this.status(message),
    })
    this.directoryShare = share
    writeFileSync(join(this.dir, 'directory-address.txt'), share.address + '\n')
    return { address: share.address, entries: verification.entries.length }
  }

  directoryAddress(): string | null {
    if (this.directoryShare) return this.directoryShare.address
    return readAddressFile(join(this.dir, 'directory-address.txt'))
  }

  async publishIndex(): Promise<{ address: string; manifest: IndexManifest }> {
    await this.indexShare?.close().catch(() => undefined)
    this.status('snapshotting the local index…')
    const share = await publishIndexDrive({
      dir: this.dir,
      ...(this.identity() ? { publisher: this.identity() } : {}),
      onStatus: (message) => this.status(message),
    })
    this.indexShare = share
    writeFileSync(join(this.dir, 'index-address.txt'), share.address + '\n')
    return { address: share.address, manifest: share.manifest }
  }

  indexAddress(): string | null {
    if (this.indexShare) return this.indexShare.address
    return readAddressFile(join(this.dir, 'index-address.txt'))
  }

  async importIndex(address: string): Promise<CrawlSummary & { imported: number }> {
    if (!isAddress(address)) throw new Error('that is not an OpenWeb address')

    const client = new SharedIndexClient({ dir: this.dir, timeoutMs: 30_000 })
    try {
      this.status('fetching the shared index…')
      const fetched = await client.fetch(address)
      const documents: Document[] = []
      for (const document of fetched.index.iterateDocuments(500)) documents.push(document)
      const stats = this.addDocuments(documents)
      return { imported: documents.length, pages: 0, ...stats }
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const shares = [this.directoryShare, this.indexShare].filter(
      (share): share is SharedDirectoryDrive | SharedIndexDrive => share !== null,
    )
    this.directoryShare = null
    this.indexShare = null

    await Promise.allSettled([
      ...shares.map((share) => share.close()),
      ...[...this.pins.values()].map((pin) => pin.close()),
      ...[...this.nodes.values()].map((node) => node.close()),
    ])
    this.pins.clear()
    this.nodes.clear()
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async restart(
    record: PublishedSiteRecord,
    options: PublishOptions,
  ): Promise<PublishedSiteInfo> {
    this.status(`republishing ${record.title}…`)
    await this.stopNode(record.address)
    const node = await startNode({ dir: record.stateDir, folder: record.folder, port: 0 })
    record.updated = Date.now()
    this.nodes.set(record.address, node)
    this.save()
    return this.finish(record, options)
  }

  private async finish(
    record: PublishedSiteRecord,
    options: PublishOptions,
  ): Promise<PublishedSiteInfo> {
    if (options.crawl !== false) {
      try {
        await this.crawlSite(record.address, 100)
      } catch (error) {
        this.onError(error)
      }
    }

    return this.info(record)
  }

  private info(record: PublishedSiteRecord): PublishedSiteInfo {
    const index = this.openIndex()
    let pages = 0
    try {
      pages = index?.pagesFor(record.address).length ?? 0
    } finally {
      index?.close()
    }

    return {
      address: record.address,
      title: record.title,
      folder: record.folder,
      pages,
      kind: record.kind,
      online: this.nodes.has(record.address),
      builtin: false,
    }
  }

  private async stopNode(address: string): Promise<void> {
    const node = this.nodes.get(address)
    if (!node) return
    this.nodes.delete(address)
    await node.close().catch(() => undefined)
  }

  private addDocuments(documents: Document[]): { documents: number; terms: number } {
    mkdirSync(this.dir, { recursive: true })
    const index = SqliteIndex.openOrCreate(indexFileFor(this.dir))
    try {
      index.addDocuments(documents)
      const stats = index.stats()
      return { documents: stats.documents, terms: stats.terms }
    } finally {
      index.close()
    }
  }

  private openIndex(): SqliteIndex | null {
    const file = indexFileFor(this.dir)
    if (!existsSync(file)) return null
    try {
      return SqliteIndex.open(file, { readOnly: true })
    } catch {
      return null
    }
  }

  private identity(): string | undefined {
    try {
      const file = join(this.dir, 'identity.json')
      if (!existsSync(file)) return undefined
      return identityAddress(ensureIdentity(file))
    } catch {
      return undefined
    }
  }

  private save(): void {
    writePublishedSites(this.dir, this.records)
  }
}

function readAddressFile(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return isAddress(value) ? value : null
  } catch {
    return null
  }
}

function sameFolder(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'site'
  )
}

function stamp(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}
