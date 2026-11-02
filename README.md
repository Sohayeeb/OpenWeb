# OpenWeb

A peer-to-peer web. Pages are served from the machine of the person who made them.
No ads. No trackers. No AI-generated content. No hosting bill.

**Status:** working browser-like product. One command publishes a site, starts the
gateway, crawls the site into a local SQLite index, and opens a Chrome-style new
tab. Sites survive their author going offline when somebody pins them; indexes and
directories can be published as drives; the website builder writes one static HTML
file; and the gateway installs as an app window.

Requires **Node 24 or newer** (the index uses the built-in `node:sqlite`).

## Try it

```sh
npm install
npm run build
node packages/cli/dist/index.js start
```

Open `http://127.0.0.1:8080/`. You get a new-tab page with one large search field,
a dotted app launcher, and every site this machine has read. The site itself is at
the printed address. `Ctrl+C` takes it offline.

To get the installed-app experience:

```sh
node packages/cli/dist/index.js install          # write launchers
node packages/cli/dist/index.js install --autostart   # also start at login (Windows)
node packages/cli/dist/index.js browser          # run the stack in a Chrome/Edge app window
```

`install` writes start scripts under `.openweb/bin/`; `browser` launches Chrome or
Edge in `--app=` mode. If neither is installed it prints the URL instead. The
gateway also serves a web manifest and service worker, so Chrome or Edge can
install it from the address bar.

`start` is only the convenient bundle. The pieces run separately:

```sh
# terminal 1 - publish a folder from this PC
node packages/cli/dist/index.js serve app

# terminal 2 - the browser bridge
node packages/cli/dist/index.js gateway

# terminal 3 - teach the local index about an address
node packages/cli/dist/index.js crawl <address> --dir .openweb
```

Stop the first terminal and the site goes offline, unless a pin holds a replica.

## Commands

```text
openweb start [folder]        serve, bridge, crawl, and index in one process
openweb browser [folder]      the same stack, opened as an app window
openweb init                  create a site and print its address
openweb serve <folder>        publish a folder from this machine
openweb gateway               run the local gateway on :8080
openweb open <address>        start a gateway and print the URL
openweb crawl <address...>    crawl sites into the local SQLite index
openweb search <words>        query the local index
openweb new <folder>          generate a static site with the builder
openweb pin <address>         keep a full replica of a site and seed it
openweb pin list              show pinned sites
openweb pin remove <address>  stop seeding a site
openweb index publish         publish the local index as a drive
openweb index fetch <address> download and verify a shared index
openweb index query <a> <q>   query somebody else's index
openweb index import <address> merge a shared index into the local one
openweb index stats           show local index size and counts
openweb directory init        create an identity and a signed directory
openweb directory add <addr>  add a site to the local signed directory
openweb directory remove      remove a site from it
openweb directory verify      verify signatures offline
openweb directory publish     publish the directory as a drive
openweb directory fetch <a>   fetch and verify a remote directory
openweb directory show        show the local directory
openweb install               write launchers (add --autostart on Windows)
openweb bench                 measure the engine on synthetic data
```

Addresses look like `ow1x7f2k...` and are public keys. Nothing to register.

## The gateway

| URL | What it does |
| --- | --- |
| `/` | Chrome-style new tab: search, app launcher, recent sites |
| `/<address>/` | Resolve a key, join its DHT topic, stream the files |
| `/search?q=...` | Query the local index; add `&format=json` for machines |
| `/sites` | Every crawled address, grouped by key, with page counts |
| `/directory` | The local signed directory; `?address=` loads a remote one |
| `/directory?format=json` | The exact signed document, for the extension |
| `/shared?address=...` | Query an index somebody published as a drive |
| `/builder` | The website builder (GET form, POST preview/download) |
| `/open?to=...` | The address bar: key, `openweb://` link, or gateway path |
| `/manifest.webmanifest`, `/sw.js`, `/icon-*.png` | Installable app shell |

Pages opt into a small browser bar with one meta tag:

```html
<meta name="openweb:browser" content="on" />
```

The gateway then adds the current `openweb://` address, an address form, a search
box, and an app launcher. It never adds scripts. The crawler requests pages with
`x-openweb-crawl: 1`, so navigation text never enters the index. Plain sites that
do not opt in are served exactly as written.

Root-relative links are rewritten to `/<address>/...` except for gateway routes
(`/search`, `/sites`, `/directory`, `/shared`, `/builder`, `/open`, and the PWA
assets), so a page can link to both its own files and the browser shell.

## Search

The index is one SQLite file at `.openweb/index.db`. A query reads only the
posting lists it needs; opening the index does not deserialize the corpus.

```sh
node packages/cli/dist/index.js crawl <address> <address> --dir .openweb
node packages/cli/dist/index.js search "slow garden" --dir .openweb
```

