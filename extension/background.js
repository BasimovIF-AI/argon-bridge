// background.js - Argon-Bridge Service Worker (Manifest V3)

// Suppress unhandled exceptions from polluting Chrome's extension error log
self.addEventListener("error", (event) => {
  if (event && event.preventDefault) event.preventDefault();
});

self.addEventListener("unhandledrejection", (event) => {
  if (event && event.preventDefault) event.preventDefault();
});

const WS_URL = "ws://127.0.0.1:8765";
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 30000;

// Track ports deterministically by tabId
const geminiPorts = new Map(); // tabId -> chrome.runtime.Port
let dedicatedBridgeTabId = null;

console.log("[Argon-Bridge] Service Worker initialized.");

// 1. Maintain long-lived port connection with content.js per tabId
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "gemini_tab" && port.sender && port.sender.tab) {
    const tabId = port.sender.tab.id;
    console.log(`[Argon-Bridge] Gemini tab ${tabId} connected via port.`);
    geminiPorts.set(tabId, port);

    // If no dedicated tab assigned, or if this is the dedicated tab, record it
    if (dedicatedBridgeTabId === null || dedicatedBridgeTabId === tabId) {
      dedicatedBridgeTabId = tabId;
    }

    reconnectDelay = 2000;
    connectWebSocket();

    port.onMessage.addListener((msg) => {
      handleContentMessage(msg, tabId);
    });

    port.onDisconnect.addListener(() => {
      const _ = chrome.runtime?.lastError; // Cleanly consume error to prevent unchecked runtime warnings
      console.log(`[Argon-Bridge] Gemini tab ${tabId} disconnected.`);
      geminiPorts.delete(tabId);
      if (dedicatedBridgeTabId === tabId) {
        dedicatedBridgeTabId = null;
      }
      broadcastStatus();
    });

    broadcastStatus();
  }
});

// Cleanly handle tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  if (dedicatedBridgeTabId === tabId) {
    console.log(`[Argon-Bridge] Dedicated tab ${tabId} was closed by user.`);
    dedicatedBridgeTabId = null;
  }
  geminiPorts.delete(tabId);
});

// 2. Persistent WebSocket with Rust Bridge
function connectWebSocket() {
  if (socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      return;
    }
  }

  try {
    socket = new WebSocket(WS_URL);
  } catch (_) {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[Argon-Bridge] Connected to Rust bridge at " + WS_URL);
    reconnectDelay = 5000;
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    broadcastStatus();
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleBridgeMessage(msg);
    } catch (err) {
      console.log("[Argon-Bridge] Failed to parse message from bridge:", err);
    }
  };

  socket.onclose = () => {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    socket = null;
  };

  socket.addEventListener("error", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    socket = null;
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    connectWebSocket();
  }, reconnectDelay);
}

// 3. Handle messages received from Rust Bridge
async function handleBridgeMessage(msg) {
  if (msg.type === "EXECUTE_PROMPT") {
    await executePromptOnGemini(msg);
  } else if (msg.type === "PING") {
    sendToBridge({ type: "PONG", timestamp: Date.now() });
  } else if (msg.type === "GET_STATUS") {
    broadcastStatus();
  }
}

// Heartbeat keep-alive
chrome.alarms.create("bridgeKeepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridgeKeepAlive") {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

function waitForTabPort(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (geminiPorts.has(tabId) || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(geminiPorts.get(tabId) || null);
      }
    }, 200);
  });
}

// Resolve or automatically open a Gemini tab on-demand only when a prompt is executed
async function getGeminiTabForExecution() {
  // 1. If we previously tracked a tab and it's still open, check it
  if (dedicatedBridgeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(dedicatedBridgeTabId);
      if (tab && tab.url && tab.url.includes("gemini.google.com")) {
        return tab;
      }
    } catch (_) {
      dedicatedBridgeTabId = null;
    }
  }

  // 2. Check if the user already has an active or any open Gemini tab in the browser
  const activeTabs = await chrome.tabs.query({ url: "*://gemini.google.com/*", active: true });
  if (activeTabs.length > 0) {
    dedicatedBridgeTabId = activeTabs[0].id;
    return activeTabs[0];
  }

  const allTabs = await chrome.tabs.query({ url: "*://gemini.google.com/*" });
  if (allTabs.length > 0) {
    dedicatedBridgeTabId = allTabs[0].id;
    return allTabs[0];
  }

  // 3. No Gemini tab exists in the browser! Open one on-demand.
  console.log("[Argon-Bridge] No open Gemini tab found. Automatically opening new tab on-demand...");
  try {
    const tab = await chrome.tabs.create({
      url: "https://gemini.google.com/app",
      active: true
    });
    dedicatedBridgeTabId = tab.id;
    return tab;
  } catch (err) {
    console.log("[Argon-Bridge] Failed to create tab:", err);
    return null;
  }
}

