# 1G-IOS Kiosk Application — Architecture & Code Summary

**Version:** 3.5.4
**Date:** March 2026
**Purpose:** Comprehensive technical reference for human developers and AI agents performing code review, maintenance, or feature development.

---

## 1. Problem Statement

Each ATD runs a local web-based Instructor Operator Station (IOS) accessible at an HTTP address on the local network (e.g., `http://10.38.1.1:3100/`). Chromebooks from our mixed fleet are deployed as dedicated kiosk terminals that connect to these IOS servers.

The core technical challenge: **Chromebooks in URL-based kiosk mode load an HTTPS URL, but the IOS servers are HTTP on the local network.** Browsers enforce mixed-content restrictions that prevent an HTTPS page from making HTTP subresource requests (fetch, XHR, iframe, etc.). This application solves that constraint through a two-component architecture: an HTTPS-hosted PWA and a Chrome MV3 extension that acts as an HTTP proxy.

---

## 2. System Architecture

### 2.1 Components

The system consists of two deployable artifacts:

**PWA (Progressive Web App)** — `ios-kiosk-pwa/`
Currently hosted on GitHub Pages at `https://dkpine.github.io/ios-kiosk-pwa/` **for early internal development and testing only**. Production deployment will be at `https://ios.flyone-g.com` (or similar one-G subdomain). The GitHub Pages URL is a temporary convenience — it provides free HTTPS hosting with zero infrastructure, but is not intended for field use. This is the URL configured as the Chromebook's kiosk start page. It provides the configuration UI, device lookup, connection management, failure handling, and retry logic.

**Chrome Extension (MV3)** — `ios-kiosk-extension/`
A Manifest V3 Chrome extension deployed via the Chrome Web Store (or self-hosted during development). It provides three critical capabilities that the HTTPS PWA page cannot perform on its own: (1) HTTP fetch proxying from its service worker, (2) IOS page health monitoring via an injected watchdog script, and (3) navigation error recovery via the `webNavigation.onErrorOccurred` API.

### 2.2 File Inventory

```
ios-kiosk-pwa/
├── index.html              — Single-page HTML shell (all UI markup)
├── application.js          — All application logic (~1540 lines, single IIFE)
├── application.css         — All styling, theming, responsive rules
├── devices.enc             — AES-256-GCM encrypted device database (temporary)
├── devices.json            — Plaintext source for devices.enc (not deployed)
├── encrypt-devices.js      — Node.js script to generate devices.enc
├── PORTAL-API-SPEC.md      — API specification for Portal developer
├── ARCHITECTURE.md          — This document
├── icons/                  — App icons (16, 48, 128 PNG)
├── logos/                  — one-G branding assets (light/dark variants)
└── .gitignore              — Excludes encrypt-devices.js

ios-kiosk-extension/
├── manifest.json           — MV3 manifest (permissions, content scripts, externally_connectable)
├── background.js           — Service worker (fetch proxy, watchdog injection, error recovery)
├── content.js              — Content script bridge (postMessage ↔ chrome.runtime relay)
├── watchdog.js             — Health monitor injected into IOS pages
└── icons/                  — Extension icons
```

---

## 3. PWA Application Logic (`application.js`)

The entire application is wrapped in a single IIFE with `'use strict'`. It uses ES5 syntax throughout for maximum Chromebook compatibility (no arrow functions, no `let`/`const`, no template literals, no `async`/`await`).

### 3.1 Constants and Configuration

