// Kiosk redirect: when loaded from GitHub Pages, redirect to the
// Chrome extension page which runs from a chrome-extension:// origin
// and can load HTTP IOS content without mixed-content blocking.
if (window.location.hostname === 'dkpine.github.io') {
  window.location.replace(
    'chrome-extension://ffcoooniadfdngdceeiopbkdljcgnoha/index.html'
  );
}
