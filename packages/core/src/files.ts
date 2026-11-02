export interface ReadableDrive {
  get(path: string, options?: { timeout?: number }): Promise<Uint8Array | null>
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
}

export function contentType(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Turns a request URL into a drive path. No query strings, no traversal, no
 * surprises: directories resolve to index.html.
 */
export function drivePathFor(requestUrl: string): string {
  const pathname = decodeURIComponent(requestUrl.split('?')[0] ?? '/')
  const segments = pathname
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')

  if (segments.some((segment) => segment === '..')) {
    throw new Error('path traversal')
  }
  if (segments.length === 0) return '/index.html'
  if (pathname.endsWith('/')) return `/${segments.join('/')}/index.html`
  return `/${segments.join('/')}`
}

export interface FileResponse {
  status: number
  type: string
  body: Uint8Array
}

export async function readFromDrive(
  drive: ReadableDrive,
  requestUrl: string,
  options: { timeout?: number } = {},
): Promise<FileResponse> {
  const path = drivePathFor(requestUrl)

  let body: Uint8Array | null = null
  try {
    body = await drive.get(path, options)
  } catch {
    body = null
  }

  if (body === null) {
    return {
      status: 404,
      type: 'text/plain; charset=utf-8',
      body: new TextEncoder().encode('not found\n'),
    }
  }

  return { status: 200, type: contentType(path), body }
}