| Constant | Value | Purpose |
|----------|-------|---------|
| `STORAGE_KEY` | `'ios_addr'` | localStorage key for the configured IOS URL |
| `THEME_KEY` | `'ios_theme'` | localStorage key for dark/light preference |
| `PROBE_TIMEOUT_MS` | `8000` | Timeout for extension-proxied HTTP probes |
| `SUCCESS_BANNER_MS` | `2000` | Delay before navigating after successful probe |
| `RETRY_COOLDOWN_S` | `10` | Seconds between automatic retry attempts |
| `EXTENSION_ID` | `'ffcoooniadfdngdceeiopbkdljcgnoha'` | Self-hosted extension ID (deterministic from manifest `key`) |
| `DEVICES_ENC_URL` | `'./devices.enc'` | Encrypted device database file |
| `DEVICES_KEY_HEX` | (256-bit hex) | AES-256-GCM decryption key (client-side; temporary) |
| `RECOVERY_KEY` | `'kiosk_recovery'` | localStorage key for navigation breadcrumb |
| `NAV_TIMEOUT_MS` | `8000` | Dead man's switch timeout for blind navigation |
| `PORTAL_URL` | `'https://portal.flyone-g.com'` | one-G Portal API base URL |
| `PORTAL_TOKEN_STORAGE` | `'kiosk_portal_token'` | localStorage key for cached Portal JWT |
| `PORTAL_TOKEN_SERIAL_KEY` | `'kiosk_portal_serial'` | localStorage key for serial associated with cached JWT |

### 3.2 Extension Communication Layer

The PWA communicates with the extension through a dual-strategy system with automatic fallback:

**Strategy 1: Content Script Bridge** — The extension injects `content.js` into the PWA page. The page sends `window.postMessage({iosKiosk: true, ...})`, the content script relays via `chrome.runtime.sendMessage()`, and replies come back as `window.postMessage({iosKioskReply: true, ...})`. Messages are correlated by `requestId` with a 2-second timeout.

**Strategy 2: `externally_connectable`** — The page calls `chrome.runtime.sendMessage(EXTENSION_ID, ...)` directly. This requires the extension manifest to declare the page's origin in `externally_connectable.matches` and for `chrome.runtime` to be exposed (not guaranteed in all kiosk configurations).

**Detection flow (`checkExtension`):** On boot, the app polls up to 14 attempts (~25 seconds) trying both strategies in parallel. Each attempt sends a `ping` message via both channels. The first successful response wins, and the app records which channel (`useDirectChannel` flag) to use for all subsequent communication.

**`sendToExtension(message, callback)`** — Unified send function. Routes through the direct channel or content script bridge based on which was detected. All extension messages use this function.

**`proxyFetch(url, timeout, callback)`** — Sends a `{type: 'fetch', url, timeout}` message to the extension. The extension's service worker performs the actual HTTP fetch (exempt from mixed-content restrictions) and returns `{ok, status, type}`.

### 3.3 Boot Sequence

`init()` is called on `DOMContentLoaded` or immediately if the DOM is already ready. It performs:

1. **UI setup** — version display, theme initialization, wake lock, hotkey registration, button event listeners, device database loading.

2. **Recovery check** — Two recovery sources are checked:
   - `localStorage` breadcrumb (set before blind navigation without extension)
   - `?recovery=` query parameter (set by extension service worker on navigation error)
   The recovery URL is cleaned from the query string via `history.replaceState()`.

3. **Extension detection race** — Three concurrent mechanisms:
   - `onExtensionReady` callback (fires when content script sends `extensionReady` postMessage)
   - `checkExtension()` polling (tries both bridge and direct channel)
   - Fallback timer (`EXTENSION_WAIT_MS = 2500ms`)

   The first to resolve calls `doBoot(withExtension)`. The `bootDecided` flag prevents double-boot.

4. **`bootWithExtension()`** — Prefers the stored configured URL over recovery URL. If no stored URL exists and a recovery URL is present, extracts the root origin (strips sub-page paths like `/session/resetpin`) before saving. Attempts extension storage migration if no URL is found anywhere. Shows config overlay as last resort.

5. **`bootWithoutExtension()`** — Same URL resolution logic. Additionally registers a late-arrival callback: if the extension loads after boot, `bootWithExtension()` is re-triggered, giving the extension a chance to take over even if it was slow to initialize.

### 3.4 Device Lookup System

