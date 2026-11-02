import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAddress } from './address.js'
import {
  addDirectoryEntry,
  createSignedDirectory,
  mergeDirectoryEntries,
  removeDirectoryEntry,
  signDirectory,
  verifyDirectory,
} from './directory.js'
import { generateIdentity, identityAddress } from './identity.js'
import { canonicalJSON, type Signed, type DirectoryDocument } from './record.js'

const SITE = encodeAddress(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff))
const OTHER_SITE = encodeAddress(Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff))

test('a signed directory verifies offline', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list', 'Small pages only')
  const verified = verifyDirectory(signed)

  assert.equal(verified.valid, true)
  assert.deepEqual(verified.errors, [])
  assert.equal(verified.document.author, identityAddress(identity))
  assert.equal(verified.entries.length, 0)
})

test('adding an entry signs it with the author key', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list')
  const withEntry = addDirectoryEntry(signed.payload, identity, {
    address: SITE,
    title: 'Garden notes',
    description: 'Tomatoes and soil',
    tags: ['garden', 'food'],
  })
  const reSigned: Signed<DirectoryDocument> = signDirectory(withEntry, identity)
  const verified = verifyDirectory(reSigned)

  assert.equal(verified.valid, true)
  assert.equal(verified.entries.length, 1)
  assert.equal(verified.entries[0]?.entry.site.title, 'Garden notes')
  assert.deepEqual(verified.entries[0]?.entry.site.tags, ['garden', 'food'])
  assert.ok(verified.entries[0]?.entry.recommenders.includes(identityAddress(identity)))

  const sites = mergeDirectoryEntries(verified)
  assert.equal(sites.length, 1)
  assert.equal(sites[0]?.address, SITE)
  assert.equal(sites[0]?.tags?.[0], 'garden')
})

test('an entry cannot be edited without breaking its signature', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list')
  const withEntry = addDirectoryEntry(signed.payload, identity, {
    address: SITE,
    title: 'Garden notes',
  })
  const reSigned = signDirectory(withEntry, identity)

  // Change the signed entry payload but keep the old signature.
  const tampered: Signed<DirectoryDocument> = {
    ...reSigned,
    payload: {
      ...reSigned.payload,
      entries: reSigned.payload.entries.map((entry) => ({
        ...entry,
        payload: { ...entry.payload, site: { ...entry.payload.site, title: 'Free money' } },
      })),
    },
  }

  const verified = verifyDirectory(tampered)
  assert.equal(verified.valid, false)
  assert.equal(verified.entries[0]?.valid, false)
  assert.ok(verified.entries[0]?.errors.some((error) => error.includes('signature')))
})

test('the root document signature covers its name and entry list', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list')
  const tampered: Signed<DirectoryDocument> = {
    ...signed,
    payload: { ...signed.payload, name: 'Somebody else’s list' },
  }

  const verified = verifyDirectory(tampered)
  assert.equal(verified.valid, false)
  assert.ok(verified.errors.some((error) => error.includes('signature')))
})

test('a directory signed by one key cannot claim another author', () => {
  const owner = generateIdentity()
  const impostor = generateIdentity()
  const signed = createSignedDirectory(owner, 'Real list')
  const tampered: Signed<DirectoryDocument> = {
    ...signed,
    payload: { ...signed.payload, author: identityAddress(impostor) },
  }

  const verified = verifyDirectory(tampered)
  assert.equal(verified.valid, false)
  assert.ok(verified.errors.some((error) => error.includes('does not match its author')))
})

test('only the owner may add or remove entries', () => {
  const owner = generateIdentity()
  const other = generateIdentity()
  const signed = createSignedDirectory(owner, 'Owner list')

  assert.throws(
    () => addDirectoryEntry(signed.payload, other, { address: SITE, title: 'Nope' }),
    /only the directory owner/,
  )
  assert.throws(() => removeDirectoryEntry(signed.payload, other, SITE), /only the directory owner/)
})

test('removing an entry re-signs a shorter list', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list')
  const two = addDirectoryEntry(signed.payload, identity, { address: SITE, title: 'One' })
  const three = addDirectoryEntry(two, identity, { address: OTHER_SITE, title: 'Two' })
  const removed = removeDirectoryEntry(three, identity, SITE)
  const verified = verifyDirectory(signDirectory(removed, identity))

  assert.equal(verified.valid, true)
  assert.equal(verified.entries.length, 1)
  assert.equal(verified.entries[0]?.entry.site.address, OTHER_SITE)
})

test('canonical JSON is stable regardless of key insertion order', () => {
  const left = canonicalJSON({ b: 1, a: { d: 4, c: 3 } })
  const right = canonicalJSON({ a: { c: 3, d: 4 }, b: 1 })
  assert.equal(left, right)
  assert.equal(left, '{"a":{"c":3,"d":4},"b":1}')
})

test('re-adding the same site replaces the old entry for that signer', () => {
  const identity = generateIdentity()
  const signed = createSignedDirectory(identity, 'Ada’s list')
  const first = addDirectoryEntry(signed.payload, identity, { address: SITE, title: 'Old' })
  const second = addDirectoryEntry(first, identity, { address: SITE, title: 'New' })
  const verified = verifyDirectory(signDirectory(second, identity))

  assert.equal(verified.entries.length, 1)
  assert.equal(verified.entries[0]?.entry.site.title, 'New')
})