async function executePromptOnGemini(req) {
  const tab = await getGeminiTabForExecution();

  if (!tab) {
    sendToBridge({
      type: "PROMPT_RESPONSE",
      id: req.id,
      status: "ERROR",
      content: "",
      chat_url: null,
      error: "Could not find or open a Gemini tab."
    });
    return;
  }

  // Focus and unthrottle the dedicated tab
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {}

  // Handle URL navigation if required
  const currentUrl = tab.url || "";
  if (req.chat_url && currentUrl !== req.chat_url) {
    console.log(`[Argon-Bridge] Navigating tab ${tab.id} to: ${req.chat_url}`);
    geminiPorts.delete(tab.id); // Invalidate old page port so we wait for new page content script
    try {
      await chrome.tabs.update(tab.id, { url: req.chat_url });
      await waitForTabPort(tab.id, 10000);
    } catch (_) {}
  } else if (!req.chat_url && currentUrl.includes("/app/") && !currentUrl.endsWith("/app")) {
    // If user requested a fresh chat and the tab is inside an old conversation, navigate to clean /app
    console.log(`[Argon-Bridge] Resetting tab to clean /app for new chat...`);
    geminiPorts.delete(tab.id); // Invalidate old page port
    try {
      await chrome.tabs.update(tab.id, { url: "https://gemini.google.com/app" });
      await waitForTabPort(tab.id, 10000);
    } catch (_) {}
  }

  // Ensure port is connected
  let port = geminiPorts.get(tab.id);
  if (!port) {
    console.log(`[Argon-Bridge] Waiting for port on tab ${tab.id}...`);
    port = await waitForTabPort(tab.id, 8000);
  }

  if (!port) {
    // Fallback: check any connected Gemini port
    for (const [tId, p] of geminiPorts.entries()) {
      port = p;
      dedicatedBridgeTabId = tId;
      break;
    }
  }

  if (!port) {
    sendToBridge({
      type: "PROMPT_RESPONSE",
      id: req.id,
      status: "ERROR",
      content: "",
      chat_url: null,
      error: "Content script is not connected on the Gemini tab. Please refresh the page."
    });
    return;
  }

  console.log(`[Argon-Bridge] Dispatching prompt to tab ${dedicatedBridgeTabId}...`);
  port.postMessage({
    action: "EXECUTE_PROMPT",
    id: req.id,
    prompt: req.prompt,
    model: req.model || "Gemini 4 Argon",
    timeout_secs: req.timeout_secs || 240
  });
}

// 4. Handle messages from content.js
function handleContentMessage(msg, tabId) {
  if (msg.action === "PROMPT_FINISHED") {
    sendToBridge({
      type: "PROMPT_RESPONSE",
      id: msg.id,
      status: msg.status,
      content: msg.content,
      chat_url: msg.chat_url,
      error: msg.error || null
    });
  } else if (msg.action === "STATUS_SYNC") {
    sendToBridge({
      type: "STATUS_UPDATE",
      connected: true,
      active_tab_found: geminiPorts.size > 0,
      current_chat_url: msg.current_chat_url,
      current_model: msg.current_model
    });
  }
}

function sendToBridge(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastStatus() {
  sendToBridge({
    type: "STATUS_UPDATE",
    connected: socket !== null && socket.readyState === WebSocket.OPEN,
    active_tab_found: geminiPorts.size > 0,
    current_chat_url: null,
    current_model: "Gemini 4 Argon"
  });
}

connectWebSocket();
