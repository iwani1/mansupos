# Install Mansu POS as a desktop web app

The owner reports that the existing read-only **1.2.2** Contabo pilot now includes the installable, online-only POS web app (PWA). It is not a Windows `.exe` or a separate server: the installed window uses the same HTTPS origin, staff sign-in, backend and permissions as the browser. Installing it does not approve Woo writes, import goods, enable payments or make stock available offline. Branch 1.2.3 is a separate local code update, **not** a reason to redeploy the pilot for private Wholesale prices.

## Install on a computer

1. Open the owner's already verified read-only pilot at **https://pos.mansutrendzgh.com** in current Chrome or Edge on the computer. Check the valid HTTPS certificate and exact hostname; do not install from a bare IP or an untrusted HTTP page.
2. Sign in with your **POS** staff account. If your browser offers an **Install this app** button in the top bar, choose it. In a compact window, open the **navigation menu → Install desktop app**. Alternatively, use the browser's install icon or its menu's **Install app / Install this site as an app** option. Browser wording varies; Help & shortcuts also explains installation.
3. Confirm the browser prompt. Open **Mansu POS** from your desktop, Start menu, app launcher or Dock. The window can be resized: large screens use a compact left rail; smaller windows use the menu drawer (including Help and accessible keyboard focus). All views use the same POS account and server.

If no install option appears, use Chrome or Edge, confirm you are on the canonical HTTPS host, refresh once, and have an administrator check the endpoints below. Do not bypass a certificate warning. Other browsers may offer a shortcut or their own equivalent; a native executable is not supplied.

**This is not offline POS.** Only a public **Connection required** notice is stored for offline reopening. Product, session, sales, payment and `/api` responses are network-only and not saved by the service worker. If a running window reports the device offline, stop: do not use an old price/stock figure, accept payment or release goods. On reconnection the app rechecks the catalogue and keeps its warning until fresh reads succeed; use **Retry refresh** if they fail. Check current stock before continuing. The existing read-only pilot never permits checkout even when connected.

## Contabo administrator: historical read-only pilot update procedure

**No update is requested now.** Version 1.2.2 is already reported as installed. The procedure below is for a separately approved future read-only pilot upgrade; do not use this branch to enable sales or import prices. Follow the backup, code-update and rollback cautions in [CONTABO-LIVE-PILOT.md §7](CONTABO-LIVE-PILOT.md#7-updating-an-existing-pilot-without-replacing-its-ledger). Before updating, confirm a fresh, integrity-checked pilot-ledger backup and an off-host copy; preserve `/etc/mansu-pos-live-pilot/pos.env` and `/var/lib/mansu-pos-live-pilot`. Pull **only** the reviewed `arena/f5331f1d-mansupos` branch into `/opt/mansu-pos-live-pilot`, run `npm ci --include=dev`, `npm run build:live`, confirm `dist/demo` is absent and the manifest, service worker, notice and icon files exist, then `npm prune --omit=dev` and restart **only** `mansu-pos-live-pilot.service`. The existing pilot unit enforces loopback `127.0.0.1:3187`, `POS_LIVE_READ_ONLY=true` and all write locks. Do **not** edit the unit or the env file to enable selling, touch the other VPS app, alter the Woo store or use the proposed live-trading unit. Do not claim this branch is deployed until those steps actually succeed.

From the VPS, after the restart, verify `/api/health` still says `"mode":"live"` and `"liveReadOnly":true`, then check that the existing Nginx HTTPS host forwards **all** the new paths to the pilot (without adding a separate server or changing the other host):

```bash
curl --fail --silent --show-error https://pos.mansutrendzgh.com/api/health
curl --fail --silent --show-error --head https://pos.mansutrendzgh.com/manifest.webmanifest
curl --fail --silent --show-error --head https://pos.mansutrendzgh.com/sw.js
curl --fail --silent --show-error --head https://pos.mansutrendzgh.com/offline.html
curl --fail --silent --show-error --head https://pos.mansutrendzgh.com/icons/mansu-192.png
curl --fail --silent --show-error --head https://pos.mansutrendzgh.com/icons/mansu-512.png
```

Expected: 200; manifest JSON MIME type, worker JavaScript MIME type with `Cache-Control: no-store`, offline HTML, PNG icons; `/api/*` remains `Cache-Control: no-store`. An HTML response for `/sw.js` or the manifest, a redirected hostname, a certificate error, or missing icons blocks installation. Inspect only the pilot's host configuration; never loosen TLS or serve the app on an unrelated origin. In an external Chrome/Edge session, confirm install/launch, resize to a narrow window, open Help through the drawer, sign in and refresh the **read-only** catalogue, and confirm the other website still works. For a disconnected test, open the installed window while offline and verify the public notice; reconnect and verify a fresh live view before use. No real sale or Woo write is part of this check.

The manifest uses same-origin scope `/`; `/sw.js` caches **only** `/offline.html`. HTML and the manifest are revalidated on update; versioned Vite assets remain immutable. A deployed new version may require closing and reopening the installed window to load its latest JavaScript. If installation fails, verify the deployment and browser support rather than clearing the pilot ledger. The separate [mix-by-style shared-stock plan](SHARED-WOO-STOCK.md) still has no per-style assignments and authorizes no import or checkout.
