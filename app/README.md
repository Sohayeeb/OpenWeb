# app — the one site

This folder is the OpenWeb site: a Chrome-style new tab, a hand-kept directory, a
publishing guide, a search page, the website builder, the rules, and a few sample
pages. It is plain HTML and one stylesheet. No JavaScript, no build step, no fonts
loaded from anyone else's server.

```
node packages/cli/dist/index.js start app
```

That publishes the folder, starts the gateway on `:8080`, crawls this site into the
local SQLite index, and prints the site address. Open the gateway to use it:

```
http://127.0.0.1:8080/
```

Every page carries `<meta name="openweb:browser" content="on" />`. When a page with
that tag is served through the gateway, the gateway injects a small browser bar at
the top: the current `openweb://` address, a way to open another address, a search
box, an app launcher, and links to the new-tab and sites pages. The site itself
stays ordinary HTML. Without the gateway, it is still a static site.

## The pages

| File | What it is |
| --- | --- |
| `index.html` | Chrome-style new tab: one search field, dotted app launcher. |
| `directory.html` | A hand-kept list of the pages here, and the signed alternative. |
| `builder.html` | How to use the builder from the gateway or the terminal. |
| `hello.html` | A note about a page that lives on somebody's laptop. |
| `garden.html` | Tomatoes, compost, patience. |
| `coffee.html` | Coffee without another appliance. |
| `publish.html` | Folder to address, and how pinning keeps it online. |
| `search.html` | Query syntax, fuzzy matching, and the SQLite index. |
| `about.html` | The one rule, the limits, and why bother. |
| `style.css` | The whole design. Edit this, not a framework. |

The gateway routes the site links to `/search`, `/directory`, `/builder`, and the
other shell pages, and rewrites ordinary root-relative links to this address. The
crawler asks for pages without the browser bar, so none of that shell text enters
the search index.

The two sites in `examples/` are protocol fixtures used by the end-to-end tests.
They are deliberately smaller and do not opt into the browser bar.
