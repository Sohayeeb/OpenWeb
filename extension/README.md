# extension — OpenWeb mode

The gate. You cannot delete the rest of the internet, but you can stop your browser
from seeing it.

When enabled, the browser can reach:

- the local gateway (`http://127.0.0.1:8080` by default), and
- OpenWeb addresses listed in a signed directory you loaded yourself.

There is no "allow once" button. Allowlisting is a deliberate act — you add the
site to a signed document, load it in settings, and the extension verifies every
signature locally with WebCrypto. It never trusts the gateway to decide.

That single constraint is what makes "no AI slop" enforceable instead of a promise:
slop can still exist out there, it just has no way into this window.

## Load it

1. Open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
2. Choose **Load unpacked** and pick this `extension/` folder.
3. Run `openweb directory init`, add a site, then `openweb directory publish`.
4. Open the extension's **Settings**, press **load from gateway**, and check the
   verification status.
5. Click the toolbar icon to turn the mode on.

The dynamic network rules block every request whose host is not the gateway, and
the tab listener redirects any `/<ow1…>/` path that is not in the verified
directory to `blocked.html`.

## Files

- `background.js` — Ed25519 verification, DNR rules, navigation gate, settings API.
- `options.html` / `options.js` — load a directory from the gateway or a file,
  inspect every verified site, toggle the mode.
- `blocked.html` / `blocked.js` — the page you get when the gate holds.

## Limits

- The directory is a log, not a global registry. Two people can publish two
  different lists; the extension only knows the one you loaded.
- Address enforcement is path-based because sites are served through the
  gateway. A future direct-address transport can reuse the same allowlist.
- The extension permits localhost in general so a second gateway port still
  works. `strict` still limits OpenWeb paths to signed addresses.
