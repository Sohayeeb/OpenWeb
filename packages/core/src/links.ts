/**
 * Links between sites have to carry an address, because there is no DNS.
 *
 *   openweb://ow1abc…/about.html
 *
 * The gateway rewrites those to /<address>/<path> so a normal browser can follow
 * them. The crawler understands both forms.
 */

import { ADDRESS_LENGTH, isAddress } from './address.js'

export const OPENWEB_SCHEME = 'openweb'

export interface ParsedLink {
  address: string
  path: string
}

export function openwebUrl(address: string, path = '/'): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${OPENWEB_SCHEME}://${address}${normalized}`
}

export function parseOpenWebUrl(value: string): ParsedLink | null {
  const prefix = `${OPENWEB_SCHEME}://`
  if (!value.startsWith(prefix)) return null

  const rest = value.slice(prefix.length)
  const slash = rest.indexOf('/')
  const address = slash === -1 ? rest : rest.slice(0, slash)
  const path = slash === -1 ? '/' : rest.slice(slash)

  if (!isAddress(address)) return null
  return { address, path }
}

/** The gateway form: /<address>/<path>. */
export function parseGatewayPath(value: string): ParsedLink | null {
  if (!value.startsWith('/')) return null
  const rest = value.slice(1)
  const slash = rest.indexOf('/')
  const address = slash === -1 ? rest : rest.slice(0, slash)
  if (address.length !== ADDRESS_LENGTH || !isAddress(address)) return null
  return { address, path: slash === -1 ? '/' : rest.slice(slash) }
}
