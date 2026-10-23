// background.js - Gemini-Bridge Service Worker (Manifest V3)

const WS_URL = "ws://127.0.0.1:8765";
let socket = null;
let reconnectTimer = null;
let activeGeminiPort = null;
let pendingPromptWaiters = new Map(); // id -> resolve/reject

console.log("[Gemini-Bridge] Service Worker initialized.");

// 1. Maintain long-lived port connection with content.js running in gemini.google.com
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "gemini_tab") {
    console.log("[Gemini-Bridge] Gemini tab connected via port.");
    activeGeminiPort = port;

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
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(`[Gemini-Bridge] Connecting to Rust bridge at ${WS_URL}...`);
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[Gemini-Bridge] WebSocket creation failed:", err);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[Gemini-Bridge] Connected to Rust bridge!");
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    broadcastStatus();
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log("[Gemini-Bridge] Inbound message from bridge:", msg.type, msg.id || "");
      handleBridgeMessage(msg);
    } catch (err) {
      console.error("[Gemini-Bridge] Failed to parse message from bridge:", err, event.data);
    }
  };

  socket.onclose = (event) => {
    console.log("[Gemini-Bridge] WebSocket closed. Code:", event.code);
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.warn("[Gemini-Bridge] WebSocket error:", err);
    socket = null;
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
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

async function executePromptOnGemini(req) {
  // Check if we have an active Gemini tab connected
  if (!activeGeminiPort) {
    // Try to find an existing Gemini tab or open a new one
    const tabs = await chrome.tabs.query({ url: "*://gemini.google.com/*" });
    if (tabs.length === 0) {
      console.log("[Gemini-Bridge] No Gemini tab found. Creating new tab...");
      const targetUrl = req.chat_url || "https://gemini.google.com/app";
      await chrome.tabs.create({ url: targetUrl, active: true });
      sendToBridge({
        type: "PROMPT_RESPONSE",
        id: req.id,
        status: "ERROR",
        content: "",
        chat_url: null,
        error: "Gemini tab was not open. A new tab has been created, please wait for page to load and retry."
      });
      return;
    }
  }

  if (!activeGeminiPort) {
    sendToBridge({
      type: "PROMPT_RESPONSE",
      id: req.id,
      status: "ERROR",
      content: "",
      chat_url: null,
      error: "Gemini tab is open but content script is not yet connected. Please refresh the gemini.google.com tab."
    });
    return;
  }

  // Forward prompt execution to content script
  activeGeminiPort.postMessage({
    action: "EXECUTE_PROMPT",
    id: req.id,
    prompt: req.prompt,
    model: req.model || "Gemini 4 Argon",
    chat_url: req.chat_url,
    timeout_secs: req.timeout_secs || 180
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

// Initial connect
connectWebSocket();
