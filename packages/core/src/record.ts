/**
 * Signed records: the only two things the protocol needs to agree on.
 *
 * A SiteRecord answers "where does this site live right now?"
 * A DirectoryEntry answers "does a human vouch for this site?"
 *
 * Both are plain JSON, signed with the author's key, and independently verifiable.
 */

export interface SiteRecord {
  version: 1
  /** base64url SPKI public key of the site. */
  key: string
  /** Hyperdrive key, hex. Changes if the drive is recreated. */
  drive: string
  /** Human petname. Advisory only, never canonical, never unique. */
  name?: string
  /** Unix ms. */
  updated: number
}

export interface DirectoryEntry {
  version: 1
  site: SiteRecord
  /** Addresses (`ow1…`) of humans who reviewed and recommend this site. */
  recommenders: string[]
  /** Which directory log this belongs to. */
  directory: string
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
