/**
 * The signed directory: a human-kept list of sites that anyone can verify.
 *
 * A directory document is signed by its owner. Each entry is signed by the
 * person who added it, and carries the identity addresses of everyone who
 * vouches for that site. Verification is local and offline: no registry, no
 * certificate authority, no trust-on-first-use.
 *
 * This is deliberately a log, not a database. Append an entry, re-sign, publish
 * the file. A mirror can only repeat it or refuse it, never quietly edit it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isAddress } from './address.js'
import {
  exportPublicKey,
  identityAddress,
  identityAddressFromEncoded,
  importPublicKey,
  publicKeyFromAddress,
  sign,
  verifySignature,
  type Identity,
} from './identity.js'
import { canonicalJSON, type DirectoryDocument, type DirectoryEntry, type DirectorySite, type Signed } from './record.js'

export interface VerifiedEntry {
  entry: DirectoryEntry
  valid: boolean
  errors: string[]
}

export interface DirectoryVerification {
  valid: boolean
  document: DirectoryDocument
  entries: VerifiedEntry[]
  errors: string[]
}

export interface AddEntryOptions {
  /** Extra identity addresses that vouch for this site. */
  recommenders?: string[]
  note?: string
  /** Unix ms; defaults to now. */
  added?: number
}

export function createDirectory(
  identity: Identity,
  name: string,
  description?: string,
): DirectoryDocument {
  return {
    version: 1,
    name: name.trim() || 'Untitled directory',
    ...(description ? { description } : {}),
    author: identityAddress(identity),
    publicKey: exportPublicKey(identity.publicKey),
    updated: Date.now(),
    entries: [],
  }
}

/** Adds (or replaces) a signed entry for this signer. Does not re-sign the root. */
export function addDirectoryEntry(
  document: DirectoryDocument,
  identity: Identity,
  site: Omit<DirectorySite, 'added'> & { added?: number },
  options: AddEntryOptions = {},
): DirectoryDocument {
  if (!isAddress(site.address)) {
    throw new Error(`not an OpenWeb address: ${site.address}`)
  }
  if (document.author !== identityAddress(identity)) {
    throw new Error('only the directory owner can add entries to this document')
  }

  const signer = identityAddress(identity)
  const added = site.added ?? options.added ?? Date.now()
  const entry: DirectoryEntry = {
    version: 1,
    signer,
    site: {
      address: site.address,
      title: site.title.trim() || site.address,
      ...(site.description ? { description: site.description } : {}),
      ...(site.tags && site.tags.length > 0 ? { tags: [...new Set(site.tags)] } : {}),
      added,
    },
    recommenders: [...new Set([signer, ...(options.recommenders ?? [])])],
    directory: document.author,
    added,
    ...(options.note ? { note: options.note } : {}),
  }

  const signed: Signed<DirectoryEntry> = {
    payload: entry,
    signature: sign(identity, new TextEncoder().encode(canonicalJSON(entry))).toString('base64url'),
  }

  const entries = document.entries.filter(
    (existing) =>
      !(existing.payload.signer === signer && existing.payload.site.address === site.address),
  )
  entries.push(signed)

  return { ...document, updated: Date.now(), entries }
}

export function removeDirectoryEntry(
  document: DirectoryDocument,
  identity: Identity,
  address: string,
): DirectoryDocument {
  if (document.author !== identityAddress(identity)) {
    throw new Error('only the directory owner can remove entries')
  }
  const signer = identityAddress(identity)
  const entries = document.entries.filter(
    (entry) => !(entry.payload.signer === signer && entry.payload.site.address === address),
  )
  return { ...document, updated: Date.now(), entries }
}

/** Sign the root document. Entries already carry their own signatures. */
export function signDirectory(
  document: DirectoryDocument,
  identity: Identity,
): Signed<DirectoryDocument> {
  if (document.author !== identityAddress(identity)) {
    throw new Error('only the directory owner can sign this document')
  }
  if (document.publicKey !== exportPublicKey(identity.publicKey)) {
    throw new Error('document public key does not match the signing identity')
  }
  const payload: DirectoryDocument = { ...document, updated: Date.now() }
  return {
    payload,
    signature: sign(identity, new TextEncoder().encode(canonicalJSON(payload))).toString(
      'base64url',
    ),
  }
}

