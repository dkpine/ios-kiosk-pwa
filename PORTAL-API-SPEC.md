# Kiosk → Portal API Specification

**Version:** 1.0
**Date:** March 2026
**For:** Portal backend developer

## Overview

The 1G-IOS Kiosk web app needs to look up a simulator's local network IOS address by tail number. The kiosk authenticates with the Portal the same way the IOS does (using the sim serial as the site key), then calls a new endpoint to resolve tail → IOS URL.

If the Portal is unreachable, the kiosk falls back to an encrypted local device database — so this is additive, not a hard dependency.

## Authentication (existing endpoint)

The kiosk reuses the existing IOS auth flow. No changes needed here.

```
POST /apiv2/auth
Content-Type: application/json

Request:
{
  "id": "111GX"          // sim serial (site key)
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

The kiosk stores the site key in its local config. On startup, it authenticates and caches the token for subsequent lookups.

## New Endpoint: Kiosk Device Lookup

```
POST /apiv2/kiosk/lookup
Content-Type: application/json

Request:
{
  "token": "eyJhbG...",   // from /apiv2/auth
  "tail": "N321GX"        // normalized tail number (always N-prefixed)
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

- **Tail number format:** The kiosk always sends the normalized form with the `N` prefix (e.g., `N321GX`, `N12345`, `N99AB`). The Portal should match case-insensitively.

- **Not-found response:** Return `200` with `"url": null` (not a 404). The kiosk deliberately does not distinguish "not found" from "offline" to prevent tail number enumeration. A 404 would leak information to anyone watching network traffic.

- **URL format:** The `url` field should be a full URL including protocol, IP, and port — e.g., `http://10.38.1.1:3100/`. This is the address the Chromebook will navigate to on the local network.

- **Token expiry:** If the token is expired, return 401. The kiosk will clear its cached token and re-authenticate on the next lookup.

- **Timeout:** The kiosk sets a 5-second timeout on this request. If the Portal doesn't respond in time, it falls back to the local encrypted database silently.

## New Data Field

Each simulator in the Portal database needs a new field:

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `iosLocalUrl` | String | `http://10.38.1.1:3100/` | Local network URL for the IOS web interface |

This field should be editable in the Portal admin UI alongside the existing sim configuration (serial, aircraft, site, etc.). When a new sim is provisioned in the Portal, the operator fills in the local IOS address as part of setup.

The `/apiv2/kiosk/lookup` endpoint maps `tail number → sim → iosLocalUrl`.

### Lookup Logic

The tail number is the aircraft registration (e.g., N321GX). The Portal already associates sims with aircraft, so the lookup chain is:

```
tail number → aircraft → sim assignment → sim.iosLocalUrl
```

If a tail number maps to multiple sims (e.g., fleet reassignment), return the currently active/assigned one.

## Testing

Once the endpoint is live, configure the kiosk's site key in dev mode (7-tap the version number in the config footer, then enter the sim serial in the Site Key field). The diagnostics panel will show Portal connection status.

The kiosk logs all Portal interactions to the browser console with the `[Kiosk]` prefix:
- `[Kiosk] Portal auth successful`
- `[Kiosk] Portal lookup: N321GX → http://10.38.1.1:3100/`
- `[Kiosk] Portal miss/fail — falling back to local DB`
