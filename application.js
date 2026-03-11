/* ============================================================
   Instructor Station Kiosk - PWA Config Shell
   Core application logic — v1.01
   ============================================================ */

(function () {
  'use strict';

  // ---- Constants ----

  var STORAGE_KEY = 'ios_addr';
  var THEME_KEY = 'ios_theme';
  var DEFAULT_URL = 'https://flyone-g.com';
  var PROBE_TIMEOUT_MS = 8000;
  var SUCCESS_BANNER_MS = 3000;
  // Countdown retry schedule (seconds): 10s, 30s, 60s, then 60s forever
  var COUNTDOWN_SCHEDULE = [10, 30, 60];
  var RING_CIRCUMFERENCE = 2 * Math.PI * 52; // ~326.73, matches SVG r=52
  var APP_VERSION = '1.09';

  // ---- DOM References ----

  var iframe = document.getElementById('ios-frame');
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

  // ---- State ----

  var deviceDb = null; // loaded from devices.json
  var currentUrl = null;
  var retryTimer = null;
  var countdownInterval = null;
  var retryCount = 0;
  var successTimer = null;
  var wakeLock = null;
  var countdownRetryUrl = null;

  // ============================================================
  // Initialization
  // ============================================================

  function init() {
    if (versionDisplay) {
      versionDisplay.textContent = 'v' + APP_VERSION;
    }
    initTheme();
    loadDeviceDb();
    registerServiceWorker();
    requestWakeLock();
    setupHotkey();
    setupButtons();
    setupScreenshotListener();
    boot();
  }

  // ============================================================
  // Device Database (tail number → URL lookup)
  // ============================================================

  function loadDeviceDb() {
    fetch('./devices.json')
      .then(function (res) { return res.json(); })
      .then(function (data) { deviceDb = data; })
      .catch(function () { deviceDb = null; });
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

    if (!deviceDb) {
      lookupMsg.textContent = 'Device database not loaded. Try again in a moment.';
      lookupMsg.className = 'validation-msg error';
      return;
    }

    // Try exact match first, then with 'N' prefix for numeric-leading entries
    var url = deviceDb[raw];
    if (!url && /^[0-9]/.test(raw)) {
      url = deviceDb['N' + raw];
    }
    if (!url) {
      lookupMsg.textContent = 'Tail number not found. Please verify and try again.';
      lookupMsg.className = 'validation-msg error';
      return;
    }

    // Found — save and transition to loading spinner
    addrInput.value = url;
    saveUrl(url);
    showLoadingAndConnect(url);
  }

  function clearLookupMsg() {
    lookupMsg.textContent = '';
    lookupMsg.className = 'validation-msg';
  }

  // Shared loading transition: replaces config UI with spinner, then navigates
  function showLoadingAndConnect(url) {
    // Switch dialog to loading state (CSS hides header/body/footer, shrinks dialog)
    if (configDialog) configDialog.classList.add('loading-state');
    if (configLoading) configLoading.classList.remove('hidden');

    // After the CSS transition + a brief pause, navigate and dismiss
    setTimeout(function () {
      navigateToUrl(url);
      configOverlay.classList.add('hidden');
      resetLoadingState();
    }, 1200);
  }

  function resetLoadingState() {
    if (configDialog) configDialog.classList.remove('loading-state');
    if (configLoading) configLoading.classList.add('hidden');
    clearValidation();
    clearLookupMsg();
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
  // Theme Toggle
  // ============================================================

  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      // Default is light
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    if (current === 'light') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(THEME_KEY, 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem(THEME_KEY, 'light');
    }
  }

  function showPageThemeToggle() {
    if (pageThemeToggle) pageThemeToggle.classList.remove('hidden');
  }

  function hidePageThemeToggle() {
    if (pageThemeToggle) pageThemeToggle.classList.add('hidden');
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
    hideTroubleshootPanel();
    showBanner('connecting', 'Connecting to Instructor Station...');
    if (bgLogo) bgLogo.classList.remove('hidden');
    showPageThemeToggle();

    // Clear any previously loaded page so it doesn't show through
    iframe.src = 'about:blank';
    iframe.classList.add('active');

    // Probe the URL with fetch first. The iframe onload event fires even
    // for Chrome's "refused to connect" error page, so we can't rely on
    // it alone. A no-cors fetch will throw a TypeError on network failure
    // but succeed (with an opaque response) if the server is reachable.
    var controller = new AbortController();
    var probeTimeout = setTimeout(function () {
      controller.abort();
    }, PROBE_TIMEOUT_MS);

    fetch(url, { mode: 'no-cors', signal: controller.signal })
      .then(function () {
        // Server responded — load in iframe
        clearTimeout(probeTimeout);

        // The first onload after setting iframe.src is our initial load.
        // We already proved the server is reachable via the fetch probe,
        // so treat this as a success immediately.
        //
        // Subsequent iframe navigations (link clicks, form submits inside
        // the loaded page) need a re-probe because the server may have
        // gone down between navigations.
        var isFirstLoad = true;

        iframe.onload = function () {
          if (isFirstLoad) {
            isFirstLoad = false;
            handleConnectionSuccess();
            return;
          }

          // Re-probe on subsequent navigations within the iframe
          var navController = new AbortController();
          var navTimeout = setTimeout(function () {
            navController.abort();
          }, PROBE_TIMEOUT_MS);

          fetch(currentUrl, { mode: 'no-cors', signal: navController.signal })
            .then(function () {
              clearTimeout(navTimeout);
              handleConnectionSuccess();
            })
            .catch(function () {
              clearTimeout(navTimeout);
              handleConnectionFailure(currentUrl);
            });
        };

        iframe.src = url;
      })
      .catch(function () {
        // Network error or timeout — server unreachable
        clearTimeout(probeTimeout);
        handleConnectionFailure(url);
      });
  }

  function handleConnectionSuccess() {
    stopCountdown();
    retryCount = 0;
    if (bgLogo) bgLogo.classList.add('hidden');
    hidePageThemeToggle();

    // Show green success banner
    showBanner('success', 'Connected to Instructor Station');

    // Slide it away after a few seconds
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(function () {
      connectionStatus.classList.add('banner-slide-out');
      // After the CSS transition finishes, hide completely
      setTimeout(function () {
        hideBanner();
      }, 450);
    }, SUCCESS_BANNER_MS);
  }

  function handleConnectionFailure(url) {
    if (bgLogo) bgLogo.classList.add('hidden');
    // Show static banner — countdown ring handles the visual timer
    showBanner('error', 'Connection failed \u2014 tap for troubleshooting steps');
    connectionStatus.onclick = function () {
      showTroubleshootPanel();
    };
    startCountdown(url);
  }

  function getCountdownDuration() {
    var index = Math.min(retryCount, COUNTDOWN_SCHEDULE.length - 1);
    return COUNTDOWN_SCHEDULE[index];
  }

  // Named handler so we can add/remove it cleanly
  function onPageClickDuringCountdown() {
    showTroubleshootPanel();
  }

  function onRingClickRetryNow(e) {
    e.stopPropagation(); // Don't trigger troubleshoot panel
    var url = countdownRetryUrl; // save before stopCountdown nulls it
    if (url) {
      stopCountdown();
      retryCount++;
      navigateToUrl(url);
    }
  }

  function startCountdown(url) {
    stopCountdown();
    countdownRetryUrl = url;
    var totalSeconds = getCountdownDuration();
    var remaining = totalSeconds;

    // Show the centered countdown overlay and make it intercept all clicks
    // (the iframe at z-index 1 would eat clicks otherwise)
    if (countdownOverlay) {
      countdownOverlay.classList.remove('hidden');
      countdownOverlay.style.pointerEvents = 'auto';
      countdownOverlay.addEventListener('click', onPageClickDuringCountdown);
    }

    // Ring click = immediate retry
    if (countdownRingWrap) {
      countdownRingWrap.addEventListener('click', onRingClickRetryNow);
    }

    // Set initial number
    if (countdownSecondsEl) countdownSecondsEl.textContent = remaining;

    // Reset ring to full, then animate to empty
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
        retryCount++;
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
    retryCount = 0;
  }

  // ============================================================
  // Banner UI (amber = connecting, green = success, red = error)
  // ============================================================

  function showBanner(type, message) {
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    statusMessage.textContent = message;
    connectionStatus.className = 'banner'; // reset all modifier classes
    connectionStatus.onclick = null;

    if (type === 'success') {
      connectionStatus.classList.add('banner-success');
    } else if (type === 'error') {
      connectionStatus.classList.add('banner-error');
    }
    // 'connecting' uses the default amber style (no modifier class needed)
  }

  function hideBanner() {
    connectionStatus.className = 'banner hidden';
    connectionStatus.onclick = null;
  }

  // ============================================================
  // Troubleshooting Panel
  // ============================================================

  function showTroubleshootPanel() {
    // Pause the countdown while viewing troubleshooting steps
    stopCountdown();
    hidePageThemeToggle();
    troubleshootPanel.classList.remove('hidden');
  }

  function hideTroubleshootPanel() {
    // Only trigger reconnection if the panel was actually visible
    var wasVisible = !troubleshootPanel.classList.contains('hidden');
    troubleshootPanel.classList.add('hidden');

    if (wasVisible && currentUrl) {
      retryCount = 0;
      navigateToUrl(currentUrl);
    }
  }

  // ============================================================
  // Config Overlay
  // ============================================================

  function showConfigOverlay() {
    resetLoadingState();
    cancelRetry();
    hidePageThemeToggle();
    // Clear any loaded page — config is a fresh-start context
    iframe.src = 'about:blank';
    iframe.classList.remove('active');
    hideBanner();
    if (bgLogo) bgLogo.classList.add('hidden');
    addrInput.value = currentUrl || '';
    tailInput.value = '';
    manualSection.classList.add('hidden');
    btnManualToggle.classList.remove('expanded');
    configOverlay.classList.remove('hidden');
    clearValidation();
    clearLookupMsg();

    // Only show Close button if a URL is already configured
    btnClose.style.display = currentUrl ? '' : 'none';

    setTimeout(function () {
      tailInput.focus();
    }, 100);
  }

  function hideConfigOverlay() {
    // Only allow closing if a URL is configured
    if (!currentUrl) return;
    configOverlay.classList.add('hidden');
    clearValidation();

    // Re-attempt connection to the IOS whenever the overlay is dismissed
    retryCount = 0;
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
  // Button Handlers
  // ============================================================

  function setupButtons() {
    btnSave.addEventListener('click', handleSave);
    btnClear.addEventListener('click', handleClear);
    btnClose.addEventListener('click', function () {
      hideConfigOverlay();
    });

    // Theme toggle (config dialog)
    btnTheme.addEventListener('click', toggleTheme);

    // Page-level theme toggle (connecting / failed screens)
    if (pageThemeToggle) {
      pageThemeToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTheme();
      });
    }

    // Click outside config dialog to close
    configOverlay.addEventListener('click', function (e) {
      if (e.target === configOverlay) {
        hideConfigOverlay();
      }
    });

    // Click outside troubleshoot dialog to close
    troubleshootPanel.addEventListener('click', function (e) {
      if (e.target === troubleshootPanel) {
        hideTroubleshootPanel();
      }
    });

    // Troubleshooting panel buttons
    btnRetry.addEventListener('click', function () {
      hideTroubleshootPanel();
    });

    btnTroubleshootClose.addEventListener('click', function () {
      hideTroubleshootPanel();
    });

    // Troubleshoot panel → open config link
    btnOpenConfig.addEventListener('click', function (e) {
      e.preventDefault();
      hideTroubleshootPanel();
      showConfigOverlay();
    });

    // Countdown overlay troubleshoot link
    if (countdownTroubleshootLink) {
      countdownTroubleshootLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showTroubleshootPanel();
      });
    }

    // Manual section toggle
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

    // Tail number lookup
    btnLookup.addEventListener('click', handleLookup);
    tailInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLookup();
      }
    });

    // Enter key in manual address input triggers save
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
    showLoadingAndConnect(result.url);
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
