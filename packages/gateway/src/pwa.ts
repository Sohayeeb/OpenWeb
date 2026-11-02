/**
 * The installable browser shell bits.
 *
 * A manifest and a service worker make the gateway installable as an app window
 * from Chrome or Edge. The icons are generated here so the repository does not
 * carry binary blobs and the app does not fetch anything from another server.
 */

import { deflateSync } from 'node:zlib'

export const WEB_MANIFEST = {
  name: 'OpenWeb',
  short_name: 'OpenWeb',
  description: 'A peer-to-peer web with no ads, trackers, or hosting bill.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0a0a0b',
  theme_color: '#0a0a0b',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}

/**
 * Network-first, because this is a gateway to live peers. The cache exists so
 * an installed window still opens its own new-tab page when the network is
 * asleep.
 */
export const SERVICE_WORKER = `
const CACHE = 'openweb-shell-v1'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/'])))
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request).catch(async () => {
      if (event.request.mode === 'navigate') {
        const cached = await caches.match('/')
        if (cached) return cached
      }
      return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } })
    }),
  )
})
`

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

/** A dark tile with a green ring: the same mark as the browser chrome. */
export function iconPng(size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = size * 4 + 1
  const pixels = Buffer.alloc(stride * size)
  const center = (size - 1) / 2
  const outer = size * 0.33
  const inner = size * 0.245

  for (let y = 0; y < size; y++) {
    const row = y * stride
    pixels[row] = 0
    for (let x = 0; x < size; x++) {
      const dx = x - center
      const dy = y - center
      const distance = Math.sqrt(dx * dx + dy * dy)
      const at = row + 1 + x * 4
      if (distance <= outer && distance >= inner) {
        // accent: #9ae6b4, with a soft edge near the ring
        pixels[at] = 154
        pixels[at + 1] = 230
        pixels[at + 2] = 180
        pixels[at + 3] = 255
      } else {
        pixels[at] = 10
        pixels[at + 1] = 10
        pixels[at + 2] = 11
        pixels[at + 3] = 255
      }
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