The lookup system resolves a tail number (device identifier) to a local IOS URL through a tiered fallback chain:

```
User input → normalize → Portal API → local encrypted DB → honeypot URL
```

**`normalizeTailNumber(input)`** — Accepts flexible input formats. Strips `N` or `SIM-` prefix, validates against `^\d{2,5}[A-Z]{0,2}$`, returns normalized form with `N` prefix (e.g., `"SIM-321GX"` → `"N321GX"`). Returns `null` for invalid formats.

**`tailToSerial(normalized)`** — Strips the `N` prefix for Portal communication (e.g., `"N321GX"` → `"321GX"`). The Portal uses the raw serial, not the N-prefixed form.

**`handleLookup()`** — Entry point from the Look Up button. Validates input, shows "Looking up..." state, then calls `tryPortalThenLocal()`:

1. **Portal auth** (`portalAuth`) — POSTs `{id: serial}` to `/apiv2/auth`. Caches JWT token in localStorage. 5-second timeout.
2. **Portal lookup** (`portalLookup`) — POSTs `{token, serial}` to `/apiv2/kiosk/lookup`. Expects `{url}` response. Handles 401 (token expired) by clearing cache. 5-second timeout.
3. **Local DB fallback** (`localDbLookup`) — Searches the decrypted device database by raw input, normalized form, N-prefixed form, and zero-padded variations.
4. **Honeypot fallback** (`generateHoneypotUrl`) — For unknown serials, generates a deterministic fake `10.x.x.x:3100` address from a hash of the tail number. The kiosk silently enters the failure/retry loop, making valid and invalid entries indistinguishable. No error message is shown and no console log is emitted, preventing serial enumeration.

**`localDbLookup(normalized, raw)`** — Multi-strategy lookup against the decrypted device database: exact match on raw input, exact match on normalized form, N-prefixed form if input started with digits, and zero-padded variations (e.g., `21GF` also checks `021GF`, `0021GF`).

### 3.5 Encrypted Device Database

**Temporary mechanism** — Will be removed once Portal integration is validated in production.

`devices.enc` is an AES-256-GCM encrypted JSON file. Binary format: `[12-byte IV][16-byte auth tag][ciphertext]`. The decryption key is hardcoded in `application.js` (acknowledged security limitation — the key is in client-side source).

`loadDeviceDb()` fetches `devices.enc`, reconstructs the IV/tag/ciphertext, imports the key via Web Crypto API, decrypts, and parses the resulting JSON into the `deviceDb` object (a simple `{tailNumber: url}` map).

`encrypt-devices.js` is a Node.js script that reads `devices.json` and produces `devices.enc`. It is git-ignored.

### 3.6 Portal API Integration

The kiosk authenticates with the one-G Portal using the same `/apiv2/auth` endpoint the IOS itself uses. The `PORTAL-API-SPEC.md` document contains the full specification for the Portal developer.

**Authentication** — `portalAuth(tailNumber, callback)` strips the N prefix, POSTs `{id: serial}` to `PORTAL_URL + '/apiv2/auth'`, and caches the returned JWT token in both the `portalToken` variable and localStorage under `PORTAL_TOKEN_STORAGE`. The serial is stored alongside the token under `PORTAL_TOKEN_SERIAL_KEY`; if a subsequent auth call uses a different serial (kiosk reassigned to a different ATD), the stale token is cleared and a fresh auth is performed.

**Lookup** — `portalLookup(tailNumber, callback)` POSTs `{token, serial}` to `PORTAL_URL + '/apiv2/kiosk/lookup'` and returns the `url` field from the response (or `null`). If the token is expired (401), the cache is cleared.

**Status indicator** — `updatePortalStatus(connected)` updates a footer indicator: green "Portal OK", red "Portal offline", or amber "Authenticating...". Visible only in dev mode.

### 3.7 Navigation & Connection Flow

**`navigateToUrl(url)`** — Central navigation function. Two paths:

