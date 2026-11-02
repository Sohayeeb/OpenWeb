/**
 * A site is a Hyperdrive: an append-only log of files, signed by a key we hold.
 * `drive.key` is the public half of that key, so the address is the site.
 */

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { encodeAddress } from '@openweb/core'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const STORE_DIR = 'store'

/** Directories we never publish, even if the user points us at a repo. */
const SKIP = new Set(['.git', 'node_modules', '.openweb', 'dist'])

export interface Site {
  store: Corestore
  drive: Hyperdrive
  address: string
}

export async function openSite(dir: string): Promise<Site> {
  const store = new Corestore(join(dir, STORE_DIR))
  await store.ready()
  const drive = new Hyperdrive(store)
  await drive.ready()
  return { store, drive, address: encodeAddress(drive.key) }
}

export async function hasIndex(drive: Hyperdrive): Promise<boolean> {
  return (await drive.entry('/index.html')) !== null
}

/**
 * Copies a folder into the drive. Files are added or updated, and files that
 * disappeared locally are unpublished — publish means mirror, not accumulate.
 */
export async function publishFolder(
  drive: Hyperdrive,
  folder: string,
  options: { prune?: boolean } = {},
): Promise<number> {
  let count = 0
  const published = new Set<string>()

  for await (const file of walk(folder)) {
    await drive.put(file.path, await readFile(file.full))
    published.add(file.path)
    count++
  }

  if (options.prune !== false) {
    const stale: string[] = []
    for await (const entry of drive.list('/')) {
      const path =
        typeof entry.key === 'string' ? entry.key : Buffer.from(entry.key).toString()
      if (!published.has(path)) stale.push(path)
    }
    for (const path of stale) await drive.del(path)
  }

  return count
}

async function* walk(
  dir: string,
  base: string = dir,
): AsyncGenerator<{ full: string; path: string }> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      yield* walk(full, base)
    } else if (entry.isFile()) {
      const path = '/' + relative(base, full).split(sep).join('/')
      yield { full, path }
    }
  }
}

export async function initSite(dir: string): Promise<Site> {
  const site = await openSite(dir)
  if (!(await hasIndex(site.drive))) {
    await writeStarter(site)
  }
  return site
}

export async function writeStarter(site: Site): Promise<void> {
  await site.drive.put('/index.html', Buffer.from(starterPage(site.address)))
}

export function starterPage(address: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>hello, OpenWeb</title>
    <style>
      body { background:#0b0b0c; color:#e8e6e1; font:16px/1.6 ui-monospace,Menlo,monospace;
             margin:auto; max-width:34rem; padding:4rem 1.5rem; }
      code { color:#9ae6b4; word-break:break-all; }
      a { color:#9ae6b4; }
      p { color:#8a8780; }
    </style>
  </head>
  <body>
    <h1>it's alive</h1>
    <p>This page is being served from a computer, not a server.</p>
    <p>address<br /><code>${address}</code></p>
    <p>Edit <code>index.html</code> and run <code>openweb serve .</code> again to publish.</p>
  </body>
</html>
`
}