`crawl` walks out from the seeds you give it (4 fetches in parallel by default),
follows links, and merges into the existing index. `--fresh` empties the tables
instead of merging. Query syntax:

| Query | Meaning |
| --- | --- |
| `tomato soil` | both words must appear |
| `"slow garden"` | exact phrase, consecutive words |
| `tomato -coffee` | exclude pages containing coffee |
| `title:garden` | word must appear in the title |
| `compost OR beans` | either word may appear |

Words are Porter-stemmed, so `tomatoes` matches `tomato`. When an exact word has no
posting, the engine tries bounded Levenshtein neighbours and a small synonym table
(`yard` -> `garden`, `beans` -> `coffee`, and similar). Ranking is BM25 with a title
boost and a phrase boost. There is no personalization, no click tracking, and no ad
slot.

`/search?format=json` returns the same results machine-readably, including
`tookMs`, `total`, `indexed`, and matched terms. Results are cached in the gateway
by query and by the index file's mtime and size.

### Performance

`npm run bench` builds a 20,000-page synthetic corpus (2.8M words, a
Zipf-distributed 20,000-term vocabulary) and runs 2,000 mixed queries in process:

```text
documents      20,000
tokens         2,799,325
terms          20,000
index size     150.1 MB
build          71.9 s
queries        2,000 (common, mid, rare, AND, phrase, title, negation)
median         5.619 ms
p95            70.960 ms
p99            117.806 ms
mean           17.257 ms
throughput     58 queries/s

head terms (most pages match):
  alpha              55.356 ms median
  alpha beta         71.116 ms median
```

One run on the development machine; run `npm run bench` for your own numbers. The
head-term lines are the deliberately adversarial case where almost every page
matches and BM25 must score them all. Real queries over a small personal index are
usually measured in single-digit milliseconds.

The disk cost is roughly 7.5 KB per synthetic page (about 750 MB at 100,000
pages). RAM does not grow with the corpus: the engine keeps one `Int32Array` of
document lengths, small metadata caches, and one cursor per query term. That is the
point of moving off a monolithic `index.json`. The build is CPU-bound in SQLite;
100,000 pages is a coffee break, not an out-of-memory event.

### Sharing an index

Crawling is work. If somebody has already done it, you can query their index
without crawling:

```sh
# publisher
openweb index publish
# -> address ow1...

# reader
openweb index fetch <address>              # download and SHA-256 verify
openweb index query <address> "tomato"     # query it remotely
openweb index import <address>             # merge its documents into yours
openweb index stats
```

A published index is a Hyperdrive containing a consistent SQLite snapshot
(`VACUUM INTO`) and a manifest with the SHA-256, document count, term count, and
byte size. The reader verifies the hash before opening the snapshot. Querying a
shared index requires only the publisher to be online; importing makes it local.

## Staying online: pinning

A site is online while at least one peer serves it. Pinning is the volunteer
seeder model:

```sh
openweb pin <address>          # download a full replica and seed it
openweb pin list
openweb pin remove <address>   # stop seeding and forget the address
```

The replica lives in `.openweb/pins/store` and the record in `.openweb/pins.json`.
`pin` keeps seeding while the process runs; `openweb start` re-seeds every pinned
site in the background each time the stack starts. A full replica means the site
stays readable after the author's computer goes offline. It is not a backup of the
author's identity: only the public drive is copied.

Pinning is voluntary and visible. There is no incentive token and no hidden
background seeding of sites you did not ask for.

## Signed directories

Addresses are hard to read and easy to swap. A signed directory is a JSON log of
recommendations, signed by an Ed25519 identity:

```sh
openweb directory init --name "Ada's list"
openweb directory add <address> --title "Garden notes" --tag garden --note "worth reading"
openweb directory verify
openweb directory publish        # prints a drive address
openweb directory fetch <address>
```

The identity lives in `.openweb/identity.json`. An identity address is `ow1` plus
the base32-encoded raw public key, so it is self-certifying. Every entry is signed
individually and names the signer; the root document is signed too. `verify` works
offline and reports exactly which signature, address, or ownership check failed.

Directories are logs, not a global registry. Two people can publish two lists. The
gateway renders the local one at `/directory` and any remote one with
`?address=...`; `?format=json` returns the exact signed bytes so clients can verify
instead of trusting the gateway.

## OpenWeb mode (the extension)

`extension/` is a Manifest V3 extension that makes the small web enforceable:

1. Load it unpacked from `chrome://extensions` or `edge://extensions`.
2. `openweb directory init`, add sites, `openweb directory publish`.
3. Open the extension settings and press **load from gateway**.
4. Toggle the mode on.

