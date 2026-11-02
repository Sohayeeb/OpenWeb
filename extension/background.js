/**
 * OpenWeb Mode — the gate.
 *
 * When enabled, the browser can reach exactly two things:
 *
 *   1. the local gateway (`http://127.0.0.1:8080` by default), and
 *   2. OpenWeb addresses listed in a signed directory you loaded yourself.
 *
 * The second rule is enforced on navigation: the gateway serves sites under
 * /<address>/, and any address that is not in the verified directory is
 * redirected to blocked.html. There is no "allow once" button. Allowlisting is
 * editing a signed document, which is why it is a deliberate act.
 *
 * Signatures are checked with WebCrypto (Ed25519), the same format as the CLI.
 * The extension never trusts the gateway: it receives the signed JSON and
 * verifies every entry locally.
 */

const DEFAULTS = {
  enabled: false,
  gateway: 'http://127.0.0.1:8080',
  strict: true,
  signed: null,
  verification: null,
}

const ADDRESS_RE = /^ow1[a-z2-7]{52}$/
// Ed25519 SubjectPublicKeyInfo is a fixed 12-byte DER header plus the raw key.
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const LOOKUP = Object.fromEntries([...ALPHABET].map((char, index) => [char, index]))

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

function base32Decode(input) {
  let bits = 0
  let value = 0
  const out = []

  for (const char of input) {
    const digit = LOOKUP[char]
    if (digit === undefined) throw new Error(`invalid base32 character: ${char}`)
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

function base64urlDecode(input) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob(padded)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

/** Deterministic JSON: sorted keys, no whitespace. Matches core's canonicalJSON. */
function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    )
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

async function publicKeyForAddress(address) {
  if (!ADDRESS_RE.test(address)) throw new Error('not an identity address')
  const raw = base32Decode(address.slice(3))
  if (raw.length !== 32) throw new Error('address does not encode a 32-byte key')
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + raw.length)
  spki.set(ED25519_SPKI_PREFIX, 0)
  spki.set(raw, ED25519_SPKI_PREFIX.length)
  return crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify'])
}

function addressForKey(raw) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of raw) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return `ow1${out}`
}

async function verifyEntry(signedEntry, document) {
  const errors = []
  const entry = signedEntry?.payload
  if (!entry || entry.version !== 1) return { valid: false, errors: ['unsupported entry version'] }

  if (entry.directory !== document.author) errors.push('entry belongs to another directory')
  if (!ADDRESS_RE.test(entry.signer)) errors.push('signer is not an identity address')
  if (!entry.site || !ADDRESS_RE.test(entry.site.address)) errors.push('site address is invalid')
  if (!Array.isArray(entry.recommenders) || !entry.recommenders.includes(entry.signer)) {
    errors.push('signer does not vouch for the entry')
  }

  try {
    const key = await publicKeyForAddress(entry.signer)
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64urlDecode(signedEntry.signature),
      new TextEncoder().encode(canonicalJSON(entry)),
    )
    if (!valid) errors.push('entry signature does not match its contents')
  } catch {
    errors.push('entry signature is malformed')
  }

  return { valid: errors.length === 0, entry, errors }
}

/**
 * Verify a signed directory and return both the verdict and the allowlist.
 * Nothing is cached by address: the caller stores the verdict explicitly.
 */
async function verifyDirectory(signed) {
  const errors = []
  const document = signed?.payload

  if (!document || document.version !== 1) {
    return { valid: false, errors: ['not a signed directory document'], sites: [] }
  }
  if (!ADDRESS_RE.test(document.author)) errors.push('directory author is not an identity address')

  try {
    const raw = base32Decode(document.author.slice(3))
    const derived = addressForKey(raw)
    if (derived !== document.author) errors.push('directory key does not match its author address')

    const key = await publicKeyForAddress(document.author)
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64urlDecode(signed.signature),
      new TextEncoder().encode(canonicalJSON(document)),
    )
    if (!valid) errors.push('directory signature does not match its contents')
  } catch {
    errors.push('directory public key or signature is malformed')
  }

  const entries = []
  const sites = new Map()
  if (Array.isArray(document.entries)) {
    for (const signedEntry of document.entries) {
      const verified = await verifyEntry(signedEntry, document)
      entries.push(verified)
      if (!verified.valid) continue

      const entry = verified.entry
      let site = sites.get(entry.site.address)
      if (!site) {
        site = {
          address: entry.site.address,
          title: entry.site.title || entry.site.address,
          description: entry.site.description || '',
          tags: Array.isArray(entry.site.tags) ? entry.site.tags : [],
          recommenders: new Set(),
          notes: [],
        }
        sites.set(entry.site.address, site)
      }
      for (const recommender of entry.recommenders) site.recommenders.add(recommender)
      if (entry.note) site.notes.push(entry.note)
    }
  } else {
    errors.push('directory has no entry list')
  }

  if (entries.some((entry) => !entry.valid)) errors.push('one or more entries are invalid')

  return {
    valid: errors.length === 0,
    errors,
    author: document.author,
    name: document.name,
    updated: document.updated,
    entryCount: entries.length,
    sites: [...sites.values()]
      .map((site) => ({
        address: site.address,
        title: site.title,
        description: site.description,
        tags: site.tags,
        recommenders: [...site.recommenders],
        notes: site.notes,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    verifiedAt: Date.now(),
  }
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...stored }
}

async function setState(patch) {
  await chrome.storage.local.set(patch)
  return getState()
}

/* -------------------------------------------------------------------------- */
/* Network rules                                                              */
/* -------------------------------------------------------------------------- */

const BLOCK_RULE_ID = 1
const ALLOW_RULE_ID = 2
const BLOCKED_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'script',
  'stylesheet',
  'image',
  'font',
  'xmlhttprequest',
  'media',
  'websocket',
  'ping',
]

