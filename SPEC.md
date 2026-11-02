# OpenWeb Protocol — Draft 0.1

One page. If it doesn't fit on one page, the design is wrong.

## 1. What this is

A peer-to-peer web. Pages are served from the machine of the person who made them.
There is no server in the middle, no ads, no trackers, no analytics, and no
AI-generated content.

## 2. The one rule

Content is published by a human who signs it with a key, and appears in the
directory only after a human has looked at it. Names can be revoked.

Everything else is unregulated.

## 3. Naming

An address is a public key, written as `ow1` followed by 52 base32 characters.

```
ow1vkmfwikivezc27lqizjyoapya2bqhyh63d6hofbn6rdpemdtybdq
```

That is the canonical name. It never changes and it cannot be taken. The encoding
is reversible: the address *is* the key, so resolution needs no lookup table.

Human-readable labels ("bob") are **petnames**. They live in signed directory
entries, never in the protocol. Two people can both name a site "bob" and nobody
has to arbitrate. There is no registrar, no renewal, no fee, no land grab.

## 4. Records

A site is a Hyperdrive: an append-only, signed log of files. Minimum contents:

```
/index.html        required
/.openweb/name     optional, the human label
/.openweb/about    optional, plain text
```

The gateway serves static files only. No scripts execute in v1. No cookies, no
headers that identify a visitor, no referrer.

A page may opt into the gateway's browser chrome with:

```html
<meta name="openweb:browser" content="on" />
```

When present, the gateway adds its address bar and search box above the page.
The page's own markup is unchanged, and the crawler requests pages without the
chrome so navigation text never enters the index. Ordinary sites stay ordinary.

## 5. Transport

Hyperswarm DHT. Peers find each other by the site key. Hole punching is attempted
first; if both peers sit behind symmetric NAT, traffic falls back to a relay that
sees ciphertext only.

No ports are opened. No DNS. No IP addresses in URLs. A node that goes offline
takes its site offline.

## 6. Trust

- Every block is signed by the site key. A tampered drive fails to load.
- The directory is a signed log of recommendations. Anyone can mirror it.
- Revocation is a signed tombstone. Gateways stop resolving it; peers stop serving it.

## 7. Discovery

There is no global index, and nothing is crawled unless a human starts it.

A search engine on OpenWeb is just a peer that:

- crawls outward from a list of seeds it trusts
- writes an index that it owns
- answers queries against that index

Anyone can run one, and readers choose which index to query. Words are
Porter-stemmed, phrases use token positions, and ranking is BM25 with a title
bonus. There is no personalization, no click tracking, and no advertising
surface.

## 8. Out of scope for v1

Comments. Accounts. JavaScript. Mobile. Money. AI anything. Uptime guarantees.
Fuzzy matching, synonyms, query expansion, and learned ranking models.

## 9. Non-goals

This is not the World Wide Web, and it does not try to replace it. It is a
neighborhood with a gate: small, curated, accountable, and boring to maintain.
