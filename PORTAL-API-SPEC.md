# Kiosk → Portal API Specification

**Version:** 1.3
**Date:** March 2026
**For:** Portal backend developer
**Status:** Kiosk-side implementation is complete and ready for integration. The only remaining work is on the Portal side: the new endpoint and CORS configuration described below.

## Overview

The 1G-IOS Kiosk web app needs to look up a simulator's local network IOS address by its serial (tail number minus the N prefix). The kiosk strips the N prefix before sending to the Portal. The kiosk authenticates with the Portal (same `/apiv2/auth` endpoint the IOS uses), then calls a new endpoint to resolve the serial to a local IOS URL.

If the Portal is unreachable, the kiosk falls back to an encrypted local device database — so this is additive, not a hard dependency.

## Serial Format and Leading Zeros

The kiosk strips any `N` or `SIM-` prefix and sends the raw serial. Examples:

| User enters | Kiosk sends |
|------------|-------------|
| 321GX      | 321GX       |
| N321GX     | 321GX       |
| SIM-321GX  | 321GX       |
| N021GF     | 021GF       |
| 21GF       | 21GF        |
| SIM-41GT   | 41GT        |

**Important:** Some serials have leading zeros (e.g., `021GF`) and some don't (e.g., `41GT`). The Portal should normalize by stripping leading zeros before comparing, so that `021GF` and `21GF` both match the same device. Store whichever form is canonical in the database, but match flexibly.

Recommended Portal matching logic:
```
incomingSerial.replace(/^0+/, '') === storedSerial.replace(/^0+/, '')
```

## Authentication (existing endpoint)

The kiosk reuses the existing IOS auth flow. No changes needed here.

```
POST /apiv2/auth
Content-Type: application/json

Request:
{
  "id": "321GX"           // serial (tail number without N prefix)
}

Response (200):
{
  "token": "eyJhbG..."   // JWT token
}

Response (4xx/5xx):
{
  "error": "description"
}
```

The kiosk authenticates when the user enters a tail number and hits Look Up. The token is cached in the browser for subsequent lookups.

## New Endpoint: Kiosk Device Lookup

```
POST /apiv2/kiosk/lookup
Content-Type: application/json

Request:
{
  "token": "eyJhbG...",   // from /apiv2/auth
  "serial": "321GX"       // serial (tail number without N prefix)
}

Response (200, found):
{
  "url": "http://10.38.1.1:3100/"
}

Response (200, not found):
{
  "url": null
}

Response (401):
{
  "error": "Token expired or invalid"
}

Response (5xx):
{
  "error": "description"
}
```

### Behavior Notes

- **Serial format:** Always WITHOUT the N prefix. May include leading zeros. The Portal should match case-insensitively and normalize leading zeros (see above).

- **Not-found response:** Return `200` with `"url": null` (not a 404). The kiosk deliberately does not distinguish "not found" from "offline" to prevent serial enumeration. A 404 would leak information to anyone watching network traffic.

- **URL format:** The `url` field should be a full URL including protocol, IP, and port — e.g., `http://10.38.1.1:3100/`. This is the address the Chromebook will navigate to on the local network.

- **Token expiry:** If the token is expired, return 401. The kiosk will clear its cached token and re-authenticate on the next lookup.

- **Timeout:** The kiosk sets a 5-second timeout on both auth and lookup requests. If the Portal doesn't respond in time, it falls back to the local encrypted database silently.

## CORS Configuration (required)

The kiosk runs in the browser and makes cross-origin requests to the Portal. Both endpoints (`/apiv2/auth` and `/apiv2/kiosk/lookup`) must return proper CORS headers, otherwise the browser will block the requests silently.

**Required response headers:**

```
Access-Control-Allow-Origin: <kiosk origin>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

The Portal must also handle `OPTIONS` preflight requests on both endpoints and return these same headers.

**Kiosk origins to allow:**

| Environment | Origin |
|-------------|--------|
| Test (current) | `https://dkpine.github.io` |
| Production (planned) | `https://ios.flyone-g.com` |

During development, allow both origins. Once the production deployment is confirmed, the GitHub Pages origin can be removed. A wildcard subdomain like `*.flyone-g.com` is also acceptable if the Portal prefers that approach.

**Why this matters:** The IOS itself talks to the Portal from server-side Node.js code, so CORS has never been needed before. The kiosk is the first client hitting the Portal directly from a browser, which triggers the browser's same-origin policy. Without these headers, the kiosk's `fetch()` calls will fail with a network error — the Portal will receive and process the request, but the browser will refuse to let the kiosk read the response.

## New Data Field

Each simulator in the Portal database needs a new field:

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `iosLocalUrl` | String | `http://10.38.1.1:3100/` | Local network URL for the IOS web interface |

This field should be editable in the Portal admin UI alongside the existing sim configuration. When a new sim is provisioned in the Portal, the operator fills in the local IOS address as part of setup.

The `/apiv2/kiosk/lookup` endpoint maps `serial → iosLocalUrl` directly.

## Kiosk Lookup Flow

```
1. User enters tail number (e.g. N321GX) and taps Look Up
2. Kiosk strips N prefix → "321GX"
3. Kiosk calls POST /apiv2/auth { id: "321GX" } → gets token
4. Kiosk calls POST /apiv2/kiosk/lookup { token, serial: "321GX" } → gets URL
5. If Portal is unreachable at any step → falls back to local encrypted DB
6. If neither source has the serial → honeypot URL (silent failure loop)
```

## Roadmap: Removing the Local Device Database

The encrypted local device database (`devices.enc`) is a temporary fallback while Portal integration is being built and validated. Once Portal auth and lookup are confirmed working reliably in production, the plan is to **remove `devices.enc` entirely** and rely solely on the Portal as the single source of truth for device lookups — the same model the IOS itself uses.

At that point:
- `devices.enc`, `devices.json`, and `encrypt-devices.js` will be removed from the repo
- The local decryption code and `localDbLookup()` fallback will be stripped from the kiosk app
- All fleet data will live exclusively in the Portal database
- Adding, removing, or reassigning a sim will take effect immediately with no kiosk redeployment
- The honeypot behavior for unknown serials will remain (Portal returns `"url": null`, kiosk generates a dead-end address)

The only exception may be a hardcoded local/test entry (similar to how the IOS accepts one hardcoded `localUser` account for offline operation), but that is TBD based on field requirements.

## Deployment Notes

The kiosk is currently hosted on GitHub Pages (`https://dkpine.github.io/ios-kiosk-pwa/`) for development and testing. Production hosting will move to `https://ios.flyone-g.com`. The Portal URL is hardcoded in the kiosk as `https://portal.flyone-g.com` and does not need to change.

## Testing

Once the endpoint is live and CORS is configured, enter any tail number in the kiosk and hit Look Up. The kiosk will attempt Portal auth + lookup automatically. No changes are needed on the kiosk side — it is ready to go.

Enable dev mode (7-tap the version number in the config footer) to see Portal connection status in the footer and diagnostics panel. The footer will show "Portal OK" (green) on successful auth or "Portal offline" (red) if unreachable.

The kiosk logs all Portal interactions to the browser console with the `[Kiosk]` prefix:
- `[Kiosk] Portal auth successful for 321GX`
- `[Kiosk] Portal lookup: 321GX → http://10.38.1.1:3100/`
- `[Kiosk] Portal miss/fail — falling back to local DB`

If auth or lookup fails silently with no console output, the issue is almost certainly CORS — check the browser's Network tab for blocked preflight requests.
