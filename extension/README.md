# extension — OpenWeb mode

The gate. You cannot delete the rest of the internet, but you can stop your browser
from seeing it.

When enabled, every request is blocked unless the tab's origin is:

- the local gateway (`http://127.0.0.1:8080`), or
- an address present in the signed directory log.

There is no "allow once" button. Allowlisting is a deliberate act — you edit your
local copy of the directory, which is signed, and the extension verifies it.

That single constraint is what makes "no AI slop" enforceable instead of a promise:
slop can still exist out there, it just has no way into this window.

Status: manifest stub. Nothing implemented.
