/**
 * Signed records: the only things the protocol needs to agree on.
 *
 * A SiteRecord answers "where does this site live right now?"
 * A DirectoryEntry answers "does a human vouch for this site?"
 *
 * Both are plain JSON, signed with the author's key, and independently verifiable.
 */

export interface SiteRecord {
  version: 1
  /** Site drive address (`ow1…`). */
  address: string
  /** Human petname. Advisory only, never canonical, never unique. */
  name?: string
  /** Unix ms. */
  updated: number
}

export interface DirectorySite {
  /** Site drive address (`ow1…`). */
  address: string
  title: string
  description?: string
  tags?: string[]
  /** Unix ms. */
  added: number
}

export interface DirectoryEntry {
  version: 1
  /** Identity address of the human who signed this entry. */
  signer: string
  site: DirectorySite
  /** Identity addresses that vouch for this entry, including `signer`. */
  recommenders: string[]
  /** Identity address of the directory owner. */
  directory: string
  /** Unix ms. */
  added: number
  note?: string
}

export interface DirectoryDocument {
  version: 1
  name: string
  description?: string
  /** Identity address of the directory owner. */
  author: string
  /** base64url SPKI public key of the directory owner. */
  publicKey: string
  /** Unix ms. */
  updated: number
  entries: Signed<DirectoryEntry>[]
}

export interface Signed<T> {
  payload: T
  /** base64url ed25519 signature over canonicalJSON(payload). */
  signature: string
}

/** Deterministic JSON: sorted keys, no whitespace. Signatures depend on it. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}