export function createSignedDirectory(
  identity: Identity,
  name: string,
  description?: string,
): Signed<DirectoryDocument> {
  return signDirectory(createDirectory(identity, name, description), identity)
}

export function verifyDirectory(signed: Signed<DirectoryDocument>): DirectoryVerification {
  const errors: string[] = []
  const document = signed.payload

  if (!document || document.version !== 1) {
    errors.push('unsupported directory version')
  }
  if (!isAddress(document.author)) {
    errors.push('directory author is not an identity address')
  }

  let verifiedAuthor = false
  try {
    const derived = identityAddressFromEncoded(document.publicKey)
    if (derived !== document.author) {
      errors.push('directory public key does not match its author address')
    } else {
      verifiedAuthor = true
    }
  } catch {
    errors.push('directory public key is malformed')
  }

  if (verifiedAuthor) {
    try {
      const valid = verifySignature(
        importPublicKey(document.publicKey),
        new TextEncoder().encode(canonicalJSON(document)),
        Buffer.from(signed.signature, 'base64url'),
      )
      if (!valid) errors.push('directory signature does not match its contents')
    } catch {
      errors.push('directory signature is malformed')
    }
  }

  const seen = new Set<string>()
  const entries: VerifiedEntry[] = document.entries.map((signedEntry) => {
    const entry = signedEntry.payload
    const entryErrors: string[] = []

    if (entry.version !== 1) entryErrors.push('unsupported entry version')
    if (entry.directory !== document.author) entryErrors.push('entry belongs to another directory')
    if (!isAddress(entry.signer)) entryErrors.push('signer is not an identity address')
    if (!isAddress(entry.site.address)) entryErrors.push('site address is invalid')
    if (!entry.recommenders.includes(entry.signer)) entryErrors.push('signer does not vouch for the entry')

    const key = `${entry.site?.address}\u0000${entry.signer}`
    if (seen.has(key)) entryErrors.push('duplicate entry')
    seen.add(key)

    try {
      const publicKey = publicKeyFromAddress(entry.signer)
      const valid = verifySignature(
        publicKey,
        new TextEncoder().encode(canonicalJSON(entry)),
        Buffer.from(signedEntry.signature, 'base64url'),
      )
      if (!valid) entryErrors.push('entry signature does not match its contents')
    } catch {
      entryErrors.push('entry public key or signature is malformed')
    }

    // A recommender list is a claim. Only the signer's own key is verified
    // here; mirrors can independently verify additional recommendations if
    // those people publish their own signed entries.
    for (const recommender of entry.recommenders) {
      if (!isAddress(recommender)) entryErrors.push(`invalid recommender: ${recommender}`)
    }

    return { entry, valid: entryErrors.length === 0, errors: entryErrors }
  })

  if (entries.some((entry) => !entry.valid)) errors.push('one or more entries are invalid')

  return {
    valid: errors.length === 0 && entries.every((entry) => entry.valid),
    document,
    entries,
    errors,
  }
}

export function parseDirectory(input: string): Signed<DirectoryDocument> {
  const parsed = JSON.parse(input) as Signed<DirectoryDocument>
  if (!parsed || typeof parsed !== 'object' || !parsed.payload) {
    throw new Error('not a signed directory document')
  }
  return parsed
}

export function saveDirectory(file: string, signed: Signed<DirectoryDocument>): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(signed, null, 2))
}

export function loadDirectory(file: string): Signed<DirectoryDocument> {
  return parseDirectory(readFileSync(file, 'utf8'))
}

/** Group entries by site, merging signatures from multiple people. */
export function mergeDirectoryEntries(
  verification: DirectoryVerification,
): Array<DirectorySite & { recommenders: string[]; notes: string[] }> {
  const sites = new Map<string, DirectorySite & { recommenders: Set<string>; notes: string[] }>()

  for (const { entry, valid } of verification.entries) {
    if (!valid) continue
    let site = sites.get(entry.site.address)
    if (!site) {
      site = {
        ...entry.site,
        recommenders: new Set<string>(),
        notes: [],
      }
      sites.set(entry.site.address, site)
    }
    for (const recommender of entry.recommenders) site.recommenders.add(recommender)
    if (entry.note) site.notes.push(entry.note)
  }

  return [...sites.values()]
    .map((site) => ({
      ...site,
      recommenders: [...site.recommenders],
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}
