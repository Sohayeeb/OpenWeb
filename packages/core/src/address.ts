/**
 * Addresses are public keys.
 *
 *   ow1 + base32(32 raw key bytes)  ->  55 characters
 *
 * Encoding is reversible on purpose: given an address you can derive the key
 * directly, with no registry, no DNS, and no lookup. That is the whole trick.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

const LOOKUP: Readonly<Record<string, number>> = Object.fromEntries(
  Array.from(ALPHABET, (ch, i) => [ch, i]),
)

export const ADDRESS_PREFIX = 'ow1'
export const KEY_BYTES = 32
export const ADDRESS_LENGTH = ADDRESS_PREFIX.length + 52

/** RFC 4648 base32, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(input: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []

  for (const ch of input) {
    const digit = LOOKUP[ch]
    if (digit === undefined) {
      throw new Error(`invalid base32 character: ${JSON.stringify(ch)}`)
    }
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

export function encodeAddress(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`address keys are ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return ADDRESS_PREFIX + base32(key)
}

export function decodeAddress(address: string): Uint8Array {
  if (!address.startsWith(ADDRESS_PREFIX)) {
    throw new Error(`not an OpenWeb address: ${address}`)
  }
  const bytes = base32Decode(address.slice(ADDRESS_PREFIX.length))
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`address decodes to ${bytes.length} bytes, expected ${KEY_BYTES}`)
  }
  return bytes
}

export function isAddress(value: string): boolean {
  if (value.length !== ADDRESS_LENGTH) return false
  try {
    decodeAddress(value)
    return true
  } catch {
    return false
  }
}
