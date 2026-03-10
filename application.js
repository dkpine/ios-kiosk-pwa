/* ============================================================
   Instructor Station Kiosk - PWA Config Shell
   Core application logic
   ============================================================ */

(function () {
  'use strict';

  // ---- Constants ----

  var STORAGE_KEY = 'ios_addr';
  var DEFAULT_URL = 'https://flyone-g.com';
  var RETRY_INITIAL_MS = 5000;
  var RETRY_BACKOFF = 1.5;
  var RETRY_MAX_MS = 30000;
  var PROBE_TIMEOUT_MS = 8000;
  var APP_VERSION = '1.0';

  // ---- DOM References ----

  var iframe = document.getElementById('ios-frame');
  var configOverlay = document.getElementById('config-overlay');
  var connectionStatus = document.getElementById('connection-status');
  var statusMessage = document.getElementById('status-message');
  var addrInput = document.getElementById('ios-addr-input');
  var validationMsg = document.getElementById('validation-msg');
  var currentUrlDisplay = document.getElementById('current-url-display');
  var btnSave = document.getElementById('btn-save');
  var btnClear = document.getElementById('btn-clear');
  var btnClose = document.getElementById('btn-close');
  var versionDisplay = document.getElementById('version-display');

  // ---- State ----

  var currentUrl = null;
  var retryTimer = null;
  var retryCount = 0;
  var wakeLock = null;

  // ============================================================
  // Initialization
  // ============================================================

  function init() {
    if (versionDisplay) {
      versionDisplay.textContent = 'v' + APP_VERSION;
    }
    registerServiceWorker();
    requestWakeLock();
    setupHotkey();
    setupButtons();
    setupScreenshotListener();
    boot();
  }

  // ============================================================
  // Service Worker Registration
  // ============================================================

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('[Kiosk] Service worker registration failed:', err);
      });
    }
  }

  // ============================================================
  // Wake Lock (replaces chrome.power.requestKeepAwake)
  // ============================================================

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.warn('[Kiosk] WakeLock API not available');
      return;
    }

    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      wakeLock.addEventListener('release', function () {
        wakeLock = null;
      });
    }).catch(function (err) {
      console.warn('[Kiosk] WakeLock request failed:', err);
    });

    // Re-acquire when page becomes visible again
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !wakeLock) {
        requestWakeLock();
      }
    });
  }

  // ============================================================
  // URL Normalization & Validation
  // ============================================================

  function normalizeUrl(input) {
    var trimmed = (input || '').trim();
    if (!trimmed) return null;

    // Auto-prepend http:// if no scheme provided
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
      return { valid: true, url: url.href };
    } catch (e) {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  // ============================================================
  // URL Persistence (localStorage)
  // ============================================================

  function getSavedUrl() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function saveUrl(url) {
    localStorage.setItem(STORAGE_KEY, url);
    currentUrl = url;
    updateCurrentUrlDisplay(url);
  }

  function clearSavedUrl() {
    localStorage.removeItem(STORAGE_KEY);
    currentUrl = null;
    iframe.src = 'about:blank';
    iframe.classList.remove('active');
    cancelRetry();
    updateCurrentUrlDisplay(null);
  }

  // ============================================================
  // Boot Sequence
  // ============================================================

  function boot() {
    var saved = getSavedUrl();
    if (saved) {
      var normalized = normalizeUrl(saved);
      if (normalized) {
        currentUrl = normalized;
        updateCurrentUrlDisplay(normalized);
        navigateToUrl(normalized);
        return;
      }
    }
    // No saved URL or invalid -- show config
    showConfigOverlay();
  }

  // ============================================================
  // Iframe Navigation & Connection Management
  // ============================================================

  function navigateToUrl(url) {
    cancelRetry();
    showConnectionStatus('Connecting to Instructor Station...');

    iframe.classList.add('active');

    // Fallback timeout: if onload doesn't fire, the server is likely unreachable.
    // Cross-origin iframes won't fire onerror for HTTP failures, so we use a timeout.
    var loadTimeout = setTimeout(function () {
      if (!connectionStatus.classList.contains('hidden')) {
        handleConnectionFailure(url);
      }
    }, PROBE_TIMEOUT_MS);

    // Set up load handler before setting src
    iframe.onload = function () {
      clearTimeout(loadTimeout);
      hideConnectionStatus();
      retryCount = 0;
    };

    iframe.src = url;
  }

  function handleConnectionFailure(url) {
    retryCount++;
    var interval = Math.min(
      RETRY_INITIAL_MS * Math.pow(RETRY_BACKOFF, retryCount - 1),
      RETRY_MAX_MS
    );
    var seconds = Math.ceil(interval / 1000);

    showConnectionStatus(
      'Unable to reach Instructor Station. Retrying in ' + seconds + 's... (attempt ' + retryCount + ')'
    );

    retryTimer = setTimeout(function () {
      navigateToUrl(url);
    }, interval);
  }

  function cancelRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
  }

  // ============================================================
  // Connection Status UI
  // ============================================================

  function showConnectionStatus(message) {
    statusMessage.textContent = message;
    connectionStatus.classList.remove('hidden');
  }

  function hideConnectionStatus() {
    connectionStatus.classList.add('hidden');
  }

  // ============================================================
  // Config Overlay
  // ============================================================

  function showConfigOverlay() {
    addrInput.value = currentUrl || '';
    configOverlay.classList.remove('hidden');
    clearValidation();
    setTimeout(function () {
      addrInput.focus();
    }, 100);
  }

  function hideConfigOverlay() {
    // Only allow closing if a URL is configured
    if (!currentUrl) return;
    configOverlay.classList.add('hidden');
    clearValidation();
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

  // ============================================================
  // Hotkey: Ctrl+Shift+O
  // ============================================================

  function setupHotkey() {
    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        toggleConfigOverlay();
      }
    });
  }

  // ============================================================
  // Button Handlers
  // ============================================================

  function setupButtons() {
    btnSave.addEventListener('click', handleSave);
    btnClear.addEventListener('click', handleClear);
    btnClose.addEventListener('click', function () {
      hideConfigOverlay();
    });

    // Enter key in input triggers save
    addrInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
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

    saveUrl(result.url);
    showValidation('Saved! Connecting...', 'success');

    setTimeout(function () {
      navigateToUrl(result.url);
      configOverlay.classList.add('hidden');
      clearValidation();
    }, 400);
  }

  function handleClear() {
    if (confirm('Clear saved URL? The kiosk will return to the configuration screen.')) {
      clearSavedUrl();
      showConfigOverlay();
    }
  }

  // ============================================================
  // Screenshot / Print Support (replaces chrome.runtime messaging)
  //
  // The legacy Chrome App received screenshot requests via
  // chrome.runtime.onMessageExternal from localhost:3100 / ios:3100.
  //
  // In the PWA, external systems can use window.postMessage to send
  // requests to this window. The instructor station server code
  // would need to be updated to use postMessage instead of
  // chrome.runtime.sendMessage.
  //
  // Expected message format:
  //   { name: 'screenshot' }
  //   { name: 'print' }
  // ============================================================

  function setupScreenshotListener() {
    window.addEventListener('message', function (event) {
      // Only handle messages with expected structure
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.name === 'screenshot' || event.data.name === 'print') {
        try {
          iframe.contentWindow.print();
        } catch (e) {
          // Cross-origin print may fail; fall back to window print
          window.print();
        }
      }
    });
  }

  // ============================================================
  // Entry Point
  // ============================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
