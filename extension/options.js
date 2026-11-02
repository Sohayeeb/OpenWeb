/**
 * Settings for OpenWeb Mode. All real work happens in the service worker; this
 * page only reads state, edits it, and renders the verification verdict.
 */

const $ = (id) => document.getElementById(id)

let state = null

async function send(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw new Error(response?.error ?? 'the background worker did not answer')
  return response
}

function setStatus(element, message, kind = '') {
  element.textContent = message
  element.className = `status ${kind}`.trim()
}

async function render(next) {
  if (next) state = next

  $('enabled').checked = Boolean(state.enabled)
  $('strict').checked = Boolean(state.strict)
  $('gateway').value = state.gateway ?? 'http://127.0.0.1:8080'
  $('badge').textContent = state.enabled ? 'on' : 'off'
  $('badge').style.color = state.enabled ? 'var(--accent)' : 'var(--dim)'

  $('directory').value = state.signed ? JSON.stringify(state.signed, null, 2) : ''

  const verification = state.verification
  if (!verification) {
    setStatus($('verify-status'), 'No directory loaded.', '')
    $('verification').innerHTML = ''
    return
  }

  if (verification.valid) {
    setStatus(
      $('verify-status'),
      `✓ ${verification.sites.length} site(s) verified · signed by ${verification.author.slice(0, 12)}… · ${new Date(verification.verifiedAt).toLocaleString()}`,
      'good',
    )
  } else {
    setStatus($('verify-status'), `✗ verification failed: ${verification.errors.join('; ')}`, 'bad')
  }

  const rows = verification.sites
    .map(
      (site) => `<li>
        <span>${escapeHtml(site.title)}${site.tags?.length ? ` <span class="badge">${site.tags.map(escapeHtml).join(' · ')}</span>` : ''}</span>
        <code>${escapeHtml(site.address)}</code>
      </li>`,
    )
    .join('')

  $('verification').innerHTML = `
    <p class="hint" style="margin-top:1rem">
      ${escapeHtml(verification.name ?? '(unnamed directory)')} ·
      author <code>${escapeHtml(verification.author)}</code> ·
      ${verification.entryCount} entry/entries
    </p>
    ${rows ? `<ul class="sites">${rows}</ul>` : '<p class="hint">No valid sites in this directory — every OpenWeb address will be blocked.</p>'}
    ${verification.errors.length ? `<ul class="errors">${verification.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
  `
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function refresh() {
  try {
    const response = await send({ type: 'status' })
    await render(response.state)
    const gateway = new URL(state.gateway)
    $('gate-status').textContent = `Local gateway: ${gateway.origin} · the mode ${state.enabled ? 'is on' : 'is off'}`
    $('gate-status').className = 'status'
  } catch (error) {
    setStatus($('gate-status'), error.message, 'bad')
  }
}

$('enabled').addEventListener('change', async (event) => {
  try {
    const response = await send({ type: 'set-enabled', enabled: event.target.checked })
    await render(response.state)
  } catch (error) {
    setStatus($('gate-status'), error.message, 'bad')
  }
})

$('strict').addEventListener('change', async (event) => {
  try {
    const response = await send({ type: 'set-strict', strict: event.target.checked })
    await render(response.state)
  } catch (error) {
    setStatus($('verify-status'), error.message, 'bad')
  }
})

$('save-gateway').addEventListener('click', async () => {
  try {
    const response = await send({ type: 'set-gateway', gateway: $('gateway').value })
    await render(response.state)
    setStatus($('gate-status'), `Gateway saved: ${response.state.gateway}`, 'good')
  } catch (error) {
    setStatus($('gate-status'), error.message, 'bad')
  }
})

$('load-gateway').addEventListener('click', async () => {
  setStatus($('verify-status'), 'Fetching the signed directory from the gateway…', '')
  try {
    const response = await send({ type: 'load-from-gateway' })
    await render(response.state)
    if (response.verification?.valid) {
      setStatus($('verify-status'), `✓ loaded and verified ${response.verification.sites.length} site(s)`, 'good')
    } else {
      setStatus($('verify-status'), response.verification?.errors?.join('; ') ?? 'the directory did not verify', 'bad')
    }
  } catch (error) {
    setStatus($('verify-status'), error.message, 'bad')
  }
})

$('verify').addEventListener('click', async () => {
  try {
    const parsed = JSON.parse($('directory').value)
    const response = await send({ type: 'save-directory', signed: parsed })
    await render(response.state)
    if (response.verification?.valid) {
      setStatus($('verify-status'), `✓ verified ${response.verification.sites.length} site(s)`, 'good')
    } else {
      setStatus($('verify-status'), response.verification?.errors?.join('; ') ?? 'verification failed', 'bad')
    }
  } catch (error) {
    setStatus($('verify-status'), error.message, 'bad')
  }
})

$('clear').addEventListener('click', async () => {
  try {
    const response = await send({ type: 'clear-directory' })
    await render(response.state)
  } catch (error) {
    setStatus($('verify-status'), error.message, 'bad')
  }
})

$('pick-file').addEventListener('click', () => $('file').click())

$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    $('directory').value = await file.text()
    setStatus($('verify-status'), `Loaded ${file.name}; press "verify & save".`, '')
  } catch (error) {
    setStatus($('verify-status'), error.message, 'bad')
  }
})

void refresh()
