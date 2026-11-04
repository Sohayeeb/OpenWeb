/**
 * Address-bar parsing and the translation between what the user sees
 * (`openweb://…`) and what the content view actually loads (a loopback URL
 * owned by the gateway). The loopback origin never leaves this file's callers.
 */

import { isAddress } from '@openweb/core'

export const HOME = 'openweb://home'

/** Gateway pages that are part of OpenWeb itself, not a site address. */
const PAGES = new Set(['search', 'sites', 'directory', 'shared', 'builder', 'publish'])

export interface Resolution {
  kind: 'internal' | 'external'
  /** Path on the internal gateway, including query and hash. */
  path: string
  /** The text to keep in the address bar. */
  display: string
}

/** Trim a user-typed address and decide where it should go. */
export function resolveAddressInput(input: string): Resolution {
  const value = input.trim()
  if (value === '') return { kind: 'internal', path: '/', display: HOME }

  if (/^openweb:\/\//i.test(value)) {
    return resolveOpenWebUrl(value)
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^ow1/i.test(value)) {
    if (/^https?:\/\//i.test(value)) {
      return { kind: 'external', path: value, display: value }
    }
    // A non-web scheme is not something the content view can render.
    return searchFor(value)
  }

  if (value === 'home' || value === '/') {
    return { kind: 'internal', path: '/', display: HOME }
  }

  if (PAGES.has(value.split(/[/?#]/)[0] ?? '')) {
    return internal(value)
  }

  const slash = value.indexOf('/')
  const first = slash === -1 ? value : value.slice(0, slash)
  if (isAddress(first)) {
    const path = slash === -1 ? '/' : value.slice(slash)
    return internal(`/${first}${path.startsWith('/') ? path : `/${path}`}`)
  }

  return searchFor(value)
}

function resolveOpenWebUrl(value: string): Resolution {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return searchFor(value.replace(/^openweb:\/\//i, ''))
  }

  const host = url.hostname.toLowerCase()
  const path = url.pathname || '/'
  const suffix = `${url.search}${url.hash}`

  if (host === '' || host === 'home' || host === 'newtab') {
    return { kind: 'internal', path: `/${suffix}`, display: HOME }
  }

  if (PAGES.has(host)) {
    const joined = path === '/' ? `/${host}` : `/${host}${path}`
    return internal(`${joined}${suffix}`)
  }

  if (isAddress(host)) {
    const sitePath = path === '' || path === '/' ? '/' : path
    return internal(`/${host}${sitePath}${suffix}`)
  }

  // openweb://something-else is a search, just like Chrome treats a bare word.
  return searchFor(`${host}${path === '/' ? '' : path}${suffix}`)
}

function internal(path: string): Resolution {
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return { kind: 'internal', path: withSlash, display: displayForPath(withSlash) }
}

function searchFor(query: string): Resolution {
  const trimmed = query.trim()
  if (trimmed === '') return { kind: 'internal', path: '/', display: HOME }
  const search = `?q=${encodeURIComponent(trimmed)}`
  return { kind: 'internal', path: `/search${search}`, display: `openweb://search${search}` }
}

/** What the address bar shows for a path on the internal gateway. */
export function displayForPath(path: string): string {
  const [pathname, rest = ''] = splitOnce(path, '?')
  const [cleanPath, hash = ''] = splitOnce(pathname, '#')
  const suffix = `${rest ? `?${rest}` : ''}${hash ? `#${hash}` : ''}`

  if (cleanPath === '/' || cleanPath === '') return HOME

  for (const page of PAGES) {
    if (cleanPath === `/${page}`) return `openweb://${page}${suffix}`
  }

  const segments = cleanPath.split('/').filter(Boolean)
  const address = segments[0] ?? ''
  if (isAddress(address)) {
    const sitePath = cleanPath.slice(address.length + 1) || '/'
    return `openweb://${address}${sitePath}${suffix}`
  }

  return HOME
}

/**
 * Turn a URL the content view landed on into address-bar text.
 * Returns null for internal URLs that should not be exposed.
 */
export function displayForUrl(url: string, gatewayOrigin: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.origin === gatewayOrigin) {
    return displayForPath(`${parsed.pathname}${parsed.search}${parsed.hash}`)
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
  if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return HOME
  return null
}

/** Absolute internal URL for a gateway path. */
export function internalUrl(gatewayUrl: string, path: string): string {
  return gatewayUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`)
}

function splitOnce(value: string, separator: string): [string, string?] {
  const at = value.indexOf(separator)
  if (at === -1) return [value]
  return [value.slice(0, at), value.slice(at + 1)]
}
