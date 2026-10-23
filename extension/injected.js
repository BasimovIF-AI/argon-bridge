// injected.js - Runs in MAIN page context to capture native Markdown without OS focus restrictions

(function () {
  if (window.__geminiBridgeInjected) return;
  window.__geminiBridgeInjected = true;

  console.log("[Argon-Bridge:MainWorld] Interceptor loaded.");

  // 1. Intercept navigator.clipboard.writeText called by Gemini's Copy button
  if (navigator.clipboard && navigator.clipboard.writeText) {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);

    navigator.clipboard.writeText = function (text) {
      console.log(`[Argon-Bridge:MainWorld] Intercepted clipboard writeText: ${text ? text.length : 0} bytes`);
      window.postMessage({
        type: "GEMINI_BRIDGE_CAPTURED_MARKDOWN",
        markdown: text
      }, "*");

      // Attempt normal clipboard write if permitted, catch focus error silently
      return originalWriteText(text).catch(() => {});
    };
  }

  // 2. Intercept copy event as additional fallback
  document.addEventListener("copy", (e) => {
    try {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (clipboardData) {
        const text = clipboardData.getData("text/plain");
        if (text && text.trim().length > 0) {
          window.postMessage({
            type: "GEMINI_BRIDGE_CAPTURED_MARKDOWN",
            markdown: text
          }, "*");
        }
      }
    } catch (_) {}
  }, true);
})();