While it is on, dynamic network rules block every request whose host is not the
local gateway, and the tab listener redirects any `/<ow1...>/` path that is not in
the verified signed directory to `blocked.html`. Signatures are checked locally
with WebCrypto Ed25519; the gateway is never trusted to decide. There is no
allow-once button: allowlisting means editing a signed document.

## Website builder

The builder produces one self-contained static HTML file. No framework, no build
step, no external fonts, no scripts.

```sh
openweb new my-site --title "My page" --tagline "A small thing I made" --theme paper
openweb serve my-site
```

Or use `/builder` on the gateway: fill in the form, preview it in a sandboxed
iframe, and download `index.html`. The server renders the file, so a published page
never needs JavaScript to exist. User text is HTML-escaped, and `javascript:` links
are replaced with `#`.

## How it works

```text
  your PC                         the network                        your browser
  +----------------+      signed blocks, hole-punched connections    +-------------+
  | openweb        | <---------------------------------------------> | gateway     |
  | start app      |              DHT finds the peers                | :8080       |
  | drive + key    |                                                | new tab     |
  +----------------+                                                | address ->  |
                                                                    | drive       |
                                                                    +-------------+
                                                                           |
                                                                    http://127.0.0.1
                                                                           |
                                                                    normal browser
```

1. A site is a Hyperdrive: an append-only, signed log of files.
2. Its address is its public key, base32-encoded. Nothing to register.
3. The node announces that key on the Hyperswarm DHT and replicates to anyone who
   asks.
4. The gateway decodes the address back into a key, joins that topic, and streams
   files out as HTTP.
5. The new tab is a view over the local SQLite index. There is no global list of
   sites, because there is no global list.

No DNS. No ports opened. No certificate authority. No server bills.

## Layout

| Path | What it is |
| --- | --- |
| `SPEC.md` | The constitution. One page. |
| `app/` | The published site: new tab, directory, search, publish, builder, about, and sample pages. No JavaScript. |
| `packages/core` | Addresses, drive paths, Ed25519 identities, signed directories. No network code. |
| `packages/node` | The daemon: publishes a folder, announces on the DHT, pins full replicas, shares indexes and directories. |
| `packages/index` | Crawler, Porter stemmer, BM25, SQLite inverted index, fuzzy/synonym query parsing, shared-index snapshots. |
| `packages/gateway` | New tab, address bar, sites, search, directory, shared indexes, builder, PWA assets, browser chrome. |
| `packages/builder` | The static site renderer used by both the CLI and the gateway. |
| `packages/cli` | The commands above, plus app-window launching and install scripts. |
| `examples/` | Two small protocol fixtures used by the end-to-end tests. |
| `extension/` | OpenWeb mode: offline signature verification, network blocking, settings, blocked page. |
| `scripts/e2e.ps1` | Publish the unified site, read it through the gateway, follow the address bar. |
| `scripts/search-e2e.ps1` | Two peers, a crawl, `/sites`, browser-bar opt-in, fuzzy and synonym queries. |
| `scripts/features-e2e.ps1` | New tab, directory API, builder, PWA, shared index, and pinning, end to end. |

## Verified

```sh
npm test               # 37 tests: stemmer, phrases, BM25, SQLite, signatures, builder
npm run e2e            # unified site, browser bar, address redirect, over the DHT
npm run e2e:search     # two peers, crawl, query via CLI and gateway, /sites
npm run e2e:features   # new tab, directory API, builder, PWA, shared index, pinning
npm run bench          # build and query a 20,000-page synthetic index
```

The e2e scripts assert on content, so a regression fails loudly. They need the DHT
and run on loopback; no external services are involved.

## Known limits (deliberate, for now)

- One published folder per stack. Pinned sites are extra read-only replicas; there
  is no multi-site editor.
- The gateway keeps no page cache on disk: a cold page load refetches from the
  network.
- First load after connecting can take a few seconds while metadata syncs.
- Crawling is manual and depth-limited. Coverage is seeds plus whatever those pages
  link to.
- Pinning keeps a site online only while the pinning process runs. A machine that
  is asleep is not a seed.
- Shared indexes are snapshots, not live views. Fetch or import again to see new
  pages.
- The extension permits localhost generally so a second gateway port still works;
  `strict` still limits OpenWeb paths to signed addresses.
- Ranking is lexical. Synonyms and fuzzy matching are a small hand-written table
  and bounded edit distance, not a model.
- Static files only. No JavaScript executes on published pages.
- Nothing is authenticated for readers: anyone with the address can read the site.
  That is intended.

## Next

1. A live, incremental shared-index format instead of whole snapshots.
2. Multiple published sites from one stack, with per-site pins and stats.
3. A directory merge view across several trusted lists.
4. A small reputation signal that does not become a popularity contest.
