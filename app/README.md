# app — the one site

This folder is the OpenWeb site: a home page, a hand-kept directory, three
ordinary pages, a publishing guide, and a search page. It is plain HTML and one
stylesheet. No JavaScript, no build step, no fonts loaded from anyone else's
server.

```
node packages/cli/dist/index.js serve app
```

That prints an address. Open it through the gateway:

```
node packages/cli/dist/index.js open <address>
```

Every page carries `<meta name="openweb:browser" content="on" />`. When a page
with that tag is served through the gateway, the gateway injects a small browser
bar at the top: the current `openweb://` address, a way to open another address,
a search box, and links to the new-tab page and the list of crawled sites. The
site itself stays ordinary HTML. Without the gateway, it is still a static site.

## The pages

| File | What it is |
| --- | --- |
| `index.html` | The front door: what this is, search, and the way in. |
| `directory.html` | A hand-kept list of the pages here. |
| `hello.html` | A note about a page that lives on somebody's laptop. |
| `garden.html` | Tomatoes, compost, patience. |
| `coffee.html` | Coffee without another appliance. |
| `publish.html` | Folder to address in one command. |
| `search.html` | Query syntax and the local index. |
| `about.html` | The one rule, the limits, and why bother. |
| `style.css` | The whole design. Edit this, not a framework. |

The two sites in `examples/` are protocol fixtures used by the end-to-end tests.
They are deliberately smaller and do not opt into the browser bar.
