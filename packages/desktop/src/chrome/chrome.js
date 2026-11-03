/* The chrome UI. Everything here is presentation and commands; all navigation,
   service work, and the launcher sheet happen in the main process. */

const api = window.openweb

const els = {
  tabs: document.getElementById('tabs'),
  newTab: document.getElementById('newTab'),
  home: document.getElementById('home'),
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  addressForm: document.getElementById('addressForm'),
  address: document.getElementById('address'),
  apps: document.getElementById('apps'),
  stage: document.getElementById('stage'),
  status: document.getElementById('status'),
}

const DEFAULT_STATE = {
  tabs: [],
  activeId: null,
  address: 'openweb://home',
  title: 'New tab',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  status: 'starting your node…',
  online: false,
}

let state = DEFAULT_STATE
let dirty = false

function init() {
  bind()

  api
    .getState()
    .then((initial) => {
      if (initial) apply(initial)
    })
    .catch(() => undefined)

  api.onState(apply)
  api.onFocusAddress(() => {
    dirty = false
    els.address.focus()
    els.address.select()
  })
  api.ready()
}

function bind() {
  els.back.addEventListener('click', () => api.action('back'))
  els.forward.addEventListener('click', () => api.action('forward'))
  els.reload.addEventListener('click', () => {
    if (state.loading) api.action('stop')
    else api.action('reload')
  })

  els.home.addEventListener('click', () => go('openweb://home'))
  els.newTab.addEventListener('click', () => api.action('new-tab'))
  els.apps.addEventListener('click', () => api.openLauncher())

  els.addressForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = els.address.value
    dirty = false
    els.address.blur()
    go(value)
  })

  els.address.addEventListener('focus', () => {
    dirty = false
    els.address.select()
  })
  els.address.addEventListener('input', () => {
    dirty = true
  })
  els.address.addEventListener('blur', () => {
    dirty = false
    els.address.value = state.address
  })
  els.address.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      dirty = false
      els.address.value = state.address
      els.address.blur()
    }
  })

  els.tabs.addEventListener('click', (event) => {
    const element = event.target.closest('.tab')
    if (!element) return
    const id = Number(element.dataset.id)
    if (event.target.closest('.close')) api.action('close-tab', id)
    else api.action('select-tab', id)
  })

  els.tabs.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return
    const element = event.target.closest('.tab')
    if (element) api.action('close-tab', Number(element.dataset.id))
  })
}

function go(input) {
  api.navigate(input)
}

function apply(next) {
  if (!next) return
  state = next

  els.stage.classList.toggle('ready', next.tabs.length > 0)
  els.status.textContent = next.status || (next.online ? 'ready' : 'starting your node…')

  els.back.disabled = !next.canGoBack
  els.forward.disabled = !next.canGoForward
  els.reload.title = next.loading ? 'Stop loading' : 'Reload (Ctrl+R)'
  els.reload.classList.toggle('is-loading', next.loading)

  renderTabs(next.tabs, next.activeId)

  if (!dirty && document.activeElement !== els.address) {
    els.address.value = next.address
  }
}

function renderTabs(tabs, activeId) {
  const fragment = document.createDocumentFragment()

  for (const tab of tabs) {
    const element = document.createElement('div')
    element.className = 'tab'
    if (tab.id === activeId) element.classList.add('active')
    if (tab.loading) element.classList.add('loading')
    element.dataset.id = String(tab.id)
    element.title = tab.title || 'New tab'

    const dot = document.createElement('span')
    dot.className = 'dot'

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = tabLabel(tab)

    const close = document.createElement('button')
    close.className = 'close'
    close.type = 'button'
    close.title = 'Close tab'
    close.setAttribute('aria-label', 'Close tab')
    close.textContent = '×'

    element.append(dot, label, close)
    fragment.append(element)
  }

  els.tabs.replaceChildren(fragment)
}

function tabLabel(tab) {
  let title = (tab.title || '').replace(/\s+—\s+OpenWeb$/, '').trim()
  if (!title || title === 'New tab' || title === 'OpenWeb') {
    if (tab.display.startsWith('openweb://ow1')) {
      title = shortAddress(tab.display.slice('openweb://'.length))
    } else if (tab.display === 'openweb://home') {
      title = 'New tab'
    }
  }
  return title || 'New tab'
}

function shortAddress(value) {
  const address = value.split('/')[0].split('?')[0]
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-4)}` : address
}

init()
