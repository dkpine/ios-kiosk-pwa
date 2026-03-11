// Detect if the extension iframe failed to load and show fallback
(function() {
  var frame = document.getElementById('ext-frame');
  var fallback = document.getElementById('fallback');
  var timeout = setTimeout(function() {
    // If we reach this timeout, the iframe likely failed to load
    frame.style.display = 'none';
    fallback.style.display = 'flex';
  }, 5000);

  // Try to detect successful load
  frame.addEventListener('load', function() {
    try {
      // If we can access contentWindow without error, it loaded something
      // For cross-origin (chrome-extension://), this will throw, which is expected and OK
      void frame.contentWindow.location.href;
    } catch (e) {
      // Cross-origin error means the extension page DID load (good!)
      clearTimeout(timeout);
      return;
    }
    // If we get here without error, it might be an error page or about:blank
    // Give it a moment then check if it has content
    clearTimeout(timeout);
  });

  frame.addEventListener('error', function() {
    frame.style.display = 'none';
    fallback.style.display = 'flex';
    clearTimeout(timeout);
  });
})();
