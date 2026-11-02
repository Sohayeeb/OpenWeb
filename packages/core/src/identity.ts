/**
 * Identity is for the directory layer, not for site addresses.
 *
 * A site's address comes from its drive key (see address.ts). This keypair is
 * what a *person* uses to sign directory entries and recommendations, so that
 * "a human vouched for this" can be verified offline.
 *
 * Nothing in the `serve` path uses this yet — the directory milestone does.
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

export interface Identity {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, privateKey }
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