**With extension:** Sends a proxied HTTP fetch to probe the IOS server. On success → `handleConnectionSuccess()` (green banner, 2-second delay, then `window.location.href = url`). On failure → `handleConnectionFailure()` (red banner, countdown timer, troubleshooting link).

**Without extension:** Cannot probe HTTP from HTTPS (mixed content). Sets a localStorage recovery breadcrumb, then blindly navigates via `window.location.href = url`. Two safety nets: (1) dead man's switch — if the page hasn't unloaded after `NAV_TIMEOUT_MS`, calls `window.stop()` and enters failure flow; (2) breadcrumb — if Chrome instantly shows an error page (destroying the JS context), the breadcrumb persists for next load.

**Amber banner click-to-abort** — During the "Connecting..." state, clicking the amber banner cancels all timers and shows the config overlay. The green success banner is not clickable. The red failure banner opens the troubleshooting panel.

**Recovery URL root extraction** — When a recovery URL arrives (from extension `?recovery=` param or breadcrumb), it may be a sub-page (e.g., `/session/resetpin`). The boot functions extract just `origin + '/'` via `new URL(recoveryUrl).origin` before saving, preventing sub-page paths from overwriting the stored root IOS address.

### 3.8 Retry System

On connection failure, a 10-second countdown timer starts before the next automatic retry:

- **Cooldown:** Fixed 10-second interval (`RETRY_COOLDOWN_S`), repeating indefinitely until the IOS responds.
- **Visual:** SVG ring animation that depletes over 10 seconds, with seconds displayed in the center.
- **Interactions:** Click the ring to retry immediately. Click anywhere else to open troubleshooting. Click the troubleshooting link below the countdown for the same.
- **`cancelRetry()`** — Stops all timers (countdown interval, retry timeout, success timer, nav timeout timer).

### 3.9 Troubleshooting Panel

A full-screen overlay with structured recovery steps for when the IOS is unreachable. Includes:
- Quick self-check ("Is the ATD powered on?")
- 6-step power cycle procedure with emphasis on waiting for the wireless router
- Retry Connection and Dismiss buttons
- Link to open the configuration overlay

### 3.10 Configuration Overlay

The main UI for device setup. Contains:
- **Tail number lookup** — Text input + Look Up button (primary flow)
- **Manual entry** — Collapsible section with URL input + Save & Connect / Clear / Close buttons
- **Current URL display** — Shows the stored IOS address
- **Hotkey hint** — `Ctrl+Shift+O` to open from any screen
- **Dev mode footer** — Theme toggle, extension status, Portal status, diag button, version number

**Dev mode easter egg** — 7 taps on the version number within a fixed time window (2 seconds to reveal, 5 seconds to hide). Uses a non-rolling timer: the countdown starts on the first tap only and does not reset on subsequent taps. Toggling off dev mode also closes the diagnostics panel.

### 3.11 Network Diagnostics

Available in dev mode via the "diag" button. Runs and displays:
- Page origin, protocol, extension status, chrome.runtime availability, app version, Portal status, configured URL
- **HTTPS fetch test** — Fetches `devices.enc` to confirm host connectivity (currently GitHub Pages; production: `ios.flyone-g.com`)
- **Extension proxy ping** — Sends a ping through the extension communication layer
- **IOS via extension** — Proxied fetch to the configured IOS URL (if set)
- **IOS direct fetch** — Direct `no-cors` fetch to the IOS URL (expected to fail from HTTPS; useful for diagnostics)

### 3.12 URL Validation

`validateUrl(urlString)` enforces a strict allowlist:
- `flyone-g.com` / `www.flyone-g.com` — any port
- `192.168.103.x` — any port (test lab subnet)
- RFC 1918 private IPs (`10.x`, `172.16-31.x`, `192.168.x`) — port 3100 only
- `localhost` — port 3100 only
- Everything else is rejected

### 3.13 Theme System

