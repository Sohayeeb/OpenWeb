# OpenWeb

A peer-to-peer web. Pages are served from the machine of the person who made them.
No ads. No trackers. No AI-generated content. No hosting bill.

**Status:** working vertical slice. One command publishes the site in `app/`,
starts the browser-like gateway, crawls the site, and builds a local index. The
gateway can open any address, search what it has read, and list every site on
this machine.

```
$ node packages/cli/dist/index.js start
openweb is running

  site      http://127.0.0.1:8080/ow1wlb2qu7omgqmfzhpcrrvaupqti2uuuq5fepvsbbfkfngpjqicvaq/
  browser   http://127.0.0.1:8080/
  address   ow1wlb2qu7omgqmfzhpcrrvaupqti2uuuq5fepvsbbfkfngpjqicvaq

indexing this site…
  indexed 8 page(s); 8 document(s) in the local index

Open http://127.0.0.1:8080/ in a browser. Ctrl+C to stop.
```

## Try it

```
npm install
npm run build
node packages/cli/dist/index.js start
```

Open `http://127.0.0.1:8080/`. You get a new-tab page with a search box, an
address bar, and every site this machine has crawled. The site itself is at the
printed address. `Ctrl+C` takes it offline.

`start` is just the convenient bundle. The pieces also run separately:

```
# terminal 1 — publish the unified site from this PC
node packages/cli/dist/index.js serve app

# terminal 2 — the browser bridge
node packages/cli/dist/index.js gateway

# terminal 3 — teach the local index about the address
node packages/cli/dist/index.js crawl <address> --dir .openweb
```

Then open `http://127.0.0.1:8080/<address>/`, or:

```
node packages/cli/dist/index.js open <address>
```

The gateway fetches the page from the first terminal, over a DHT, and hands it
back as plain HTTP. Stop terminal 1 and the site goes offline. That is the
uptime model.

## One site, connected

`app/` is the whole OpenWeb site: a home page, a hand-kept directory, three
ordinary pages, a publishing guide, a search page, and the rules. It is eight
static files and one stylesheet. There is no JavaScript in it.

The gateway is the browser around it:

| URL | What it does |
| --- | --- |
| `/` | New tab: search, open an address, and every site you have crawled |
| `/<address>/` | Resolve a key, join its DHT topic, serve the files |
| `/search?q=…` | Query the local index; add `&format=json` for machines |
| `/sites` | Every crawled address, grouped by key, with its pages |
| `/open?to=…` | The address bar: accepts a key, an `openweb://` link, or a gateway path |

Pages can opt into a small browser bar with one meta tag:

```html
<meta name="openweb:browser" content="on" />
```

The gateway then adds the current `openweb://` address, the address form, a
search box, and links to the new-tab and sites pages. It does not add scripts.
The crawler asks for pages without the bar, so navigation text never pollutes
the index. Plain sites that do not opt in are served exactly as written.

## Search

A search engine here is not a company. It is a crawler plus a file.

```
node packages/cli/dist/index.js crawl <address> <address> --dir .openweb
node packages/cli/dist/index.js search "slow garden" --dir .openweb
```

`crawl` walks out from the seeds you give it (4 fetches in parallel by default),
follows links, and writes `.openweb/index.json`. Re-running merges into the
existing index; `--fresh` rebuilds it. `search` queries that file. The gateway
serves the same index at `http://127.0.0.1:8080/search?q=slow+garden`.

Query syntax:

| Query | Meaning |
| --- | --- |
| `tomato soil` | both words must appear |
| `"slow garden"` | exact phrase, consecutive words |
| `tomato -coffee` | exclude pages containing coffee |
| `title:garden` | word must appear in the title |
| `compost OR beans` | either word may appear |

Words are Porter-stemmed, so `tomatoes` matches `tomato`. Ranking is BM25 with a
title boost; no personalization, no click tracking, no ads.

`/search?format=json` returns the same results machine-readably, including
`tookMs`, `total`, and whether the answer came from cache. The gateway caches the
parsed index by mtime and keeps the last 256 queries, so repeat searches are
effectively free.

Coverage is exactly what you seeded and what those pages link to. That is an
honest limitation and also the point — a search engine with a small,
accountable web.

## Performance

`npm run bench` builds a 20,000-page synthetic corpus (2.8M words, a
Zipf-distributed vocabulary) and runs 2,000 mixed queries in process:

