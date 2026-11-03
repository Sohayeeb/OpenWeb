/**
 * The dotted-grid launcher: pinned sites, sites this machine has indexed, and
 * entries from signed directories. Everything is read from disk on demand, so
 * the panel is always current without a second database.
 */

import {
  loadDirectory,
  mergeDirectoryEntries,
  verifyDirectory,
  type DirectorySite,
} from '@openweb/core'
import { SqliteIndex, indexFileFor, sqliteIndexExists } from '@openweb/index'
import { readPins } from '@openweb/node'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type SiteSource = 'pinned' | 'site' | 'directory'

export interface LauncherSite {
  address: string
  title: string
  source: SiteSource
  description?: string
}

interface Candidate extends LauncherSite {
  rank: number
}

export function listLauncherSites(dir: string): LauncherSite[] {
  const sites = new Map<string, Candidate>()

  const add = (site: Candidate): void => {
    const current = sites.get(site.address)
    if (!current) {
      sites.set(site.address, site)
      return
    }
    // A directory title beats a scraped title; a pin marks it as kept offline.
    sites.set(site.address, {
      ...current,
      ...(site.title ? { title: site.title } : {}),
      ...(site.description ? { description: site.description } : {}),
      source: sourceRank(site.source) >= sourceRank(current.source) ? site.source : current.source,
      rank: Math.max(current.rank, site.rank),
    })
  }

  // Sites the crawler has seen.
  const file = indexFileFor(dir)
  if (sqliteIndexExists(file)) {
    let index: SqliteIndex | null = null
    try {
      index = SqliteIndex.open(file, { readOnly: true })
      for (const site of index.listSites(300)) {
        add({ address: site.address, title: site.title, source: 'site', rank: 1 })
      }
    } catch {
      // A half-written or locked index is not fatal: show what we know.
    } finally {
      index?.close()
    }
  }

  // Sites this machine keeps online on purpose.
  for (const pin of readPins(dir)) {
    add({
      address: pin.address,
      title: sites.get(pin.address)?.title ?? shortAddress(pin.address),
      source: 'pinned',
      rank: 3,
    })
  }

  // Signed directories, local first and then any fetched copies.
  const files = [join(dir, 'directory.json')]
  const fetched = join(dir, 'directories')
  if (existsSync(fetched)) {
    try {
      for (const name of readdirSync(fetched)) {
        if (name.endsWith('.json')) files.push(join(fetched, name))
      }
    } catch {
      // ignore unreadable directory caches
    }
  }

  for (const directory of files) {
    if (!existsSync(directory)) continue
    try {
      const verification = verifyDirectory(loadDirectory(directory))
      if (!verification.valid) continue
      for (const site of mergeDirectoryEntries(verification)) {
        add(fromDirectory(site))
      }
    } catch {
      // A malformed directory is skipped rather than breaking the launcher.
    }
  }

  return [...sites.values()]
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .map(({ address, title, source, description }) => ({
      address,
      title,
      source,
      ...(description ? { description } : {}),
    }))
}

function fromDirectory(site: DirectorySite): Candidate {
  return {
    address: site.address,
    title: site.title || shortAddress(site.address),
    source: 'directory',
    rank: 2,
    ...(site.description ? { description: site.description } : {}),
  }
}

function sourceRank(source: SiteSource): number {
  switch (source) {
    case 'directory':
      return 3
    case 'pinned':
      return 2
    default:
      return 1
  }
}

export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address
}
