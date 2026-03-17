/* ============================================================
   Instructor Station Kiosk - GitHub Pages App
   Core application logic — v3.6

   This runs from the GitHub Pages HTTPS origin. HTTP fetch
   probes to private-IP IOS servers are proxied through the
   companion Chrome extension via a content script bridge.
   The content script (injected by the extension) relays
   postMessage calls to the extension's service worker.

   Once the IOS is found, the page navigates directly to
   the HTTP URL (top-level navigation is not subject to
   mixed-content blocking).

   Without the extension, two safety nets detect IOS failures:
     1. Dead man's switch — if the page hasn't unloaded after
        NAV_TIMEOUT_MS, call window.stop() and enter retry flow.
     2. localStorage breadcrumb — on next page load, detect a
        stale navigation stamp and skip straight to retry flow.

   devices.enc (AES-256-GCM encrypted) is fetched from the same
   GitHub Pages origin and decrypted client-side.
   ============================================================ */

(function () {
  'use strict';

  // ---- Constants ----

  var STORAGE_KEY = 'ios_addr';
  var THEME_KEY = 'ios_theme';
  var PROBE_TIMEOUT_MS = 8000;
  var SUCCESS_BANNER_MS = 2000;
  var RETRY_COOLDOWN_S = 10;
  var RING_CIRCUMFERENCE = 2 * Math.PI * 52; // must match <circle r="52"> in index.html
  var APP_VERSION = '3.6';
  var EXTENSION_ID = 'ffcoooniadfdngdceeiopbkdljcgnoha';
  var DEVICES_ENC_URL = './devices.enc';
  var DEVICES_KEY_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  var RECOVERY_KEY = 'kiosk_recovery';
  var NAV_TIMEOUT_MS = 8000;
  var PORTAL_URL = 'https://portal.flyone-g.com';
  var PORTAL_TOKEN_STORAGE = 'kiosk_portal_token';
  var PORTAL_TOKEN_SERIAL_KEY = 'kiosk_portal_serial';

  // ---- Extension Communication ----
  //
  // Three communication strategies (tried in order):
  //   1. Content script bridge — extension injects content.js, we use
  //      window.postMessage to relay to the service worker
  //   2. externally_connectable — page calls chrome.runtime.sendMessage()
  //      directly to the extension (official ChromeOS kiosk pattern)
  //   3. Late arrival — if the extension loads after init, re-trigger
  //
  // Strategy 2 requires the extension to declare externally_connectable
  // in its manifest AND for chrome.runtime to be exposed to this page.

  var extensionAvailable = false;
  var useDirectChannel = false; // true if using externally_connectable
  var pendingRequests = {};
  var requestCounter = 0;

  function nextRequestId() {
    requestCounter = (requestCounter + 1) % 1000000;
    return requestCounter;
  }

  var extensionVersion = '?';
  var onExtensionReady = null; // late-arrival callback

  // ---- Strategy 1: Content script bridge via postMessage ----

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || !data.iosKioskReply) return;

    if (data.type === 'extensionReady') {
      extensionAvailable = true;
      useDirectChannel = false;
      extensionVersion = data.version || '?';
      if (onExtensionReady) {
        onExtensionReady();
        onExtensionReady = null;
      }
      return;
    }

    var id = data.requestId;
    if (id && pendingRequests[id]) {
      var cb = pendingRequests[id];
      delete pendingRequests[id];
      cb(data);
    }
  });

  // ---- Strategy 2: Direct chrome.runtime.sendMessage ----

  function tryDirectMessage(message, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(EXTENSION_ID, message, function (response) {
          if (chrome.runtime.lastError) {
            if (callback) callback({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            if (callback) callback(response || { ok: false, error: 'No response' });
          }
        });
        return true;
      }
    } catch (e) {
      // chrome.runtime not available
    }
    return false;
  }

  // ---- Unified send function ----

  var BRIDGE_DEFAULT_TIMEOUT = 2000;

  function sendToExtension(message, callback, bridgeTimeout) {
    if (useDirectChannel) {
      // Use externally_connectable direct path
      tryDirectMessage(message, callback);
      return;
    }

    // Use content script bridge (postMessage)
    var id = nextRequestId();
    message.iosKiosk = true;
    message.requestId = id;

    if (callback) {
      pendingRequests[id] = callback;
      // Bridge timeout must be >= the operation's own timeout so that
      // slow-but-valid responses (e.g. fetch to a cold IOS server)
      // are not killed prematurely by the bridge layer.
      var timeoutMs = bridgeTimeout || BRIDGE_DEFAULT_TIMEOUT;
      setTimeout(function () {
        if (pendingRequests[id]) {
          delete pendingRequests[id];
          callback({ ok: false, error: 'Extension timeout' });
        }
      }, timeoutMs);
    }

    window.postMessage(message, '*');
  }

  // ---- Extension detection with polling and dual-strategy ----

  function checkExtension(callback) {
    if (extensionAvailable) {
      if (callback) callback(true, { ok: true, version: extensionVersion });
      return;
    }

    var attempts = 0;
    var maxAttempts = 14; // ~25 seconds total

    function attempt() {
      if (extensionAvailable) {
        if (callback) callback(true, { ok: true, version: extensionVersion });
        return;
      }

      attempts++;

      // Try content script bridge first
      var bridgeId = nextRequestId();
      var bridgeMsg = { iosKiosk: true, requestId: bridgeId, type: 'ping' };
      var resolved = false;

      pendingRequests[bridgeId] = function (response) {
        if (resolved) return;
        resolved = true;
        if (response && response.ok) {
          extensionAvailable = true;
          useDirectChannel = false;
          if (response.version) extensionVersion = response.version;
          if (callback) callback(true, response);
        }
      };

      // Timeout for bridge attempt
      setTimeout(function () {
        if (pendingRequests[bridgeId]) {
          delete pendingRequests[bridgeId];
        }
      }, 1200);

      window.postMessage(bridgeMsg, '*');

      // Also try direct channel (externally_connectable)
      tryDirectMessage({ type: 'ping' }, function (response) {
        if (resolved) return;
        resolved = true;
        delete pendingRequests[bridgeId]; // cancel bridge wait
        if (response && response.ok) {
          extensionAvailable = true;
          useDirectChannel = true;
          extensionVersion = response.version || '?';
          console.log('[Kiosk] Extension found via direct channel (externally_connectable)');
          if (callback) callback(true, response);
        }
      });

      // If neither worked after 1.5s, retry
      setTimeout(function () {
        if (!resolved) {
          resolved = true;
          delete pendingRequests[bridgeId];
          if (attempts < maxAttempts) {
            attempt();
          } else {
            if (callback) callback(false, { ok: false, error: 'Extension not found after ' + attempts + ' attempts' });
          }
        }
      }, 1800);
    }

    attempt();
  }

  function proxyFetch(url, timeout, callback) {
    if (!extensionAvailable) {
      callback({ ok: false, error: 'Extension not available' });
      return;
    }
    var fetchTimeout = timeout || PROBE_TIMEOUT_MS;
    sendToExtension({
      type: 'fetch',
      url: url,
      timeout: fetchTimeout
    }, callback, fetchTimeout + 2000); // bridge timeout = fetch timeout + IPC margin
  }

  // ---- DOM References ----

  var configOverlay = document.getElementById('config-overlay');
  var connectionStatus = document.getElementById('connection-status');
  var statusMessage = document.getElementById('status-message');
  var troubleshootPanel = document.getElementById('troubleshoot-panel');
  var btnRetry = document.getElementById('btn-retry');
  var btnTroubleshootClose = document.getElementById('btn-troubleshoot-close');
  var addrInput = document.getElementById('ios-addr-input');
  var validationMsg = document.getElementById('validation-msg');
  var currentUrlDisplay = document.getElementById('current-url-display');
  var btnSave = document.getElementById('btn-save');
  var btnClear = document.getElementById('btn-clear');
  var btnClose = document.getElementById('btn-close');
  var btnTheme = document.getElementById('btn-theme');
  var btnOpenConfig = document.getElementById('btn-open-config');
  var tailInput = document.getElementById('tail-input');
  var btnLookup = document.getElementById('btn-lookup');
  var lookupMsg = document.getElementById('lookup-msg');
  var btnManualToggle = document.getElementById('btn-manual-toggle');
  var manualSection = document.getElementById('manual-section');
  var versionDisplay = document.getElementById('version-display');
  var configLoading = document.getElementById('config-loading');
  var configDialog = configOverlay ? configOverlay.querySelector('.config-dialog') : null;
  var countdownOverlay = document.getElementById('countdown-overlay');
  var countdownSecondsEl = document.getElementById('countdown-seconds');
  var countdownRingProgress = document.getElementById('countdown-ring-progress');
  var countdownTroubleshootLink = document.getElementById('countdown-troubleshoot-link');
  var bgLogo = document.getElementById('bg-logo');
  var pageThemeToggle = document.getElementById('page-theme-toggle');
  var countdownRingWrap = countdownOverlay ? countdownOverlay.querySelector('.countdown-ring-wrap') : null;
  var btnDiag = document.getElementById('btn-diag');
  var diagResults = document.getElementById('diag-results');
  var extStatus = document.getElementById('ext-status');
  var portalStatus = document.getElementById('portal-status');
  var troubleshootBoot = document.getElementById('troubleshoot-boot');
  var troubleshootWatchdog = document.getElementById('troubleshoot-watchdog');
  var infoPanel = document.getElementById('info-panel');
  var btnInfo = document.getElementById('btn-info');
  var btnInfoClose = document.getElementById('btn-info-close');
  var pageCopyright = document.getElementById('page-copyright');

  // ---- State ----

  var portalToken = null;
  var deviceDb = null;
  var currentUrl = null;
  var retryTimer = null;
  var countdownInterval = null;
  var successTimer = null;
  var wakeLock = null;
  var countdownRetryUrl = null;
  var loadingTimer = null;
  var navTimeoutTimer = null;
  var currentTroubleshootContext = 'boot';

  // ============================================================
  // Storage Helpers — uses localStorage (web page context)
  // with extension chrome.storage.local as sync backup
  // ============================================================

  function storageGet(key, callback) {
    var val = localStorage.getItem(key);
    if (val !== null) {
      if (callback) callback(val);
      return;
    }
    if (extensionAvailable) {
      sendToExtension({ type: 'storageGet', key: key }, function (resp) {
        if (resp && resp.ok && resp.value !== null) {
          localStorage.setItem(key, resp.value);
          if (callback) callback(resp.value);
        } else {
          if (callback) callback(null);
        }
      });
    } else {
      if (callback) callback(null);
    }
  }

  function storageSet(key, value) {
    localStorage.setItem(key, value);
    if (extensionAvailable) {
      sendToExtension({ type: 'storageSet', key: key, value: value });
    }
  }

  function storageRemove(key) {
    localStorage.removeItem(key);
    if (extensionAvailable) {
      sendToExtension({ type: 'storageRemove', key: key });
    }
  }

  // ============================================================
  // Navigation Recovery
  //
  // Two strategies for detecting IOS failures without extension:
  //
  //   1. Dead man's switch — after setting window.location.href,
  //      a timeout fires if the page hasn't unloaded. This means
  //      the server is timing out. Call window.stop() to cancel
  //      the pending navigation and enter the failure/retry flow.
  //
  //   2. localStorage breadcrumb — before navigating, stamp a
  //      breadcrumb. If the server refuses connection instantly,
  //      Chrome replaces us with an error page before the timeout
  //      fires. When the kiosk session eventually restarts and
  //      reloads this URL, detect the stale breadcrumb and go
  //      straight into the failure/retry flow.
  // ============================================================

  function setRecoveryBreadcrumb(url) {
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({
        url: url,
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  function clearRecoveryBreadcrumb() {
    try { localStorage.removeItem(RECOVERY_KEY); } catch (e) {}
  }

  /**
   * Check if we're recovering from a failed navigation.
   * Returns the IOS URL if a recent breadcrumb is found, null otherwise.
   */
  function checkRecoveryState() {
    try {
      var raw = localStorage.getItem(RECOVERY_KEY);
      if (!raw) return null;
      localStorage.removeItem(RECOVERY_KEY);
      var data = JSON.parse(raw);
      var age = Date.now() - data.timestamp;
      // If we navigated away less than 2 minutes ago and ended up
      // back on this page, the IOS server was unreachable.
      if (age < 2 * 60 * 1000 && data.url) {
        return data.url;
      }
    } catch (e) {}
    return null;
  }

  // ============================================================
  // Initialization
  // ============================================================

  function init() {
    if (versionDisplay) {
      versionDisplay.textContent = 'v' + APP_VERSION;
    }

    // Set up UI immediately (don't wait for extension)
    initTheme();
    setupWakeLock();
    setupHotkey();
    setupButtons();
    loadDeviceDb();

    // ---- Recovery check ----
    // Two recovery sources:
    //   1. localStorage breadcrumb (set before blind navigation without extension)
    //   2. ?recovery= query param (set by extension service worker when
    //      webNavigation.onErrorOccurred fires for an IOS URL)
    var recoveryUrl = checkRecoveryState();
    var recoveryType = 'boot'; // default: IOS never reached
    if (!recoveryUrl) {
      try {
        var params = new URLSearchParams(window.location.search);
        var extRecovery = params.get('recovery');
        if (extRecovery) {
          console.log('[Kiosk] Recovery URL from extension: ' + extRecovery);
          recoveryUrl = extRecovery;
          // 'watchdog' = IOS was running and dropped mid-session
          // 'nav_error' = extension caught a navigation failure
          var rt = params.get('recovery_type');
          if (rt === 'watchdog' || rt === 'nav_error') recoveryType = rt;
          // Clean the query string so refreshes don't loop
          history.replaceState(null, '', window.location.pathname);
        }
      } catch (e) {}
    }

    // Set troubleshoot panel context based on how we got here
    if (recoveryUrl) {
      setTroubleshootContext(recoveryType);
    }

    function updateExtStatus(available, response) {
      if (extStatus) {
        if (available) {
          extStatus.textContent = 'Ext v' + (response.version || extensionVersion) + ' OK';
          extStatus.className = 'ext-status ext-ok';
        } else {
          extStatus.textContent = 'Waiting for extension...';
          extStatus.className = 'ext-status ext-missing';
        }
      }
    }

    function bootWithExtension() {
      updateExtStatus(true, { version: extensionVersion });
      updatePortalStatus(portalToken ? true : false);
      clearRecoveryBreadcrumb(); // Extension handles its own watchdog

      // Prefer the stored configured URL over the recovery URL.
      // Recovery just signals "IOS is down" — it may be a sub-page
      // (e.g. /session/resetpin) that shouldn't overwrite the config.
      var savedUrl = localStorage.getItem(STORAGE_KEY);
      if (!savedUrl && recoveryUrl) {
        // Extract root URL (origin + port) — recovery URL may be a sub-page
        try {
          var u = new URL(recoveryUrl);
          savedUrl = u.origin + '/';
        } catch (e) {
          savedUrl = recoveryUrl;
        }
        localStorage.setItem(STORAGE_KEY, savedUrl);
      }
      if (savedUrl) {
        if (recoveryUrl) {
          console.log('[Kiosk] Recovery (with extension): re-attempting ' + savedUrl);
        }
        currentUrl = savedUrl;
        updateCurrentUrlDisplay(savedUrl);
        navigateToUrl(savedUrl);
      } else {
        // Try migrating from extension storage
        sendToExtension({ type: 'storageGet', key: STORAGE_KEY }, function (resp) {
          if (resp && resp.ok && resp.value) {
            localStorage.setItem(STORAGE_KEY, resp.value);
            currentUrl = resp.value;
            updateCurrentUrlDisplay(resp.value);
            navigateToUrl(resp.value);
          } else {
            showConfigOverlay();
          }
        });
      }
    }

    function bootWithoutExtension() {
      updateExtStatus(false, {});
      updatePortalStatus(portalToken ? true : false);

      // Register a late-arrival callback: if the extension loads later,
      // re-trigger the boot sequence with extension support
      onExtensionReady = function () {
        console.log('[Kiosk] Extension arrived late — re-initializing with proxy support');
        bootWithExtension();
      };

      var savedUrl = localStorage.getItem(STORAGE_KEY);
      if (!savedUrl && recoveryUrl) {
        // Extract root URL (origin + port) — recovery URL may be a sub-page
        try {
          var u = new URL(recoveryUrl);
          savedUrl = u.origin + '/';
        } catch (e) {
          savedUrl = recoveryUrl;
        }
        localStorage.setItem(STORAGE_KEY, savedUrl);
      }
      if (savedUrl) {
        if (recoveryUrl) {
          console.log('[Kiosk] Recovery (no extension): re-attempting ' + savedUrl);
        }
        currentUrl = savedUrl;
        updateCurrentUrlDisplay(savedUrl);
        navigateToUrl(savedUrl);
      } else {
        showConfigOverlay();
      }
    }

    // ---- Boot sequence ----
    // Wait briefly for extension detection before choosing navigation path.
    // The content script "extensionReady" message typically arrives within
    // ~1s, and the explicit checkExtension() poll completes in ~1.8s. We
    // allow up to 2.5s before falling back to the no-extension path.
    //
    // IMPORTANT: Previously, bootWithoutExtension() fired at 0ms and
    // navigated blind after 800ms — but extension detection takes ~1.8s,
    // so the extension was never detected in time. The page navigated away
    // to Chrome's "refused to connect" error even with the extension loaded.
    // This 2.5s wait window fixes that race condition.
    var EXTENSION_WAIT_MS = 2500;
    var bootDecided = false;

    function doBoot(withExtension) {
      if (bootDecided) return;
      bootDecided = true;
      console.log('[Kiosk] Boot decision: ' + (withExtension ? 'with' : 'without') + ' extension');
      if (withExtension) {
        bootWithExtension();
      } else {
        bootWithoutExtension();
      }
    }

    // Fastest path: content script sends "extensionReady" via postMessage
    onExtensionReady = function () {
      console.log('[Kiosk] Extension detected during boot wait (content script ready)');
      doBoot(true);
    };

    // Also actively poll for extension (catches externally_connectable path)
    checkExtension(function (available) {
      if (available) doBoot(true);
    });

    // Fallback: if extension not found within the wait window, boot without it.
    // bootWithoutExtension() registers its own late-arrival callback so if the
    // extension shows up after we've started navigating, it can still re-trigger.
    setTimeout(function () {
      doBoot(false);
    }, EXTENSION_WAIT_MS);
  }

  // ============================================================
  // Device Database
  // ============================================================

  function loadDeviceDb() {
    // Fetch the AES-256-GCM encrypted device database and decrypt client-side.
    // File format: [12-byte IV][16-byte auth tag][ciphertext]
    fetch(DEVICES_ENC_URL)
      .then(function (res) { return res.arrayBuffer(); })
      .then(function (buf) {
        var data = new Uint8Array(buf);
        var iv = data.slice(0, 12);
        var tag = data.slice(12, 28);
        var ciphertext = data.slice(28);

        // Combine ciphertext + tag (Web Crypto expects them concatenated)
        var combined = new Uint8Array(ciphertext.length + tag.length);
        combined.set(ciphertext);
        combined.set(tag, ciphertext.length);

        // Import the static key
        var keyBytes = new Uint8Array(32);
        for (var i = 0; i < 32; i++) {
          keyBytes[i] = parseInt(DEVICES_KEY_HEX.substr(i * 2, 2), 16);
        }

        return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
          .then(function (key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, key, combined);
          });
      })
      .then(function (plainBuf) {
        var json = new TextDecoder().decode(plainBuf);
        deviceDb = JSON.parse(json);
      })
      .catch(function (err) {
        console.error('[Kiosk] Failed to load device database:', err);
        deviceDb = null;
      });
  }

  // ============================================================
  // Portal API — authenticate with one-G Portal and look up
  // device IOS address by tail number. Falls back to the
  // encrypted local device database if Portal is unreachable.
  // ============================================================

  /**
   * Strip the N prefix from a normalized tail number to get the
   * sim serial form used by the Portal (e.g. "N321GX" → "321GX").
   */
  function tailToSerial(normalized) {
    return normalized.replace(/^N/i, '');
  }

  /**
   * Authenticate with the Portal using the sim serial (tail number
   * minus the N prefix). Mirrors the IOS AccessInterface._getAuthToken
   * flow. Caches token in localStorage for session persistence.
   */
  function portalAuth(tailNumber, callback) {
    if (!tailNumber) {
      if (callback) callback(null);
      return;
    }

    var serial = tailToSerial(tailNumber);

    // Use cached token only if it belongs to the same device serial.
    // When a kiosk is reassigned to a different ATD, the old token is
    // invalid — clear it and re-authenticate with the new serial.
    var cached = localStorage.getItem(PORTAL_TOKEN_STORAGE);
    var cachedSerial = localStorage.getItem(PORTAL_TOKEN_SERIAL_KEY);
    if (cached && cachedSerial === serial) {
      portalToken = cached;
      console.log('[Kiosk] Using cached Portal token for ' + serial);
      if (callback) callback(cached);
      return;
    }
    if (cached && cachedSerial !== serial) {
      console.log('[Kiosk] Serial changed (' + cachedSerial + ' → ' + serial + ') — clearing cached Portal token');
      localStorage.removeItem(PORTAL_TOKEN_STORAGE);
      localStorage.removeItem(PORTAL_TOKEN_SERIAL_KEY);
      portalToken = null;
    }
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 5000);

    fetch(PORTAL_URL + '/apiv2/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: serial }),
      signal: controller.signal
    })
      .then(function (res) {
        clearTimeout(timeout);
        if (!res.ok) throw new Error('Portal auth failed (' + res.status + ')');
        return res.json();
      })
      .then(function (data) {
        if (data.token) {
          portalToken = data.token;
          localStorage.setItem(PORTAL_TOKEN_STORAGE, data.token);
          localStorage.setItem(PORTAL_TOKEN_SERIAL_KEY, serial);
          console.log('[Kiosk] Portal auth successful for ' + serial);
          if (callback) callback(data.token);
        } else {
          throw new Error('No token in Portal response');
        }
      })
      .catch(function (err) {
        clearTimeout(timeout);
        console.warn('[Kiosk] Portal auth failed:', err.message);
        portalToken = null;
        if (callback) callback(null);
      });
  }

  /**
   * Look up a tail number via the Portal API.
   * Returns the IOS URL on success, null on failure.
   * callback(url) — url is string or null.
   */
  function portalLookup(tailNumber, callback) {
    if (!portalToken) {
      if (callback) callback(null);
      return;
    }

    var serial = tailToSerial(tailNumber);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 5000);

    fetch(PORTAL_URL + '/apiv2/kiosk/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: portalToken, serial: serial }),
      signal: controller.signal
    })
      .then(function (res) {
        clearTimeout(timeout);
        if (res.status === 401) {
          // Token expired — clear cache and retry auth next time
          localStorage.removeItem(PORTAL_TOKEN_STORAGE);
          localStorage.removeItem(PORTAL_TOKEN_SERIAL_KEY);
          portalToken = null;
          throw new Error('Token expired');
        }
        if (!res.ok) throw new Error('Portal lookup failed (' + res.status + ')');
        return res.json();
      })
      .then(function (data) {
        if (data.url) {
          console.log('[Kiosk] Portal lookup: ' + serial + ' → ' + data.url);
          if (callback) callback(data.url);
        } else {
          console.log('[Kiosk] Portal lookup: ' + serial + ' — no match');
          if (callback) callback(null);
        }
      })
      .catch(function (err) {
        clearTimeout(timeout);
        console.warn('[Kiosk] Portal lookup failed:', err.message);
        if (callback) callback(null);
      });
  }

  /**
   * Look up a tail number in the local encrypted device database.
   * Returns the URL or null.
   */
  function localDbLookup(normalized, raw) {
    if (!deviceDb) return null;

    var url = deviceDb[raw] || deviceDb[normalized];
    // Try without N prefix if started with digits
    if (!url && /^[0-9]/.test(raw)) {
      url = deviceDb['N' + raw];
    }
    // Try zero-padded variations
    if (!url) {
      var match = normalized.match(/^N(\d+)([A-Z]*)$/);
      if (match) {
        var numPart = match[1];
        var suffix = match[2];
        for (var padLen = numPart.length + 1; !url && padLen <= numPart.length + 2; padLen++) {
          var padded = ('000' + numPart).slice(-padLen);
          url = deviceDb['N' + padded + suffix];
        }
      }
    }
    return url || null;
  }

  /**
   * Validate tail number / serial format. Accepts:
   *   N123XX, SIM-123XX, 123XX, 23XX
   *   (N or SIM- prefix optional, 2-5 digits, 0-2 letter suffix)
   * Returns the normalized form (with N prefix) or null if invalid format.
   */
  function normalizeTailNumber(input) {
    var raw = (input || '').trim().toUpperCase();
    // Strip optional N or SIM- prefix
    raw = raw.replace(/^(SIM-|N)/i, '');
    // Require 2-5 digits, optional 1-2 letter suffix
    var m = raw.match(/^(\d{2,5})([A-Z]{0,2})$/);
    if (!m) return null;
    return 'N' + m[1] + m[2];
  }

  /**
   * Generate a deterministic honeypot URL from a tail number string.
   * Produces a plausible-looking 10.x.x.x:3100 address that will never
   * resolve, causing the kiosk to silently enter the failure/retry loop.
   * Indistinguishable from a real IOS being offline.
   */
  function generateHoneypotUrl(tailStr) {
    // Simple deterministic hash → three octets in 10.0.x.x range
    var hash = 0;
    for (var i = 0; i < tailStr.length; i++) {
      hash = ((hash << 5) - hash + tailStr.charCodeAt(i)) | 0;
    }
    var a = Math.abs(hash >> 16) % 256;
    var b = Math.abs(hash >> 8) % 256;
    var c = Math.abs(hash) % 254 + 1; // 1-254, avoid .0 and .255
    return 'http://10.' + a + '.' + b + '.' + c + ':3100/';
  }

  function handleLookup() {
    var raw = (tailInput.value || '').trim().toUpperCase();
    lookupMsg.textContent = '';
    lookupMsg.className = 'validation-msg';

    if (!raw) {
      lookupMsg.textContent = 'Please enter a tail number.';
      lookupMsg.className = 'validation-msg error';
      return;
    }

    // Validate format: N + 2-5 digits + 0-2 letters (N prefix optional)
    var normalized = normalizeTailNumber(raw);
    if (!normalized) {
      lookupMsg.textContent = 'Invalid tail number format.';
      lookupMsg.className = 'validation-msg error';
      return;
    }

    // Show a brief "looking up" state
    lookupMsg.textContent = 'Looking up ' + normalized + '...';
    lookupMsg.className = 'validation-msg';

    // Try Portal first, then fall back to local encrypted DB
    function finishLookup(url) {
      if (!url) {
        // Honeypot: unknown tail numbers get a deterministic dead-end URL.
        // The kiosk silently enters the failure/retry loop — no "not found"
        // message that would reveal whether a tail number is in the database.
        url = generateHoneypotUrl(normalized);
      }

      lookupMsg.textContent = '';
      closeDiagnostics();
      addrInput.value = url;
      saveUrl(url);
      showLoadingAndConnect(url);
    }

    // Try Portal (auth + lookup), then fall back to local encrypted DB.
    // The tail number IS the device identifier (serial), so we auth with it.
    function tryPortalThenLocal() {
      portalAuth(normalized, function (token) {
        if (!token) {
          // Portal unreachable — use local DB
          updatePortalStatus(false);
          finishLookup(localDbLookup(normalized, raw));
          return;
        }
        updatePortalStatus(true);
        portalLookup(normalized, function (portalUrl) {
          if (portalUrl) {
            finishLookup(portalUrl);
          } else {
            // Portal didn't have it or failed — fall back to local DB
            console.log('[Kiosk] Portal miss/fail — falling back to local DB');
            finishLookup(localDbLookup(normalized, raw));
          }
        });
      });
    }

    tryPortalThenLocal();
  }

  function clearLookupMsg() {
    lookupMsg.textContent = '';
    lookupMsg.className = 'validation-msg';
  }

  function showLoadingAndConnect(url) {
    // Fresh connection from config — reset troubleshoot to boot context
    setTroubleshootContext('boot');
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    if (configDialog) configDialog.classList.add('loading-state');
    if (configLoading) configLoading.classList.remove('hidden');

    loadingTimer = setTimeout(function () {
      loadingTimer = null;
      navigateToUrl(url);
      configOverlay.classList.add('hidden');
      resetLoadingState();
    }, 1200);
  }

  function resetLoadingState() {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    if (configDialog) configDialog.classList.remove('loading-state');
    if (configLoading) configLoading.classList.add('hidden');
    clearValidation();
    clearLookupMsg();
  }

  // ============================================================
  // Wake Lock
  // ============================================================

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  function setupWakeLock() {
    if (!('wakeLock' in navigator)) return;
    requestWakeLock();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !wakeLock) {
        requestWakeLock();
      }
    });
  }

  // ============================================================
  // Theme Toggle
  // ============================================================

  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    if (current === 'light') {
      document.documentElement.removeAttribute('data-theme');
      storageSet(THEME_KEY, 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      storageSet(THEME_KEY, 'light');
    }
  }

  function showPageThemeToggle() {
    if (pageThemeToggle) pageThemeToggle.classList.remove('hidden');
    if (pageCopyright) pageCopyright.classList.remove('hidden');
  }

  function hidePageThemeToggle() {
    if (pageThemeToggle) pageThemeToggle.classList.add('hidden');
    if (pageCopyright) pageCopyright.classList.add('hidden');
  }

  // ============================================================
  // URL Normalization & Validation
  // ============================================================

  function normalizeUrl(input) {
    var trimmed = (input || '').trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = 'http://' + trimmed;
    }
    return trimmed;
  }

  function validateUrl(urlString) {
    try {
      var url = new URL(urlString);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { valid: false, error: 'URL must use http:// or https://' };
      }
      if (url.hostname === 'flyone-g.com' || url.hostname === 'www.flyone-g.com') {
        return { valid: true, url: url.href };
      }
      // Allow any IP:port in 192.168.103.0/24 (home/test lab range)
      var isTestSubnet = /^192\.168\.103\.\d{1,3}$/.test(url.hostname);
      if (isTestSubnet) {
        return { valid: true, url: url.href };
      }
      var isPrivateIp = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(url.hostname);
      if (isPrivateIp && url.port === '3100') {
        return { valid: true, url: url.href };
      }
      if (url.hostname === 'localhost' && url.port === '3100') {
        return { valid: true, url: url.href };
      }
      return { valid: false, error: 'Only valid one-G IOS addresses and flyone-g.com are allowed' };
    } catch (e) {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  // ============================================================
  // URL Persistence
  // ============================================================

  function getSavedUrl() {
    return localStorage.getItem(STORAGE_KEY) || null;
  }

  function saveUrl(url) {
    storageSet(STORAGE_KEY, url);
    currentUrl = url;
    updateCurrentUrlDisplay(url);
  }

  function clearSavedUrl() {
    storageRemove(STORAGE_KEY);
    currentUrl = null;
    cancelRetry();
    updateCurrentUrlDisplay(null);
  }

  // ============================================================
  // Navigation & Connection Management
  //
  // Instead of loading the IOS in an iframe (which would be
  // blocked by mixed-content restrictions on this HTTPS page),
  // we probe the URL via the extension proxy, then navigate
  // the entire page to the HTTP IOS URL. Top-level navigation
  // from HTTPS to HTTP is allowed by browsers.
  // ============================================================

  function navigateToUrl(url) {
    cancelRetry();
    dismissTroubleshootPanel();
    showBanner('connecting', 'Connecting to one-G Instructor Operator Station...');
    connectionStatus.onclick = function () {
      cancelRetry();
      showConfigOverlay();
    };
    if (bgLogo) bgLogo.classList.remove('hidden');
    showPageThemeToggle();

    if (!extensionAvailable) {
      // Without the extension we can't probe HTTP from this HTTPS page
      // (mixed content blocks it). Navigate directly with two safety nets:
      //
      //   1. Dead man's switch — if we're still on this page after
      //      NAV_TIMEOUT_MS, the server is timing out. Call window.stop()
      //      to cancel the pending navigation and enter failure flow.
      //
      //   2. Recovery breadcrumb — if the server instantly refuses the
      //      connection, Chrome replaces us with an error page before
      //      the timeout fires. The breadcrumb persists in localStorage
      //      so the next time this kiosk page loads, we detect it and
      //      go straight to the failure/retry flow.
      console.log('[Kiosk] No extension — navigating directly to ' + url);
      setRecoveryBreadcrumb(url);

      if (navTimeoutTimer) { clearTimeout(navTimeoutTimer); navTimeoutTimer = null; }
      if (successTimer) clearTimeout(successTimer);
      successTimer = setTimeout(function () {
        // Top-level HTTPS→HTTP navigation is allowed by browsers.
        window.location.href = url;

        // Dead man's switch: if we're still here after the timeout,
        // the server isn't responding. Abort and show failure UI.
        navTimeoutTimer = setTimeout(function () {
          window.stop();
          clearRecoveryBreadcrumb();
          console.log('[Kiosk] Navigation timed out for ' + url);
          handleConnectionFailure(url, { message: 'Connection timed out' });
        }, NAV_TIMEOUT_MS);
      }, 800);
      return;
    }

    proxyFetch(url, PROBE_TIMEOUT_MS, function (response) {
      if (response && response.ok) {
        handleConnectionSuccess(url);
      } else {
        var err = { message: response ? response.error : 'Unknown error' };
        console.error('[Kiosk] Probe failed for ' + url + ':', err.message);
        handleConnectionFailure(url, err);
      }
    });
  }

  function handleConnectionSuccess(url) {
    stopCountdown();

    // Keep the one-G logo + loading dots visible during success banner
    if (bgLogo) bgLogo.classList.remove('hidden');
    hidePageThemeToggle();

    showBanner('success', 'Connected \u2014 Launching one-G Instructor Operator Station...');

    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(function () {
      // Navigate the entire page to the HTTP IOS URL.
      // Top-level navigation from HTTPS to HTTP is allowed.
      window.location.href = url;
    }, SUCCESS_BANNER_MS);
  }

  function handleConnectionFailure(url, err) {
    if (bgLogo) bgLogo.classList.add('hidden');
    var msg = (currentTroubleshootContext === 'watchdog' || currentTroubleshootContext === 'nav_error')
      ? 'Connection lost \u2014 tap for troubleshooting steps'
      : 'Connection failed \u2014 tap for troubleshooting steps';
    showBanner('error', msg);
    connectionStatus.onclick = function () {
      showTroubleshootPanel();
    };
    startCountdown(url);
  }

  function onPageClickDuringCountdown() {
    showTroubleshootPanel();
  }

  function onRingClickRetryNow(e) {
    e.stopPropagation();
    var url = countdownRetryUrl;
    if (url) {
      stopCountdown();
      navigateToUrl(url);
    }
  }

  function startCountdown(url) {
    stopCountdown();
    countdownRetryUrl = url;
    var totalSeconds = RETRY_COOLDOWN_S;
    var remaining = totalSeconds;

    if (countdownOverlay) {
      countdownOverlay.classList.remove('hidden');
      countdownOverlay.style.pointerEvents = 'auto';
      countdownOverlay.addEventListener('click', onPageClickDuringCountdown);
    }

    if (countdownRingWrap) {
      countdownRingWrap.addEventListener('click', onRingClickRetryNow);
    }

    if (countdownSecondsEl) countdownSecondsEl.textContent = remaining;

    if (countdownRingProgress) {
      countdownRingProgress.style.transition = 'none';
      countdownRingProgress.setAttribute('stroke-dashoffset', '0');
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (countdownRingProgress) {
          countdownRingProgress.style.transition = 'stroke-dashoffset ' + totalSeconds + 's linear';
          countdownRingProgress.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
        }
      });
    });

    countdownInterval = setInterval(function () {
      remaining--;
      if (countdownSecondsEl) countdownSecondsEl.textContent = Math.max(remaining, 0);
      if (remaining <= 0) {
        stopCountdown();
        navigateToUrl(url);
      }
    }, 1000);
  }

  function stopCountdown() {
    if (countdownOverlay) {
      countdownOverlay.removeEventListener('click', onPageClickDuringCountdown);
      countdownOverlay.style.pointerEvents = '';
      countdownOverlay.classList.add('hidden');
    }
    if (countdownRingWrap) {
      countdownRingWrap.removeEventListener('click', onRingClickRetryNow);
    }
    countdownRetryUrl = null;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function cancelRetry() {
    stopCountdown();
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    if (navTimeoutTimer) {
      clearTimeout(navTimeoutTimer);
      navTimeoutTimer = null;
    }

  }

  // ============================================================
  // Banner UI
  // ============================================================

  function showBanner(type, message) {
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    statusMessage.textContent = message;
    connectionStatus.className = 'banner';
    connectionStatus.onclick = null;

    if (type === 'success') {
      connectionStatus.classList.add('banner-success');
    } else if (type === 'error') {
      connectionStatus.classList.add('banner-error');
    }
  }

  function hideBanner() {
    connectionStatus.className = 'banner hidden';
    connectionStatus.onclick = null;
  }

  // ============================================================
  // Troubleshooting Panel
  // ============================================================

  /**
   * Switch troubleshoot panel content based on recovery context.
   * 'watchdog' or 'nav_error' = IOS was running and dropped mid-session.
   * 'boot' (or any other value) = IOS never reached on initial connect.
   */
  function setTroubleshootContext(type) {
    currentTroubleshootContext = type;
    if (!troubleshootBoot || !troubleshootWatchdog) return;
    if (type === 'watchdog' || type === 'nav_error') {
      troubleshootBoot.classList.add('hidden');
      troubleshootWatchdog.classList.remove('hidden');
    } else {
      troubleshootBoot.classList.remove('hidden');
      troubleshootWatchdog.classList.add('hidden');
    }
  }

  function showTroubleshootPanel() {
    stopCountdown();
    hidePageThemeToggle();
    troubleshootPanel.classList.remove('hidden');
  }

  function dismissTroubleshootPanel() {
    troubleshootPanel.classList.add('hidden');
  }

  function hideTroubleshootPanel() {
    var wasVisible = !troubleshootPanel.classList.contains('hidden');
    troubleshootPanel.classList.add('hidden');
    if (wasVisible && currentUrl) {
  
      navigateToUrl(currentUrl);
    }
  }

  // ============================================================
  // Config Overlay
  // ============================================================

  function showConfigOverlay() {
    resetLoadingState();
    cancelRetry();
    dismissTroubleshootPanel();
    hidePageThemeToggle();
    hideBanner();
    if (bgLogo) bgLogo.classList.add('hidden');
    addrInput.value = currentUrl || '';
    tailInput.value = '';
    manualSection.classList.add('hidden');
    btnManualToggle.classList.remove('expanded');
    configOverlay.classList.remove('hidden');
    clearValidation();
    clearLookupMsg();

    btnClose.style.display = currentUrl ? '' : 'none';

    setTimeout(function () {
      tailInput.focus();
    }, 100);
  }

  function hideConfigOverlay() {
    if (!currentUrl) return;
    configOverlay.classList.add('hidden');
    clearValidation();

    navigateToUrl(currentUrl);
  }

  function toggleConfigOverlay() {
    if (configOverlay.classList.contains('hidden')) {
      showConfigOverlay();
    } else {
      hideConfigOverlay();
    }
  }

  function clearValidation() {
    validationMsg.textContent = '';
    validationMsg.className = 'validation-msg';
  }

  function showValidation(message, type) {
    validationMsg.textContent = message;
    validationMsg.className = 'validation-msg ' + type;
  }

  function updateCurrentUrlDisplay(url) {
    currentUrlDisplay.textContent = url || 'Not configured';
  }

  function updatePortalStatus(connected) {
    if (!portalStatus) return;
    if (connected === null) {
      portalStatus.textContent = 'Authenticating...';
      portalStatus.className = 'portal-status portal-pending';
    } else if (connected) {
      portalStatus.textContent = 'Portal OK';
      portalStatus.className = 'portal-status portal-ok';
    } else {
      portalStatus.textContent = 'Portal offline';
      portalStatus.className = 'portal-status portal-off';
    }
  }

  // ============================================================
  // Hotkey: Ctrl+Shift+O
  // ============================================================

  function setupHotkey() {
    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      if (e.ctrlKey && (e.shiftKey || e.altKey) && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        toggleConfigOverlay();
      }
      if (e.key === 'Escape') {
        if (!troubleshootPanel.classList.contains('hidden')) {
          e.preventDefault();
          hideTroubleshootPanel();
        } else if (!configOverlay.classList.contains('hidden')) {
          e.preventDefault();
          hideConfigOverlay();
        }
      }
    });
  }

  // ============================================================
  // Network Diagnostics
  // ============================================================

  function closeDiagnostics() {
    if (diagResults) {
      diagResults.classList.add('hidden');
    }
  }

  function toggleDiagnostics() {
    if (!diagResults) return;
    if (!diagResults.classList.contains('hidden')) {
      closeDiagnostics();
      return;
    }
    runDiagnostics();
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function runDiagnostics() {
    if (!diagResults) return;
    diagResults.classList.remove('hidden');
    diagResults.innerHTML = '<span class="diag-info">Running diagnostics...</span>\n';

    var lines = [];
    lines.push('<span class="diag-info">Page origin: ' + escHtml(location.origin) + '</span>');
    lines.push('<span class="diag-info">Protocol: ' + escHtml(location.protocol) + '</span>');
    lines.push('<span class="diag-info">Extension: ' + (extensionAvailable ? 'yes (v' + escHtml(extensionVersion) + ') via ' + (useDirectChannel ? 'direct' : 'bridge') : 'NO \u2014 HTTP probing disabled') + '</span>');
    lines.push('<span class="diag-info">chrome.runtime available: ' + (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage ? 'yes' : 'no') + '</span>');
    lines.push('<span class="diag-info">App version: v' + escHtml(APP_VERSION) + '</span>');
    lines.push('<span class="diag-info">Portal: ' + (portalToken ? 'authenticated' : 'not connected') + '</span>');
    lines.push('<span class="diag-info">Configured URL: ' + escHtml(currentUrl || 'none') + '</span>');
    lines.push('');

    var tests = [];

    tests.push({
      label: 'HTTPS fetch (devices.enc)',
      run: function (cb) {
        var controller = new AbortController();
        var t = setTimeout(function () { controller.abort(); }, 5000);
        fetch(DEVICES_ENC_URL, { signal: controller.signal })
          .then(function (r) { clearTimeout(t); cb('PASS', 'status=' + r.status); })
          .catch(function (e) { clearTimeout(t); cb('FAIL', e.message); });
      }
    });

    tests.push({
      label: 'Extension proxy ping',
      run: function (cb) {
        if (!extensionAvailable) {
          cb('FAIL', 'Extension not connected');
          return;
        }
        sendToExtension({ type: 'ping' }, function (resp) {
          if (resp && resp.ok) {
            cb('PASS', 'v' + (resp.version || '?'));
          } else {
            cb('FAIL', resp ? resp.error : 'No response');
          }
        });
      }
    });

    if (currentUrl) {
      tests.push({
        label: 'IOS via extension (' + currentUrl + ')',
        run: function (cb) {
          if (!extensionAvailable) {
            cb('FAIL', 'Extension not connected');
            return;
          }
          proxyFetch(currentUrl, 8000, function (resp) {
            if (resp && resp.ok) {
              cb('PASS', 'type=' + resp.type + ' status=' + resp.status);
            } else {
              cb('FAIL', resp ? resp.error : 'No response');
            }
          });
        }
      });

      tests.push({
        label: 'IOS direct fetch (' + currentUrl + ')',
        run: function (cb) {
          var controller = new AbortController();
          var t = setTimeout(function () { controller.abort(); }, 8000);
          fetch(currentUrl, { mode: 'no-cors', signal: controller.signal })
            .then(function (r) { clearTimeout(t); cb('PASS', 'type=' + r.type); })
            .catch(function (e) { clearTimeout(t); cb('FAIL', e.message); });
        }
      });
    }

    var remaining = tests.length;
    diagResults.innerHTML = lines.join('\n') + '\n<span class="diag-info">Running ' + remaining + ' tests...</span>';

    tests.forEach(function (test) {
      test.run(function (status, detail) {
        var cls = status === 'PASS' ? 'diag-pass' : 'diag-fail';
        lines.push('<span class="' + cls + '">' + escHtml(status) + '</span> ' + escHtml(test.label) + ' \u2192 ' + escHtml(detail));
        remaining--;
        if (remaining === 0) {
          lines.push('');
          lines.push('<span class="diag-info">Tests complete.</span>');
          diagResults.innerHTML = lines.join('\n');
        }
      });
    });
  }

  // ============================================================
  // Button Handlers
  // ============================================================

  function setupButtons() {
    btnSave.addEventListener('click', handleSave);
    btnClear.addEventListener('click', handleClear);
    btnClose.addEventListener('click', function () { hideConfigOverlay(); });

    if (btnDiag) {
      btnDiag.addEventListener('click', toggleDiagnostics);
    }

    // Easter egg: tap version number 7 times to reveal dev tools
    if (versionDisplay) {
      var devTapCount = 0;
      var devTapTimer = null;
      versionDisplay.addEventListener('click', function () {
        devTapCount++;
        if (!devTapTimer) {
          var footer = versionDisplay.closest('.config-footer');
          var isDevMode = footer && footer.classList.contains('dev-mode');
          var window_ms = isDevMode ? 5000 : 2000;
          devTapTimer = setTimeout(function () { devTapCount = 0; devTapTimer = null; }, window_ms);
        }
        if (devTapCount >= 7) {
          devTapCount = 0;
          if (devTapTimer) { clearTimeout(devTapTimer); devTapTimer = null; }
          var footer = versionDisplay.closest('.config-footer');
          if (footer) {
            var wasDevMode = footer.classList.contains('dev-mode');
            footer.classList.toggle('dev-mode');
            // Hide diag panel when leaving dev mode
            if (wasDevMode) closeDiagnostics();
          }
        }
      });
    }

    btnTheme.addEventListener('click', toggleTheme);

    if (btnInfo) {
      btnInfo.addEventListener('click', function () {
        if (infoPanel) infoPanel.classList.remove('hidden');
      });
    }
    if (btnInfoClose) {
      btnInfoClose.addEventListener('click', function () {
        if (infoPanel) infoPanel.classList.add('hidden');
      });
    }
    if (infoPanel) {
      infoPanel.addEventListener('click', function (e) {
        if (e.target === infoPanel) infoPanel.classList.add('hidden');
      });
    }

    if (pageThemeToggle) {
      pageThemeToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTheme();
      });
    }

    configOverlay.addEventListener('click', function (e) {
      if (e.target === configOverlay) hideConfigOverlay();
    });

    troubleshootPanel.addEventListener('click', function (e) {
      if (e.target === troubleshootPanel) hideTroubleshootPanel();
    });

    btnRetry.addEventListener('click', function () { hideTroubleshootPanel(); });
    btnTroubleshootClose.addEventListener('click', function () { hideTroubleshootPanel(); });

    btnOpenConfig.addEventListener('click', function (e) {
      e.preventDefault();
      dismissTroubleshootPanel();
      showConfigOverlay();
    });

    if (countdownTroubleshootLink) {
      countdownTroubleshootLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showTroubleshootPanel();
      });
    }

    btnManualToggle.addEventListener('click', function () {
      var isHidden = manualSection.classList.contains('hidden');
      if (isHidden) {
        manualSection.classList.remove('hidden');
        btnManualToggle.classList.add('expanded');
        addrInput.focus();
      } else {
        manualSection.classList.add('hidden');
        btnManualToggle.classList.remove('expanded');
      }
    });

    btnLookup.addEventListener('click', handleLookup);
    tailInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); handleLookup(); }
    });
    addrInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
    });
  }

  function handleSave() {
    var raw = addrInput.value;
    var normalized = normalizeUrl(raw);

    if (!normalized) {
      showValidation('Please enter a URL.', 'error');
      return;
    }

    var result = validateUrl(normalized);
    if (!result.valid) {
      showValidation(result.error, 'error');
      return;
    }

    closeDiagnostics();
    saveUrl(result.url);
    showLoadingAndConnect(result.url);
  }

  function handleClear() {
    if (confirm('Clear saved URL? The kiosk will return to the configuration screen.')) {
      clearSavedUrl();
      showConfigOverlay();
    }
  }

  // ============================================================
  // Entry Point
  // ============================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ---- Back-button / bfcache recovery ----
  // When the user navigates back from the IOS page, Chrome may restore
  // this page from the back-forward cache with stale JS state (e.g. the
  // green "Connected" banner stuck with no timer running). Detect this
  // and re-trigger the connection flow.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted && currentUrl) {
      console.log('[Kiosk] Page restored from bfcache — re-connecting to ' + currentUrl);
      navigateToUrl(currentUrl);
    }
  });

})();