```
documents      20,000
tokens         2,799,325
terms          20,000
index size     67.3 MB
build          6.9 s
queries        2,000 (common, mid, rare, AND, phrase, title, negation)
median         0.293 ms
p95            2.354 ms
p99            3.435 ms
mean           0.610 ms
throughput     1,639 queries/s

head terms (most pages match):
  alpha              2.245 ms median
  alpha beta         2.150 ms median
```

(One run on the development machine; run `npm run bench` for your own numbers.)

For the deliberately adversarial case — a corpus where every page contains every
word, so every query has to score all 20,000 pages — the same engine takes
6.6 ms median. The original implementation took 68.6 ms on that corpus, so the
rewrite is roughly 10× faster even when it cannot skip anything.

Through the gateway, a cold query is single-digit milliseconds and a cached query
is about 0.02 ms server-side. The search page is roughly 9 KB of HTML with zero
JavaScript. A JS-heavy search results page is typically 1–3 MB and hundreds of
milliseconds before it is interactive.

That is the honest version of "faster than Chromium": Chromium is a browser, not
a search engine, so we cannot beat it at rendering. We can make the results page
small enough that there is almost nothing to render, and answer the query before
a normal SERP has finished parsing its bundles. Run `npm run bench` for numbers
on your own machine.

## How it works

```
  your PC                         the network                        your browser
┌──────────────┐                                          ┌──────────────────┐
│ openweb      │  signed blocks, hole-punched connections  │ gateway          │
│ start app    │ <---------------------------------------> │ :8080            │
│ drive + key  │              DHT finds the peers          │ new tab + sites  │
└──────────────┘                                          │ address -> drive │
                                                          └──────────────────┘
                                                                   |
                                                            http://127.0.0.1
                                                                   |
                                                             normal browser
```

1. A site is a Hyperdrive: an append-only, signed log of files.
2. Its address is its public key, base32-encoded. Nothing to register.
3. The node announces that key on the Hyperswarm DHT and replicates to anyone
   who asks.
4. The gateway decodes the address back into a key, joins that topic, and
   streams files out as HTTP.
5. The gateway's new-tab page is a view over the local index. It does not have
   a global list of sites, because there is no global list.

No DNS. No ports opened. No certificate authority.

## Layout

| Path | What it is |
| --- | --- |
| `SPEC.md` | The constitution. One page. |
| `app/` | The one site: eight pages, one stylesheet, no JavaScript. |
| `packages/core` | Addresses, drive path handling, signatures. No network code. |
| `packages/node` | The daemon: owns the drive, publishes a folder, announces on the DHT. |
| `packages/index` | Crawler, Porter stemmer, BM25, positional inverted index, query parser. |
| `packages/gateway` | New tab, address bar, sites directory, search, browser chrome. |
| `packages/cli` | `start`, `init`, `serve`, `gateway`, `open`, `crawl`, `search`, `bench`. |
| `examples/` | Two small protocol fixtures used by the end-to-end tests. |
| `extension` | OpenWeb mode (manifest only). |
| `scripts/e2e.ps1` | Publish the unified site, read it through the gateway, follow the address bar. |
| `scripts/search-e2e.ps1` | Two peers, a crawl, `/sites`, browser-bar opt-in, and queries. |

## Verified

```
npm test           # 16 engine tests: stemmer, phrases, negation, BM25, links
npm run e2e        # unified site, browser bar, address redirect, over the DHT
npm run e2e:search # two peers, crawl, query via CLI and gateway, /sites
npm run bench      # build and query a 20,000-page synthetic index
```

The e2e scripts assert on content, so a regression fails loudly.

## Known limits (deliberate, for now)

- One site per state directory (`.openweb`). No multi-site management yet.
- The gateway keeps no page cache on disk: a cold page load refetches from the
  network.
- First load after connecting can take a few seconds while metadata syncs.
- Crawling is manual and depth-limited. Coverage = seeds plus whatever those
  pages link to.
- The index is one local JSON file. It is not compressed or sharded; 20,000
  pages is about 67 MB. Nothing is shared with other peers yet.
- Ranking is lexical only. No synonyms, fuzzy matching, query expansion, or
  learned ranking.
- Static files only. No JavaScript executes.
- Nothing is authenticated: anyone with the address can read the site. That is
  intended.

## Next

1. Publish the index as a drive, so other people can query your search engine
   instead of crawling themselves.
2. The directory (`extension/` and a signed log) — so you don't need to trade
   addresses out of band.
3. OpenWeb mode for the browser.
4. Signed directory identity (`packages/core/identity.ts` is already there for
   this).
