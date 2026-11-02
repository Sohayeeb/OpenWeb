/**
 * Starting a node is four steps and done:
 *
 *   identity -> drive -> swarm -> localhost
 *
 * There is no server in the middle. If this process stops, the site is offline.
 */

import { readFromDrive } from '@openweb/core'
import Hyperswarm from 'hyperswarm'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { hasIndex, initSite, openSite, publishFolder, writeStarter } from './site.js'

export const DEFAULT_DIR = '.openweb'
export const DEFAULT_PORT = 7777

export interface NodeOptions {
  /** Where the identity and drive live. Defaults to ./.openweb */
  dir?: string
  /** Folder to publish from. Omit to serve whatever is already in the drive. */
  folder?: string
  /** Local preview port, bound to 127.0.0.1 only. */
  port?: number
}

export interface OpenWebNode {
  address: string
  previewUrl: string
  /** Files published on this run. */
  published: number
  close(): Promise<void>
}

export async function startNode(options: NodeOptions = {}): Promise<OpenWebNode> {
  const dir = resolve(options.dir ?? DEFAULT_DIR)
  const port = options.port ?? DEFAULT_PORT

  const site = await openSite(dir)

  let published = 0
  if (options.folder) {
    published = await publishFolder(site.drive, resolve(options.folder))
  } else if (!(await hasIndex(site.drive))) {
    await writeStarter(site)
    published = 1
  }

  const swarm = new Hyperswarm()
  swarm.on('connection', (socket, info) => {
    if (process.env['OPENWEB_DEBUG']) {
      const peer = socket as unknown as { remoteHost?: string; remotePort?: number }
      console.error(
        `[node] peer connected (${peer.remoteHost ?? '?'}:${peer.remotePort ?? '?'}, relayed: ${info.forceRelaying ? 'yes' : 'no'})`,
      )
    }
    site.store.replicate(socket)
  })

  const discovery = swarm.join(site.drive.discoveryKey)
  await discovery.flushed()

  const server = createServer((request, response) => {
    void (async () => {
      const file = await readFromDrive(site.drive, request.url ?? '/')
      response.writeHead(file.status, {
        'content-type': file.type,
        'cache-control': 'no-store',
        'x-openweb-address': site.address,
      })
      response.end(file.body)
    })()
  })

  await listen(server, port)

  return {
    address: site.address,
    previewUrl: `http://127.0.0.1:${port}/`,
    published,
    async close() {
      await closing(server)
      await discovery.destroy()
      await swarm.destroy()
      await site.store.close()
    },
  }
}

/** Create the drive and a starter page, but do not go online. */
export async function initNode(dir: string = DEFAULT_DIR): Promise<string> {
  const site = await initSite(resolve(dir))
  const address = site.address
  await site.store.close()
  return address
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolvePromise())
  })
}

function closing(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}
