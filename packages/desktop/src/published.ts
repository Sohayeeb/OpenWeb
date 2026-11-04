/**
 * The list of folders this machine publishes.
 *
 * Each entry is a Hyperdrive of its own, with its own key and therefore its own
 * address. That is what makes "publish another folder" possible without the
 * second site overwriting the first. The registry is plain JSON so the launcher
 * and the publish page can read it without a service running.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type PublishedKind = 'folder' | 'page'

export interface PublishedSiteRecord {
  address: string
  /** The folder mirrored into the drive. */
  folder: string
  /** Where this site's identity and drive blocks live. */
  stateDir: string
  title: string
  kind: PublishedKind
  added: number
  updated: number
}

interface PublishedSiteFile {
  version: 1
  sites: PublishedSiteRecord[]
}

export function publishedSitesFile(dir: string): string {
  return join(resolve(dir), 'sites.json')
}

export function readPublishedSites(dir: string): PublishedSiteRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(publishedSitesFile(dir), 'utf8')) as PublishedSiteFile
    if (parsed.version !== 1 || !Array.isArray(parsed.sites)) return []
    return parsed.sites.filter(
      (site) =>
        typeof site.address === 'string' &&
        typeof site.folder === 'string' &&
        typeof site.stateDir === 'string',
    )
  } catch {
    return []
  }
}

export function writePublishedSites(dir: string, sites: PublishedSiteRecord[]): void {
  mkdirSync(resolve(dir), { recursive: true })
  const file: PublishedSiteFile = { version: 1, sites }
  writeFileSync(publishedSitesFile(dir), JSON.stringify(file, null, 2))
}
