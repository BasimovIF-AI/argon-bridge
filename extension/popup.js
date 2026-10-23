// popup.js - Extension status popup

document.addEventListener("DOMContentLoaded", async () => {
  const bridgeStatusEl = document.getElementById("bridge-status");
  const bridgeIndicatorEl = document.getElementById("bridge-indicator");
  const tabStatusEl = document.getElementById("tab-status");
  const tabIndicatorEl = document.getElementById("tab-indicator");
  const openGeminiBtn = document.getElementById("open-gemini-btn");
  const reloadBtn = document.getElementById("reload-btn");

  async function updateStatus() {
    // Check if background service worker has active connections
    chrome.action.getBadgeText({}, (text) => {
      if (text === "ON") {
        bridgeStatusEl.textContent = "Online (:8765)";
        bridgeIndicatorEl.className = "indicator online";
      } else {
        bridgeStatusEl.textContent = "Offline";
        bridgeIndicatorEl.className = "indicator offline";
      }
    });

    // Check if any tab matches gemini.google.com
    const tabs = await chrome.tabs.query({ url: "*://gemini.google.com/*" });
    if (tabs.length > 0) {
      tabStatusEl.textContent = `Active (${tabs.length})`;
      tabIndicatorEl.className = "indicator online";
    } else {
      tabStatusEl.textContent = "No tab found";
      tabIndicatorEl.className = "indicator offline";
    }
  }

  openGeminiBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://gemini.google.com/app" });
  });

  reloadBtn.addEventListener("click", () => {
    chrome.runtime.reload();
    window.close();
  });

  updateStatus();
});