Light theme (default) and dark theme, controlled by CSS custom properties on `:root`. The light theme is activated via `data-theme="light"` on the root element; removing that attribute reverts to dark. Persisted in localStorage under `THEME_KEY`. A theme toggle button appears in the config footer and as a standalone button on connecting/retry screens.

### 3.14 Wake Lock

Uses the Screen Wake Lock API (`navigator.wakeLock.request('screen')`) to prevent the Chromebook display from sleeping during kiosk operation. Re-acquires the lock on `visibilitychange` if it was released.

### 3.15 Back-Forward Cache Recovery

A `pageshow` event listener detects when Chrome restores the page from bfcache (`event.persisted`). If the page is restored with stale state (e.g., stuck on a green banner), it re-triggers `navigateToUrl()` for the current URL.

---

## 4. Chrome Extension (`ios-kiosk-extension/`)

### 4.1 Manifest (`manifest.json`)

- **Manifest V3** with a `service_worker` background script.
- **Permissions:** `storage`, `scripting`, `tabs`, `webNavigation`
- **Host permissions:** `https://dkpine.github.io/*` (test; production: `https://ios.flyone-g.com/*`), `http://*:3100/*`, `http://localhost:3100/*`
- **`externally_connectable`:** Allows `https://dkpine.github.io/*` (test; production: `https://ios.flyone-g.com/*`) to call `chrome.runtime.sendMessage()` directly.
- **Content scripts:** Two declarative injections:
  1. `content.js` into `https://dkpine.github.io/ios-kiosk-pwa/*` (test; production: `https://ios.flyone-g.com/*`) (bridge)
  2. `watchdog.js` into `http://*:3100/*` filtered to private IP ranges (health monitor)
- **Deterministic extension ID** via the `key` field, ensuring consistent `EXTENSION_ID` across installations.

### 4.2 Service Worker (`background.js`)

**Message handler (`handleRequest`)** — Shared handler for both `onMessage` (from content script) and `onMessageExternal` (from page directly):
- `ping` — Returns `{ok: true, version}` for extension detection
- `fetch` — Performs `fetch(url, {mode: 'no-cors'})` with configurable timeout via `AbortController`. Returns `{ok, status, type}` or `{ok: false, error}`.
- `storageGet/Set/Remove` — Proxies `chrome.storage.local` operations

**Programmatic content script injection** — Belt-and-suspenders: even though `content.js` is declared in the manifest, the service worker also programmatically injects it via `chrome.scripting.executeScript` when a kiosk page tab finishes loading. Handles both `tabs.onUpdated` and startup queries for already-open tabs. Tracks injected tabs in `injectedTabs` to prevent double injection.

**Watchdog injection** — Same programmatic injection pattern for `watchdog.js` into IOS HTTP pages. `isIosUrl(url)` validates against the private IP + port 3100 regex pattern.

**Navigation error recovery** — `webNavigation.onErrorOccurred` listener catches failed navigations to IOS URLs (connection refused, DNS error, timeout). After a 500ms delay (to let Chrome render the error page), redirects the tab back to the kiosk PWA with `?recovery=<encoded_failed_url>`. This is the critical mechanism that returns the user to the PWA when the IOS is unreachable — without it, the user is stranded on Chrome's error page.

### 4.3 Content Script Bridge (`content.js`)