/**
 * DNR is the blunt layer: while the mode is on, no request may leave for a
 * host other than the gateway (and localhost mirrors). The tab listener is the
 * precise layer: an OpenWeb path must be in the signed allowlist.
 */
async function applyRules(state) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BLOCK_RULE_ID, ALLOW_RULE_ID],
    addRules: state.enabled
      ? [
          {
            id: BLOCK_RULE_ID,
            priority: 1,
            action: { type: 'block' },
            condition: {
              urlFilter: '|http',
              resourceTypes: BLOCKED_RESOURCE_TYPES,
              excludedRequestDomains: allowedDomains(state),
            },
          },
        ]
      : [],
  })
}

function allowedDomains(state) {
  const domains = new Set(['127.0.0.1', 'localhost', '::1'])
  try {
    const gateway = new URL(state.gateway)
    if (gateway.hostname) domains.add(gateway.hostname)
  } catch {
    // A bad gateway string is handled by the options page; keep localhost open.
  }
  return [...domains]
}

async function updateBadge(state) {
  await chrome.action.setBadgeText({ text: state.enabled ? 'ON' : '' })
  await chrome.action.setBadgeBackgroundColor({ color: state.enabled ? '#2f6b43' : '#6d6a64' })
  await chrome.action.setTitle({
    title: state.enabled ? 'OpenWeb mode: on — click to disable' : 'OpenWeb mode: off — click to enable',
  })
}

async function bootstrap() {
  const state = await getState()
  if (state.signed && !state.verification) {
    const verification = await verifyDirectory(state.signed)
    await setState({ verification })
  }
  await applyRules(state)
  await updateBadge(state)
}

chrome.runtime.onInstalled.addListener(() => void bootstrap())
chrome.runtime.onStartup.addListener(() => void bootstrap())

chrome.action.onClicked.addListener(async () => {
  const state = await getState()
  const next = await setState({ enabled: !state.enabled })
  await applyRules(next)
  await updateBadge(next)
})

/* -------------------------------------------------------------------------- */
/* Navigation gate                                                            */
/* -------------------------------------------------------------------------- */

const redirecting = new Set()

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url ?? tab?.url
  if (!url || redirecting.has(tabId)) return
  void checkNavigation(tabId, url)
})

async function checkNavigation(tabId, url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return

  const state = await getState()
  if (!state.enabled) return

  let gateway
  try {
    gateway = new URL(state.gateway)
  } catch {
    return
  }

  // Anything outside the gateway is already blocked by DNR. This is the
  // belt-and-braces path for requests DNR does not see (for example a
  // navigation restored before the rule was installed).
  if (parsed.origin !== gateway.origin) {
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return
    block(tabId, url, 'outside-gateway')
    return
  }

  const match = parsed.pathname.match(/^\/(ow1[a-z2-7]{52})(\/|$)/)
  if (!match) return // gateway shell: /, /search, /sites, /builder, …

  const address = match[1]
  if (!state.strict) return

  const allowed = new Set(state.verification?.sites?.map((site) => site.address) ?? [])
  if (!allowed.has(address)) block(tabId, url, 'not-in-directory')
}

function block(tabId, url, reason) {
  redirecting.add(tabId)
  const target = chrome.runtime.getURL(
    `blocked.html?reason=${encodeURIComponent(reason)}&url=${encodeURIComponent(url)}`,
  )
  void chrome.tabs.update(tabId, { url: target }).catch(() => undefined)
  setTimeout(() => redirecting.delete(tabId), 1_000)
}

/* -------------------------------------------------------------------------- */
/* Messages from the options page                                             */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }))
  return true
})

async function handleMessage(message) {
  switch (message?.type) {
    case 'status': {
      const state = await getState()
      return { state }
    }

    case 'set-enabled': {
      const next = await setState({ enabled: Boolean(message.enabled) })
      await applyRules(next)
      await updateBadge(next)
      return { state: next }
    }

    case 'set-strict': {
      const next = await setState({ strict: Boolean(message.strict) })
      return { state: next }
    }

    case 'set-gateway': {
      const gateway = String(message.gateway ?? '').trim()
      const parsed = new URL(gateway)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('the gateway must be an http(s) URL')
      }
      const next = await setState({ gateway: parsed.origin })
      await applyRules(next)
      return { state: next }
    }

    case 'save-directory': {
      const signed = message.signed
      if (!signed || !signed.payload || typeof signed.signature !== 'string') {
        throw new Error('paste a signed directory document (the JSON file)')
      }
      const verification = await verifyDirectory(signed)
      const next = await setState({ signed, verification })
      return { state: next, verification }
    }

    case 'load-from-gateway': {
      const state = await getState()
      const url = new URL('/directory?format=json', state.gateway)
      if (message.address) url.searchParams.set('address', message.address)
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`gateway answered ${response.status}`)
      const body = await response.json()
      if (!body.signed) throw new Error(body.errors?.[0] ?? 'the gateway has no signed directory')
      const verification = await verifyDirectory(body.signed)
      const next = await setState({ signed: body.signed, verification })
      return { state: next, verification }
    }

    case 'clear-directory': {
      const next = await setState({ signed: null, verification: null })
      return { state: next }
    }

    default:
      throw new Error(`unknown message: ${String(message?.type)}`)
  }
}
