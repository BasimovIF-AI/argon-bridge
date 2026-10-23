// content.js - Gemini-Bridge Content Script for gemini.google.com

(function () {
  console.log("[Gemini-Bridge] Content script loaded on gemini.google.com");

  let port = null;
  let isExecuting = false;
  let capturedMarkdownFromPage = null;

  // Listen for captured Markdown from injected.js (runs in MAIN world)
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data && event.data.type === "GEMINI_BRIDGE_CAPTURED_MARKDOWN") {
      capturedMarkdownFromPage = event.data.markdown;
      console.log(`[Gemini-Bridge] Received captured Markdown via window.postMessage (${capturedMarkdownFromPage ? capturedMarkdownFromPage.length : 0} bytes)`);
    }
  });

  // 1. Maintain long-lived port connection to background service worker
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "gemini_tab" });

      port.onMessage.addListener(async (msg) => {
        console.log("[Gemini-Bridge] Received command from background:", msg.action);
        if (msg.action === "EXECUTE_PROMPT") {
          await handleExecutePrompt(msg);
        }
      });

      port.onDisconnect.addListener(() => {
        console.log("[Gemini-Bridge] Port to service worker disconnected. Reconnecting in 2s...");
        port = null;
        setTimeout(connectPort, 2000);
      });

      sendStatusSync();
    } catch (e) {
      console.warn("[Gemini-Bridge] Connection failed, retrying in 2s:", e);
      setTimeout(connectPort, 2000);
    }
  }

  function sendStatusSync() {
    if (port) {
      port.postMessage({
        action: "STATUS_SYNC",
        current_chat_url: window.location.href,
        current_model: detectCurrentModel()
      });
    }
  }

  // 2. Model Detection and Selection
  function detectCurrentModel() {
    // Look for model selector buttons or labels in the header
    const candidates = document.querySelectorAll(
      'button[aria-label*="model" i], button[aria-label*="модел" i], .model-title, [data-test-id*="model" i]'
    );
    for (const el of candidates) {
      const text = el.innerText || el.textContent;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
    return "Gemini (Default)";
  }

  async function ensureModelSelected(targetModel) {
    if (!targetModel) return;
    const lowerTarget = targetModel.toLowerCase();

    // Check if current text already mentions Argon / target
    const currentText = document.body.innerText.toLowerCase();
    const modelDropdowns = document.querySelectorAll(
      'button[aria-label*="model" i], button[aria-label*="модел" i], [aria-haspopup="menu"], [data-test-id*="model" i]'
    );

    for (const btn of modelDropdowns) {
      const btnText = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (btnText.includes('argon')) {
        console.log("[Gemini-Bridge] Model 'Argon' is already active.");
        return;
      }
    }

    // Try to click dropdown to switch model if available
    for (const btn of modelDropdowns) {
      if (btn.offsetParent !== null) { // visible
        console.log("[Gemini-Bridge] Attempting to open model selector dropdown...");
        btn.click();
        await sleep(500);

        // Find menu items
        const menuItems = document.querySelectorAll(
          '[role="menuitem"], [role="option"], mat-option, .mat-mdc-menu-item, div[role="menu"] button'
        );
        for (const item of menuItems) {
          const itemText = (item.innerText || item.textContent || '').toLowerCase();
          if (itemText.includes('argon') || (lowerTarget && itemText.includes(lowerTarget))) {
            console.log("[Gemini-Bridge] Found model option:", item.innerText);
            item.click();
            await sleep(500);
            return;
          }
        }

        // Close dropdown if target wasn't found by clicking outside or pressing Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);
        break;
      }
    }
  }

  // 3. Navigation helpers
  async function handleNavigation(targetUrl) {
    if (!targetUrl) {
      // Force new chat: check if we have a "New chat" button
      const newChatBtns = document.querySelectorAll(
        'button[aria-label*="New chat" i], button[aria-label*="Новый чат" i], a[href="/app"], [data-test-id*="new-chat" i]'
      );
      for (const btn of newChatBtns) {
        if (btn.offsetParent !== null) {
          console.log("[Gemini-Bridge] Clicking 'New chat' button...");
          btn.click();
          await sleep(1500);
          return;
        }
      }
      if (window.location.pathname !== "/app") {
        console.log("[Gemini-Bridge] Navigating to /app for new chat...");
        window.location.href = "https://gemini.google.com/app";
        await sleep(2000);
      }
    } else {
      // Existing chat requested: if different from current URL, navigate
      if (window.location.href !== targetUrl) {
        console.log(`[Gemini-Bridge] Navigating to mapped chat URL: ${targetUrl}`);
        window.location.href = targetUrl;
        await sleep(2500);
      }
    }
  }

  // 4. Input Injection & Sending
  function findInputField() {
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor',
      'textarea[aria-label*="prompt" i]',
      'textarea'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Отправить" i]',
      'button.send-button',
      '[data-test-id="send-button"]',
      'button[jsname*="send" i]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
        return el;
      }
    }
    return null;
  }

  function findStopButton() {
    const selectors = [
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Остановить" i]',
      '[data-test-id="stop-button"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return el;
      }
    }
    return null;
  }

  async function injectPrompt(inputEl, text) {
    inputEl.focus();
    await sleep(100);

    // Select existing text and clear
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // Insert text via native execCommand so framework event listeners receive it
    const success = document.execCommand('insertText', false, text);
    if (!success || (inputEl.innerText || inputEl.textContent).trim().length === 0) {
      console.log("[Gemini-Bridge] execCommand failed, falling back to innerText assignment...");
      inputEl.innerText = text;
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(300);
  }

  // 5. Response Extraction and Markdown formatting
  function getLatestResponseElement() {
    const selectors = [
      'model-response',
      '.model-response-text',
      'message-content',
      '[data-test-id="model-response"]',
      '.response-container-content'
    ];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      if (elements && elements.length > 0) {
        return elements[elements.length - 1];
      }
    }
    return null;
  }

  function findResponseCopyButton(container) {
    if (!container) return null;
    const parentTurn = container.closest('message-content, model-response, .conversation-turn') || container.parentElement;
    const scope = parentTurn || container;
    const selectors = [
      'button[aria-label*="Copy" i]',
      'button[aria-label*="Копировать" i]',
      '[data-test-id*="copy" i]',
      '.copy-button',
      'button[mattooltip*="Copy" i]',
      'button[mattooltip*="Копировать" i]'
    ];
    for (const sel of selectors) {
      const btn = scope.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        return btn;
      }
    }
    return null;
  }

  function htmlToMarkdown(node) {
    if (!node) return "";
    let result = "";

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        // Skip thinking / reasoning collapse blocks in final code extraction
        if (
          child.classList &&
          (child.classList.contains('thought-container') ||
           child.classList.contains('model-thought') ||
           child.tagName.toLowerCase() === 'model-thought')
        ) {
          continue;
        }

        const tag = child.tagName.toLowerCase();

        if (tag === 'pre') {
          const codeEl = child.querySelector('code');
          let lang = "";
          if (codeEl) {
            const className = codeEl.className || "";
            const match = className.match(/language-(\w+)/);
            if (match) lang = match[1];
          }
          const codeContent = codeEl ? codeEl.innerText : child.innerText;
          result += `\n\`\`\`${lang}\n${codeContent.trim()}\n\`\`\`\n\n`;
        } else if (tag === 'code') {
          result += `\`${child.innerText}\``;
        } else if (tag === 'p') {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === 'ul') {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === 'ol') {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === 'li') {
          result += `\n* ${htmlToMarkdown(child)}`;
        } else if (/^h[1-6]$/.test(tag)) {
          const level = parseInt(tag[1], 10);
          result += `\n${"#".repeat(level)} ${htmlToMarkdown(child)}\n`;
        } else if (tag === 'strong' || tag === 'b') {
          result += `**${htmlToMarkdown(child)}**`;
        } else if (tag === 'em' || tag === 'i') {
          result += `*${htmlToMarkdown(child)}*`;
        } else if (tag === 'br') {
          result += "\n";
        } else {
          result += htmlToMarkdown(child);
        }
      }
    }

    return result;
  }

  // 6. Complete prompt execution lifecycle
  async function handleExecutePrompt(req) {
    if (isExecuting) {
      console.warn("[Gemini-Bridge] Resetting previously active execution for new request:", req.id);
    }

    isExecuting = true;
    console.log(`[Gemini-Bridge] Starting execution for request ${req.id}...`);

    try {
      // Step A: Ensure model selector is on Argon if requested (soft check)
      try {
        await ensureModelSelected(req.model);
      } catch (modelErr) {
        console.warn("[Gemini-Bridge] Model switcher notice:", modelErr);
      }

      // Step B: Locate input field
      const inputEl = await waitForCondition(() => findInputField(), 10000, 300);
      if (!inputEl) {
        throw new Error("Could not find Gemini chat input field.");
      }

      // Step C: Count existing responses before sending
      const initialResponses = document.querySelectorAll('model-response, message-content, .model-response-text');
      const initialCount = initialResponses.length;

      // Step E: Inject prompt into input
      await injectPrompt(inputEl, req.prompt);

      // Step F: Locate and click Send button
      const sendBtn = await waitForCondition(() => findSendButton(), 5000, 200);
      if (!sendBtn) {
        // Fallback: hit Enter key on input element
        console.log("[Gemini-Bridge] Send button disabled or not found; sending Enter key...");
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } else {
        console.log("[Gemini-Bridge] Clicking Send button...");
        sendBtn.click();
      }

      // Step G: Wait for response to start and complete (taking Thinking into account)
      console.log("[Gemini-Bridge] Waiting for Gemini 4 Argon to generate response...");
      await sleep(1500);

      const maxWaitMs = (req.timeout_secs || 240) * 1000;
      const startTime = Date.now();
      let lastTextLength = 0;
      let stableCount = 0;

      while (Date.now() - startTime < maxWaitMs) {
        await sleep(800);

        const stopBtn = findStopButton();
        const currentResponseEl = getLatestResponseElement();
        const currentCount = document.querySelectorAll('model-response, message-content, .model-response-text').length;

        if (currentCount > initialCount && currentResponseEl) {
          const currentText = currentResponseEl.innerText || "";
          const copyBtn = findResponseCopyButton(currentResponseEl);

          // Complete condition: Stop button is gone AND copy button appeared
          if (!stopBtn && copyBtn && currentText.length > 0) {
            console.log("[Gemini-Bridge] Generation complete (Stop button absent & Copy action button visible)! Length:", currentText.length);
            break;
          }

          // Fallback: If copy button selector changed, verify stillness for ~3.2 seconds
          if (!stopBtn && currentText.length > 0 && currentText.length === lastTextLength) {
            stableCount++;
            if (stableCount >= 4) {
              console.log("[Gemini-Bridge] Generation complete via stillness fallback. Length:", currentText.length);
              break;
            }
          } else {
            stableCount = 0;
            lastTextLength = currentText.length;
          }
        }
      }

      // Step H: Extract pristine Markdown (prioritizing intercepted writeText -> clipboard -> DOM parser)
      const finalResponseEl = getLatestResponseElement();
      if (!finalResponseEl) {
        throw new Error("No response element appeared after prompt submission.");
      }

      let markdown = "";
      capturedMarkdownFromPage = null; // Reset capture variable
      const copyBtn = findResponseCopyButton(finalResponseEl);

      if (copyBtn) {
        console.log("[Gemini-Bridge] Triggering native Copy button...");
        copyBtn.click();

        // 1. Check if injected.js captured text via intercepted navigator.clipboard.writeText
        const waitStart = Date.now();
        while (Date.now() - waitStart < 600 && !capturedMarkdownFromPage) {
          await sleep(50);
        }

        if (capturedMarkdownFromPage && capturedMarkdownFromPage.trim().length > 0) {
          markdown = capturedMarkdownFromPage.trim();
          console.log("[Gemini-Bridge] Captured pristine Markdown via MainWorld interceptor! Bytes:", markdown.length);
        } else {
          // 2. Fallback to direct clipboard read if OS focus allows
          try {
            const clipboardText = await navigator.clipboard.readText();
            if (clipboardText && clipboardText.trim().length > 0) {
              markdown = clipboardText.trim();
              console.log("[Gemini-Bridge] Extracted Markdown from clipboard. Bytes:", markdown.length);
            }
          } catch (clipErr) {
            console.debug("[Gemini-Bridge] Clipboard read unavailable (expected in background window):", clipErr);
          }
        }
      }

      // 3. Fallback: clean DOM parser with Thinking blocks stripped
      if (!markdown || markdown.length === 0) {
        markdown = htmlToMarkdown(finalResponseEl).trim();
        if (!markdown || markdown.length === 0) {
          markdown = (finalResponseEl.innerText || finalResponseEl.textContent || "").trim();
        }
      }

      const finalUrl = window.location.href;
      console.log("[Gemini-Bridge] Execution successful. Session URL:", finalUrl);

      port.postMessage({
        action: "PROMPT_FINISHED",
        id: req.id,
        status: "SUCCESS",
        content: markdown,
        chat_url: finalUrl,
        error: null
      });

    } catch (err) {
      console.error("[Gemini-Bridge] Execution error:", err);
      port.postMessage({
        action: "PROMPT_FINISHED",
        id: req.id,
        status: "ERROR",
        content: "",
        chat_url: window.location.href,
        error: err.message || String(err)
      });
    } finally {
      isExecuting = false;
      sendStatusSync();
    }
  }

  // Utilities
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForCondition(checkFn, timeoutMs, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = checkFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  // Connect port on page load
  connectPort();

  // Periodic heartbeat / status check
  setInterval(() => {
    if (!port) connectPort();
    else sendStatusSync();
  }, 10000);

})();
