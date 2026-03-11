/* ============================================================
   Instructor Station Kiosk - GitHub Pages App
   Core application logic — v3.0.0

   This runs from the GitHub Pages HTTPS origin. HTTP fetch
   probes to private-IP IOS servers are proxied through the
   companion Chrome extension via externally_connectable
   messaging. Once the IOS is found, the page navigates
   directly to the HTTP URL (top-level navigation is not
   subject to mixed-content blocking).

   devices.json is fetched from the same GitHub Pages origin.
   ============================================================ */

(function () {
  'use strict';

  // ---- Constants ----

  var EXT_ID = 'ffcoooniadfdngdceeiopbkdljcgnoha';
  var STORAGE_KEY = 'ios_addr';
  var THEME_KEY = 'ios_theme';
  var PROBE_TIMEOUT_MS = 8000;
  var SUCCESS_BANNER_MS = 2000;
  var COUNTDOWN_SCHEDULE = [10, 30, 60];
  var RING_CIRCUMFERENCE = 2 * Math.PI * 52;
  var APP_VERSION = '3.0.0';
  var DEVICES_JSON_URL = './devices.json';

  // ---- Extension Communication ----

  var extensionAvailable = false;

  function sendToExtension(message, callback) {
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      if (callback) callback({ ok: false, error: 'chrome.runtime not available' });
      return;
    }
    try {
      chrome.runtime.sendMessage(EXT_ID, message, function (response) {
        if (chrome.runtime.lastError) {
          if (callback) callback({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (callback) callback(response || { ok: false, error: 'No response' });
      });
    } catch (e) {
      if (callback) callback({ ok: false, error: e.message });
    }
  }

  function checkExtension(callback) {
    sendToExtension({ type: 'ping' }, function (response) {
      extensionAvailable = !!(response && response.ok);
      if (callback) callback(extensionAvailable, response);
    });
  }

  function proxyFetch(url, timeout, callback) {
    if (!extensionAvailable) {
      callback({ ok: false, error: 'Extension not available' });
      return;
    }
    sendToExtension({
      type: 'fetch',
      url: url,
      timeout: timeout || PROBE_TIMEOUT_MS
    }, callback);
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

  // ---- State ----

  var deviceDb = null;
  var currentUrl = null;
  var retryTimer = null;
  var countdownInterval = null;
  var retryCount = 0;
  var successTimer = null;
  var wakeLock = null;
  var countdownRetryUrl = null;
  var loadingTimer = null;

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
  // Initialization
  // ============================================================

  function init() {
    if (versionDisplay) {
      versionDisplay.textContent = 'v' + APP_VERSION;
    }

    checkExtension(function (available, response) {
      if (extStatus) {
        if (available) {
          extStatus.textContent = 'Extension v' + (response.version || '?') + ' connected';
          extStatus.className = 'ext-status ext-ok';
        } else {
          extStatus.textContent = 'Extension not detected \u2014 HTTP probing unavailable';
          extStatus.className = 'ext-status ext-missing';
        }
      }

      initTheme();
      setupWakeLock();
      setupHotkey();
      setupButtons();
      loadDeviceDb();

      var savedUrl = localStorage.getItem(STORAGE_KEY);

      if (savedUrl) {
        currentUrl = savedUrl;
        updateCurrentUrlDisplay(savedUrl);
        navigateToUrl(savedUrl);
      } else if (extensionAvailable) {
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
      } else {
        showConfigOverlay();
      }
    });
  }

  // ============================================================
  // Device Database
  // ============================================================

  function loadDeviceDb() {
    fetch(DEVICES_JSON_URL)
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

    var url = deviceDb[raw];
    if (!url && /^[0-9]/.test(raw)) {
      url = deviceDb['N' + raw];
    }
    if (!url) {
      var match = raw.match(/^(N?)(\d+)(.*)$/i);
      if (match) {
        var numPart = match[2];
        var suffix = match[3];
        for (var padLen = numPart.length + 1; !url && padLen <= numPart.length + 2; padLen++) {
          var padded = ('000' + numPart).slice(-padLen);
          url = deviceDb['N' + padded + suffix];
        }
      }
    }
    if (!url) {
      lookupMsg.textContent = 'Tail number not found. Please verify and try again.';
      lookupMsg.className = 'validation-msg error';
      return;
    }

    addrInput.value = url;
    saveUrl(url);
    showLoadingAndConnect(url);
  }

  function clearLookupMsg() {
    lookupMsg.textContent = '';
    lookupMsg.className = 'validation-msg';
  }

  function showLoadingAndConnect(url) {
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
    showBanner('connecting', 'Connecting to Instructor Station...');
    if (bgLogo) bgLogo.classList.remove('hidden');
    showPageThemeToggle();

    if (!extensionAvailable) {
      directProbe(url);
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

  function directProbe(url) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT_MS);

    fetch(url, { mode: 'no-cors', signal: controller.signal })
      .then(function () {
        clearTimeout(timeout);
        handleConnectionSuccess(url);
      })
      .catch(function (err) {
        clearTimeout(timeout);
        console.error('[Kiosk] Direct probe failed for ' + url + ':', err.message);
        handleConnectionFailure(url, err);
      });
  }

  function handleConnectionSuccess(url) {
    stopCountdown();
    retryCount = 0;
    if (bgLogo) bgLogo.classList.add('hidden');
    hidePageThemeToggle();

    showBanner('success', 'Connected \u2014 launching Instructor Station...');

    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(function () {
      // Navigate the entire page to the HTTP IOS URL.
      // Top-level navigation from HTTPS to HTTP is allowed.
      window.location.href = url;
    }, SUCCESS_BANNER_MS);
  }

  function handleConnectionFailure(url, err) {
    if (bgLogo) bgLogo.classList.add('hidden');
    var msg = 'Connection failed';
    if (err && err.message) {
      msg += ' (' + err.message + ')';
    }
    msg += ' \u2014 tap for troubleshooting steps';
    showBanner('error', msg);
    connectionStatus.onclick = function () {
      showTroubleshootPanel();
    };
    startCountdown(url);
  }

  function getCountdownDuration() {
    var index = Math.min(retryCount, COUNTDOWN_SCHEDULE.length - 1);
    return COUNTDOWN_SCHEDULE[index];
  }

  function onPageClickDuringCountdown() {
    showTroubleshootPanel();
  }

  function onRingClickRetryNow(e) {
    e.stopPropagation();
    var url = countdownRetryUrl;
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
  // Network Diagnostics
  // ============================================================

  function runDiagnostics() {
    if (!diagResults) return;
    diagResults.classList.remove('hidden');
    diagResults.innerHTML = '<span class="diag-info">Running diagnostics...</span>\n';

    var lines = [];
    lines.push('<span class="diag-info">Page origin: ' + location.origin + '</span>');
    lines.push('<span class="diag-info">Protocol: ' + location.protocol + '</span>');
    lines.push('<span class="diag-info">Extension: ' + (extensionAvailable ? 'yes' : 'NO \u2014 HTTP probing disabled') + '</span>');
    lines.push('<span class="diag-info">App version: v' + APP_VERSION + '</span>');
    lines.push('<span class="diag-info">Configured URL: ' + (currentUrl || 'none') + '</span>');
    lines.push('');

    var tests = [];

    tests.push({
      label: 'HTTPS fetch (devices.json)',
      run: function (cb) {
        var controller = new AbortController();
        var t = setTimeout(function () { controller.abort(); }, 5000);
        fetch('./devices.json', { signal: controller.signal })
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
        lines.push('<span class="' + cls + '">' + status + '</span> ' + test.label + ' \u2192 ' + detail);
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
      btnDiag.addEventListener('click', runDiagnostics);
    }

    btnTheme.addEventListener('click', toggleTheme);

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

})();
