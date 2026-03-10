All done. Here's a summary of what was created:

New PWA Project: ios-kiosk-pwa/
ios-kiosk-pwa/
  index.html          Main page: iframe + config overlay (replaces application.html + options.html)
  application.js      Core logic: localStorage, Ctrl+Shift+O hotkey, iframe mgmt, 
                      connection retry w/ backoff, WakeLock, screenshot/print via postMessage
  application.css     Dark theme (navy + gold branding), fullscreen iframe, 
                      touch-friendly config overlay (48px min button height)
  manifest.json       W3C PWA manifest (display: fullscreen)
  sw.js               Service worker: caches shell files for offline, passes through iframe content
  icons/              Copied from legacy app (16, 48, 128px)

How it works (same as the legacy app):
Boot -- checks localStorage for saved URL. If found, loads it in the iframe immediately. If not, shows the config dialog.
Config -- Ctrl+Shift+O toggles the config overlay at any time. Enter a URL, hit Save, and it connects.
Retry -- if the instructor station server isn't up yet (common at boot), it retries with exponential backoff (5s, 7.5s, 11s... capped at 30s).
Persistence -- URL persists in localStorage across reboots until changed.
Screen wake -- WakeLock API keeps screen on (supplemented by Admin Console power policy).
Screenshots -- listens for postMessage requests with { name: 'screenshot' }.
Before deploying to production, you'll need to:
Generate 192px and 512px icons from the existing 128px icon (for full PWA installability)
Host the files on HTTPS (GitHub Pages, Cloudflare Pages, your domain, etc.)
Configure Google Admin Console -- add the hosted URL as a Managed Web App Kiosk, enable auto-launch for your device OU
Test on a real Chromebook -- verify hotkey works in kiosk mode, verify localStorage persists across reboots
Update instructor station code (if screenshot feature is used) to use window.postMessage instead of chrome.runtime.sendMessage
The legacy chromebook-launcher/ folder is completely untouched.