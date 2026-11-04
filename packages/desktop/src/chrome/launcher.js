/* The app launcher sheet. It is its own view stacked above the page, so it can
   be dismissed by clicking the dim backdrop, pressing Escape, or opening a site. */

const api = window.openweb

const els = {
  quick: document.getElementById('quick'),
  appsList: document.getElementById('appsList'),
  refreshApps: document.getElementById('refreshApps'),
  backdrop: document.getElementById('backdrop'),
}

const QUICK = [
  { label: 'Home', glyph: '⌂', target: 'openweb://home' },
  { label: 'Publish', glyph: '↑', target: 'openweb://publish' },
  { label: 'Sites', glyph: '▤', target: 'openweb://sites' },
  { label: 'Directory', glyph: '✓', target: 'openweb://directory' },
  { label: 'Search index', glyph: '⌕', target: 'openweb://shared' },
  { label: 'Builder', glyph: '✎', target: 'openweb://builder' },
]

const SOURCE_LABEL = {
  published: 'Published here',
  pinned: 'Pinned',
  directory: 'Directory',
  site: 'Known sites',
}

let apps = []
let request = 0

function init() {
  renderQuick()

  els.refreshApps.addEventListener('click', () => load())
  els.backdrop.addEventListener('click', close)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })

  api.onLauncherOpen(() => load())
  load()
}

function load() {
  const current = ++request
  els.appsList.replaceChildren(message('Looking through this machine…'))

  api
    .getLauncher()
    .then((found) => {
      if (current !== request) return
      apps = Array.isArray(found) ? found : []
      render()
    })
    .catch(() => {
      if (current !== request) return
      apps = []
      render()
    })
}

function renderQuick() {
  const fragment = document.createDocumentFragment()
  for (const item of QUICK) {
    const button = document.createElement('button')
    button.type = 'button'
    button.title = item.target

    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    glyph.textContent = item.glyph

    const label = document.createElement('span')
    label.textContent = item.label

    button.append(glyph, label)
    button.addEventListener('click', () => go(item.target))
    fragment.append(button)
  }
  els.quick.replaceChildren(fragment)
}

function render() {
  if (apps.length === 0) {
    els.appsList.replaceChildren(
      message('Nothing indexed yet. Publish a folder or crawl a site and it will appear here.'),
    )
    return
  }

  const fragment = document.createDocumentFragment()
  let lastSource = ''

  for (const site of apps) {
    if (site.source !== lastSource) {
      lastSource = site.source
      const section = document.createElement('div')
      section.className = 'section'
      section.textContent = SOURCE_LABEL[site.source] || 'Sites'
      fragment.append(section)
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'app'
    button.title = `openweb://${site.address}/`

    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    glyph.textContent = (site.title || site.address).trim().charAt(0).toUpperCase() || '•'

    const meta = document.createElement('span')
    meta.className = 'meta'

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = site.title || shortAddress(site.address)

    const address = document.createElement('span')
    address.className = 'addr'
    address.textContent = `openweb://${shortAddress(site.address)}`

    meta.append(name, address)
    button.append(glyph, meta)
    button.addEventListener('click', () => go(`openweb://${site.address}/`))
    fragment.append(button)
  }

  els.appsList.replaceChildren(fragment)
}

function go(target) {
  api.navigate(target)
  close()
}

function close() {
  api.closeLauncher()
}

function message(text) {
  const element = document.createElement('p')
  element.className = 'empty'
  element.textContent = text
  return element
}

function shortAddress(value) {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
}

init()
