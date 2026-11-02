/**
 * The blocked page. Reads the reason and the attempted URL from the query
 * string, then points at the settings page where the allowlist lives.
 */

const params = new URLSearchParams(location.search)
const reason = params.get('reason')
const target = params.get('url')

const REASONS = {
  'not-in-directory':
    'That OpenWeb address is not in your signed directory. Add it there, then load the directory again in settings.',
  'outside-gateway':
    'That host is outside the local gateway. OpenWeb mode only talks to the gateway and the sites it serves.',
  blocked: 'The request was blocked by OpenWeb mode.',
}

document.getElementById('reason').textContent = REASONS[reason] ?? REASONS.blocked
document.getElementById('target').textContent = target ?? ''

const gateway = document.getElementById('gateway')
if (target) {
  try {
    const parsed = new URL(target)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      gateway.textContent = `open ${parsed.origin} instead`
    }
  } catch {
    // Leave the default link.
  }
}
