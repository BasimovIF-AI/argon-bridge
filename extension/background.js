// background.js - Gemini-Bridge Service Worker (Manifest V3)

const WS_URL = "ws://127.0.0.1:8765";
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 5000; // Start with 5s backoff
const MAX_RECONNECT_DELAY = 30000; // Max 30s backoff
let activeGeminiPort = null;

console.log("[Gemini-Bridge] Service Worker initialized.");

// 1. Maintain long-lived port connection with content.js running in gemini.google.com
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "gemini_tab") {
    console.log("[Gemini-Bridge] Gemini tab connected via port.");
    activeGeminiPort = port;

    // When Gemini tab connects, ensure WebSocket is connected or retry immediately
    reconnectDelay = 2000;
    connectWebSocket();

    port.onMessage.addListener((msg) => {
      handleContentMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      console.log("[Gemini-Bridge] Gemini tab disconnected.");
      if (activeGeminiPort === port) {
        activeGeminiPort = null;
        broadcastStatus();
      }
    });

    broadcastStatus();
  }
});

// 2. Establish and maintain persistent WebSocket with Rust Bridge
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
    console.log("[Gemini-Bridge] Connected to Rust bridge at " + WS_URL);
    reconnectDelay = 5000; // Reset backoff on successful connection
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    broadcastStatus();
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleBridgeMessage(msg);
    } catch (err) {
      console.error("[Gemini-Bridge] Failed to parse message from bridge:", err);
    }
  };

  socket.onclose = () => {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // Silently handle error to prevent spamming DevTools/Extension error list
    socket = null;
  };
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

// Keep service worker alive using chrome.alarms
chrome.alarms.create("bridgeKeepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridgeKeepAlive") {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

function waitForTabAndPort(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (activeGeminiPort || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(activeGeminiPort);
      }
    }, 200);
  });
}

async function executePromptOnGemini(req) {
  // 1. Find or open Gemini tab
  const tabs = await chrome.tabs.query({ url: "*://gemini.google.com/*" });
  let tab = tabs[0];

  if (!tab) {
    const targetUrl = req.chat_url || "https://gemini.google.com/app";
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await waitForTabAndPort(tab.id);
  } else {
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (_) {}
  }

  // 2. Safely navigate tab if chat URL does not match
  if (tab) {
    const currentUrl = tab.url || "";
    if (req.chat_url && currentUrl !== req.chat_url) {
      console.log(`[Gemini-Bridge] Navigating to mapped chat: ${req.chat_url}`);
      activeGeminiPort = null;
      await chrome.tabs.update(tab.id, { url: req.chat_url });
      await waitForTabAndPort(tab.id);
    } else if (!req.chat_url && currentUrl.includes("/app/") && !currentUrl.endsWith("/app")) {
      console.log(`[Gemini-Bridge] Navigating to clean /app for new conversation...`);
      activeGeminiPort = null;
      await chrome.tabs.update(tab.id, { url: "https://gemini.google.com/app" });
      await waitForTabAndPort(tab.id);
    }
  }

  if (!activeGeminiPort) {
    sendToBridge({
      type: "PROMPT_RESPONSE",
      id: req.id,
      status: "ERROR",
      content: "",
      chat_url: null,
      error: "Gemini tab content script is not connected. Please ensure gemini.google.com is open."
    });
    return;
  }

  activeGeminiPort.postMessage({
    action: "EXECUTE_PROMPT",
    id: req.id,
    prompt: req.prompt,
    model: req.model || "Gemini 4 Argon",
    timeout_secs: req.timeout_secs || 240
  });
}

// 4. Handle messages from content.js
function handleContentMessage(msg) {
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
      active_tab_found: true,
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
    active_tab_found: activeGeminiPort !== null,
    current_chat_url: null,
    current_model: "Gemini 4 Argon"
  });
}

// Initial connection attempt
connectWebSocket();