Injected into the kiosk PWA page (currently GitHub Pages; production: `ios.flyone-g.com`). Wrapped in an IIFE with a `__iosKioskContentScriptLoaded` double-injection guard. All `chrome.runtime` calls are wrapped in try-catch to handle "Extension context invalidated" errors. All `postMessage` replies use the `KIOSK_ORIGIN` constant (set to the PWA's HTTPS origin) as the target origin, preventing eavesdropping by other frames or extensions.

On load, immediately posts `{iosKioskReply: true, type: 'extensionReady', version}` to announce presence to the page.

Listens for `window.postMessage` with `{iosKiosk: true}` flag. Supported message types:
- `ping` — Replies directly with version
- `fetch` — Relays to service worker via `chrome.runtime.sendMessage`, relays response back
- `storageGet/Set/Remove` — Same relay pattern

### 4.4 Watchdog Script (`watchdog.js`)

Injected into IOS HTTP pages. Wrapped in an IIFE with a `__iosKioskWatchdogLoaded` guard. Starts monitoring after a 3-second initial delay.

Pings the IOS server's origin every 5 seconds via `fetch(window.location.origin + '/', {mode: 'no-cors'})` with a 4-second timeout. Tracks consecutive failures. After 3 consecutive failures, redirects the browser to the kiosk PWA URL with `?recovery=<encoded_current_url>`, matching the same recovery parameter convention used by the service worker's `onErrorOccurred` handler. This ensures that if the IOS server crashes while the user is on it, they are automatically returned to the kiosk app's retry flow with the IOS URL preserved.

---

## 5. Security Considerations

### 5.1 Honeypot System

Unknown tail numbers receive a deterministic fake IOS address (`generateHoneypotUrl`) rather than a "not found" error. This prevents serial enumeration — an attacker cannot distinguish valid from invalid serials by observing the UI or network traffic. The honeypot URL is a plausible `10.x.x.x:3100` address derived from a hash of the input. No console logs are emitted for honeypot assignments.

### 5.2 Encrypted Device Database (Temporary)

The `devices.enc` file is encrypted with AES-256-GCM, but the decryption key is hardcoded in client-side JavaScript. This provides obfuscation (casual inspection reveals nothing) but not real security — anyone who reads the source can decrypt the database. This is a known, accepted limitation that will be eliminated when Portal integration replaces the local database.

### 5.3 URL Validation

The manual entry URL field enforces a strict allowlist of private IP ranges and `flyone-g.com`. This prevents the kiosk from being used as an open redirect to arbitrary websites.

### 5.4 Portal Token Caching

The Portal JWT token is cached in localStorage for session persistence. On 401 responses, the cache is cleared and re-authentication occurs on the next lookup.

---

## 6. CSS Architecture (`application.css`)

### 6.1 Theming

Light theme is the default. Dark theme is available via toggle. All colors are defined as CSS custom properties (`--bg-page`, `--text-primary`, `--accent`, etc.) on `:root` (dark values) and `:root[data-theme="light"]` (light overrides). The `initTheme()` function sets `data-theme="light"` on page load unless the user has explicitly saved a dark preference.

### 6.2 Dialog Layout

Both the config overlay and troubleshoot panel use the same layout pattern: fixed-position full-screen backdrop (`overflow: hidden`) with a centered dialog box that scrolls internally. The dialog uses `max-height: calc(100vh - 24px)` with `overflow-y: auto` and styled thin scrollbars that respect the 16px `border-radius` (scrollbar track has `margin: 16px 0` to inset from corners).

Spacing is compact-first: padding, margins, and font sizes are tightened so all content fits on screen before the scrollbar appears. The scrollbar is a last resort for edge cases like having both the manual entry section and diagnostics panel open simultaneously.

### 6.3 Dev Mode

The config footer's `.dev-mode` class reveals hidden elements: the diag button, extension status indicator, and Portal status indicator. The extension status sits centered in the footer (using `margin-left: auto` to split space between the theme button on the left and the diag/version on the right).

### 6.4 Banner States

- **Amber (connecting):** `cursor: pointer` — clickable to abort and return to config
- **Green (success):** `cursor: default` — not interactive
- **Red (failure):** Clickable to open troubleshooting panel

### 6.5 Responsive Design

Two media query breakpoints:
- `max-width: 480px` — Stacks buttons vertically, reduces padding, shrinks fonts
- `max-height: 500px` — Aggressive padding reduction for landscape/short screens

---

## 7. Deployment & Administration

### 7.1 Hosting

The PWA is currently hosted on GitHub Pages (`https://dkpine.github.io/ios-kiosk-pwa/`) **strictly for early internal development and testing**. GitHub Pages provides free, zero-configuration HTTPS hosting, which was essential for rapid iteration during initial development. However, it is not suitable for production deployment — it depends on a third-party service, the URL is not branded, and any GitHub outage would take the fleet offline.

**Production hosting** will be at `https://ios.flyone-g.com` (or equivalent one-G subdomain), giving full control over availability, CORS configuration, and branding. All hardcoded GitHub Pages URLs in the extension (manifest, background.js, watchdog.js) will be updated as part of that migration.

### 7.2 ChromeOS Kiosk Configuration

Chromebooks are enrolled in Google Workspace and configured via the Admin Console:
- **Kiosk URL:** `https://dkpine.github.io/ios-kiosk-pwa/` (test) → `https://ios.flyone-g.com` (production)
- **Extension:** Force-installed via the Admin Console extension policy

### 7.3 Extension Distribution & Self-Hosting Challenges

The extension has gone through two distribution strategies, driven by problems encountered with self-hosting on ChromeOS kiosk devices:

**Self-hosted (initial approach):** The extension was packaged as a `.crx` and served from GitHub Pages with an `updates.xml` manifest. The extension ID (`ffcoooniadfdngdceeiopbkdljcgnoha`) is deterministic via the `key` field in `manifest.json`. This worked in non-kiosk Chrome and in developer mode, but **failed to load reliably on managed Chromebooks in URL-based kiosk mode**. ChromeOS kiosk sessions enforce stricter extension policies than regular browser sessions — self-hosted extensions configured via `ExtensionInstallForcelist` were either silently ignored or failed to install during the kiosk session bootstrap. The extension would never appear, and the PWA would fall back to the no-extension path (blind navigation), which cannot recover from connection failures.

**Chrome Web Store (current approach):** To resolve the self-hosted loading issue, the extension was submitted to the Chrome Web Store (ID: `ojhmfklcaknmocfiibdeclhahffofgan`). Web Store extensions are treated as first-class citizens by ChromeOS kiosk mode and install reliably via the Admin Console's kiosk app/extension configuration. **Version 3.4.0 is currently pending Google's review.** Once approved, v3.5.4 will be uploaded as an update. The `EXTENSION_ID` in `application.js` currently still references the self-hosted ID and will need to be updated to the Web Store ID once the extension is published and confirmed working on production kiosk devices.

The self-hosted ID and infrastructure remain in place as a fallback for development and non-kiosk testing.

### 7.4 Production Migration

When moving from GitHub Pages to `ios.flyone-g.com`:
1. Update `KIOSK_URL_PATTERN` in `background.js`
2. Update `externally_connectable.matches` in `manifest.json`
3. Update `content_scripts[0].matches` in `manifest.json`
4. Update `KIOSK_APP_URL` in `watchdog.js`
5. Update `KIOSK_ORIGIN` in `content.js`
6. Update `host_permissions` in `manifest.json`
7. Update `EXTENSION_ID` in `application.js` to Web Store ID
8. Publish extension update to Web Store
9. Update Admin Console kiosk URL and extension policy

---

## 8. Pending Work

1. **Chrome Web Store review** — Extension v3.4.0 pending. Once approved, upload v3.5.4 as update.
2. **Portal endpoint implementation** — Portal dev needs to implement `/apiv2/kiosk/lookup` with CORS headers per `PORTAL-API-SPEC.md`. Kiosk-side code is complete.
3. **Remove local device database** — After Portal is validated: delete `devices.enc`, `devices.json`, `encrypt-devices.js`, and the `loadDeviceDb()`/`localDbLookup()` code.
4. **Production Chromebook testing** — End-to-end validation in URL-based kiosk mode with the extension installed.
5. **Production hosting migration** — Move PWA to `ios.flyone-g.com` and update extension URLs.
