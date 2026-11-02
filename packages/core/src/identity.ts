/**
 * Identity is for the directory layer, not for site addresses.
 *
 * A site's address comes from its drive key (see address.ts). This keypair is
 * what a *person* uses to sign directory entries and recommendations, so that
 * "a human vouched for this" can be verified offline.
 *
 * The identity's public key is also 32 bytes, so it can be written as an
 * ordinary `ow1…` address. That gives a person a stable, verifiable name
 * without a registry. A site address and an identity address occupy the same
 * namespace on purpose; they are never used interchangeably by the protocol.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { decodeAddress, encodeAddress } from './address.js'

export interface Identity {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

/** Ed25519 keys in SPKI DER are a 12-byte header followed by the raw key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, privateKey }
}

/** The raw 32-byte Ed25519 public key. */
export function publicKeyRaw(publicKey: KeyObject): Uint8Array {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  if (der.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new Error(`expected an ed25519 SPKI key, got ${der.length} bytes`)
  }
  return Uint8Array.from(der.subarray(ED25519_SPKI_PREFIX.length))
}

/** Rebuild an ed25519 public key from the raw bytes carried by an address. */
export function publicKeyFromAddress(address: string): KeyObject {
  const raw = decodeAddress(address)
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  })
}

/** An identity address is `ow1` + base32(raw ed25519 public key). */
export function publicKeyAddress(publicKey: KeyObject): string {
  return encodeAddress(publicKeyRaw(publicKey))
}

export function identityAddress(identity: Identity): string {
  return publicKeyAddress(identity.publicKey)
}

export function identityAddressFromEncoded(encoded: string): string {
  return publicKeyAddress(importPublicKey(encoded))
}

/** Ed25519 signature over raw bytes. */
export function sign(identity: Identity, payload: Uint8Array): Buffer {
  return cryptoSign(null, payload, identity.privateKey)
}

export function verifySignature(
  publicKey: KeyObject,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  return cryptoVerify(null, payload, publicKey, signature)
}

export function exportPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

export function importPublicKey(encoded: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'spki',
  })
}

export interface StoredIdentity {
  version: 1
  privateKey: string
}

/** Writes the private key as PKCS8 DER, base64url, mode 0600. */
export function saveIdentity(identity: Identity, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const stored: StoredIdentity = {
    version: 1,
    privateKey: identity.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url'),
  }
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 })
}

export function loadIdentity(path: string): Identity {
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredIdentity
  if (stored.version !== 1) {
    throw new Error(`unsupported identity version: ${String(stored.version)}`)
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(stored.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

/** Load an identity, creating and saving one on first use. */
export function ensureIdentity(path: string): Identity {
  try {
    return loadIdentity(path)
  } catch {
    const identity = generateIdentity()
    saveIdentity(identity, path)
    return identity
  }
}
