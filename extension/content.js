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
    // If extension was reloaded in chrome://extensions, stop execution cleanly
    if (!chrome.runtime || !chrome.runtime.id) {
      return;
    }

    try {
      port = chrome.runtime.connect({ name: "gemini_tab" });

      port.onMessage.addListener(async (msg) => {
        console.log("[Gemini-Bridge] Received command from background:", msg.action);
        if (msg.action === "EXECUTE_PROMPT") {
          await handleExecutePrompt(msg);
        }
      });

      port.onDisconnect.addListener(() => {
        port = null;
        if (chrome.runtime && chrome.runtime.id) {
          setTimeout(connectPort, 2000);
        }
      });

      sendStatusSync();
    } catch (e) {
      if (e && e.message && e.message.includes("Extension context invalidated")) {
        // Page was loaded under an older extension version; cleanly stop retry loop
        return;
      }
      setTimeout(connectPort, 3000);
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

  function findModelPickerButton() {
    // 1. Search inside or near the prompt container
    const inputContainer = document.querySelector('rich-textarea, div[role="textbox"], form, .input-area')?.closest('form, div[class*="input"], div[class*="prompt"], [data-test-id*="input"]');
    const container = inputContainer || document.body;
    const buttons = Array.from(container.querySelectorAll('button, div[role="button"], [role="combobox"]'));

    for (const btn of buttons) {
      if (btn.closest('div[class*="profile"], div[class*="user"], nav, aside, .side-nav, .user-badge')) {
        continue;
      }
      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (
        text.includes("flash-lite") ||
        text.includes("flash") ||
        text.includes("argon") ||
        (text.includes("pro") && text.length < 25) ||
        (text.includes("advanced") && text.length < 25)
      ) {
        if (btn.offsetParent !== null) {
          return btn;
        }
      }
    }

    // Fallback: search anywhere on page excluding sidebar & user profile
    const all = Array.from(document.querySelectorAll('button, div[role="button"], [role="combobox"]'));
    for (const btn of all) {
      if (btn.closest('nav, aside, .side-nav, div[class*="profile"], div[class*="user"], .user-badge')) {
        continue;
      }
      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (text.includes("flash-lite") || text.includes("flash") || text.includes("argon")) {
        if (btn.offsetParent !== null) {
          return btn;
        }
      }
    }
    return null;
  }

  async function ensureModelSelected(targetModel) {
    const lowerTarget = (targetModel || "argon").toLowerCase();

    // Check if Argon is already visible on the model picker button
    const currentBtn = findModelPickerButton();
    if (currentBtn) {
      const currentText = (currentBtn.innerText || currentBtn.textContent || "").toLowerCase();
      if (currentText.includes("argon") || currentText.includes("аргон")) {
        console.log("[Gemini-Bridge] Model 'Argon' is already selected:", currentText);
        return;
      }
    }

    const switcherBtn = findModelPickerButton();
    if (!switcherBtn) {
      console.warn("[Gemini-Bridge] Model picker button not found.");
      return;
    }

    console.log("[Gemini-Bridge] Found model picker button:", switcherBtn.innerText);
    switcherBtn.click();
    await sleep(600);

    // Collect all menu options
    const menuOptions = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], [role="option"], mat-option, .mat-mdc-menu-item, div[role="menu"] button, div[role="menu"] div[role="button"], [data-test-id*="model-option"]'
      )
    );

    const availableNames = menuOptions.map(o => (o.innerText || o.textContent || "").trim());
    console.log("[Gemini-Bridge] Available models in menu:", availableNames);

    for (const opt of menuOptions) {
      const optText = (opt.innerText || opt.textContent || "").toLowerCase();
      if (optText.includes("argon") || optText.includes("аргон") || optText.includes(lowerTarget)) {
        console.log("[Gemini-Bridge] Clicking Argon model option:", optText);
        opt.click();
        await sleep(600);
        return;
      }
    }

    // Close menu if option not found
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
  }

  // 3. Input Injection & Sending
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
      if (el && el.offsetParent !== null && !el.disabled && el.getAttribute("aria-disabled") !== "true") {
        return el;
      }
    }
    return null;
  }

  function findStopButton() {
    const selectors = [
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Остановить ответ" i]',
      'button[aria-label*="Остановить создание" i]',
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
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);

    // Insert text via native execCommand so framework event listeners receive it
    const success = document.execCommand("insertText", false, text);
    if (!success || (inputEl.innerText || inputEl.textContent).trim().length === 0) {
      console.log("[Gemini-Bridge] execCommand fallback to innerText...");
      inputEl.innerText = text;
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await sleep(300);
  }

  // 4. Response Extraction and Markdown formatting
  function getLatestResponseElement() {
    const selectors = [
      "model-response",
      "message-content",
      ".model-response-text",
      ".response-container-content",
      '[data-test-id*="model-response"]',
      "div.conversation-turn:last-child"
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
    const parentTurn = container.closest("message-content, model-response, .conversation-turn") || container.parentElement;
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
          (child.classList.contains("thought-container") ||
            child.classList.contains("model-thought") ||
            child.tagName.toLowerCase() === "model-thought")
        ) {
          continue;
        }

        const tag = child.tagName.toLowerCase();

        if (tag === "pre") {
          const codeEl = child.querySelector("code");
          let lang = "";
          if (codeEl) {
            const className = codeEl.className || "";
            const match = className.match(/language-(\w+)/);
            if (match) lang = match[1];
          }
          const codeContent = codeEl ? codeEl.innerText : child.innerText;
          result += `\n\`\`\`${lang}\n${codeContent.trim()}\n\`\`\`\n\n`;
        } else if (tag === "code") {
          result += `\`${child.innerText}\``;
        } else if (tag === "p") {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === "ul") {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === "ol") {
          result += `\n${htmlToMarkdown(child)}\n`;
        } else if (tag === "li") {
          result += `\n* ${htmlToMarkdown(child)}`;
        } else if (/^h[1-6]$/.test(tag)) {
          const level = parseInt(tag[1], 10);
          result += `\n${"#".repeat(level)} ${htmlToMarkdown(child)}\n`;
        } else if (tag === "strong" || tag === "b") {
          result += `**${htmlToMarkdown(child)}**`;
        } else if (tag === "em" || tag === "i") {
          result += `*${htmlToMarkdown(child)}*`;
        } else if (tag === "br") {
          result += "\n";
        } else {
          result += htmlToMarkdown(child);
        }
      }
    }

    return result;
  }

  // 5. Complete prompt execution lifecycle
  async function handleExecutePrompt(req) {
    if (isExecuting) {
      console.warn("[Gemini-Bridge] Overriding previous request for new request:", req.id);
    }
    isExecuting = true;
    console.log(`[Gemini-Bridge] Starting execution for request ${req.id}...`);

    try {
      // Step A: Ensure model selector is on Argon if requested
      try {
        await ensureModelSelected(req.model);
      } catch (mErr) {
        console.warn("[Gemini-Bridge] Model check skipped:", mErr);
      }

      // Step B: Locate input field
      const inputEl = await waitForCondition(() => findInputField(), 10000, 300);
      if (!inputEl) {
        throw new Error("Could not find Gemini chat input field.");
      }

      // Step C: Record baseline state before prompt submission
      const prevEl = getLatestResponseElement();
      const prevTextLen = prevEl ? (prevEl.innerText || "").length : 0;

      // Step D: Inject prompt into input
      await injectPrompt(inputEl, req.prompt);

      // Step E: Locate and click Send button
      const sendBtn = await waitForCondition(() => findSendButton(), 5000, 200);
      if (!sendBtn) {
        console.log("[Gemini-Bridge] Send button not found; sending Enter key...");
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      } else {
        console.log("[Gemini-Bridge] Clicking Send button...");
        sendBtn.click();
      }

      // Step F: Wait for response generation to complete
      console.log("[Gemini-Bridge] Waiting for Gemini response generation...");
      const maxWaitMs = (req.timeout_secs || 240) * 1000;
      const startTime = Date.now();
      let lastLen = 0;
      let stableCount = 0;
      let hasStarted = false;

      while (Date.now() - startTime < maxWaitMs) {
        await sleep(700);

        const stopBtn = findStopButton();
        const curEl = getLatestResponseElement();
        const curText = curEl ? (curEl.innerText || "").trim() : "";
        const curLen = curText.length;

        // Has generation started?
        if (stopBtn || curLen > prevTextLen) {
          hasStarted = true;
        }

        if (hasStarted) {
          // If Stop button is gone and text is longer than baseline
          if (!stopBtn && curLen > prevTextLen) {
            // Check if text has stopped growing
            if (curLen === lastLen) {
              stableCount++;
              if (stableCount >= 2) { // 1.4s of stability
                console.log("[Gemini-Bridge] Response complete! Length:", curLen);
                break;
              }
            } else {
              stableCount = 0;
              lastLen = curLen;
            }
          } else {
            stableCount = 0;
            lastLen = curLen;
          }
        }
      }

      // Step G: Extract Markdown
      const finalResponseEl = getLatestResponseElement();
      if (!finalResponseEl) {
        throw new Error("No response element appeared after prompt submission.");
      }

      let markdown = "";
      capturedMarkdownFromPage = null;

      // Try native copy button
      const copyBtn = findResponseCopyButton(finalResponseEl);
      if (copyBtn) {
        try {
          console.log("[Gemini-Bridge] Triggering native Copy button...");
          copyBtn.click();
          const waitStart = Date.now();
          while (Date.now() - waitStart < 500 && !capturedMarkdownFromPage) {
            await sleep(50);
          }
          if (capturedMarkdownFromPage && capturedMarkdownFromPage.trim().length > 0) {
            markdown = capturedMarkdownFromPage.trim();
            console.log("[Gemini-Bridge] Captured Markdown via MainWorld interceptor! Bytes:", markdown.length);
          }
        } catch (_) {}
      }

      // Fallback: parse DOM directly
      if (!markdown || markdown.length === 0) {
        markdown = htmlToMarkdown(finalResponseEl).trim();
        if (!markdown || markdown.length === 0) {
          markdown = (finalResponseEl.innerText || finalResponseEl.textContent || "").trim();
        }
      }

      const finalUrl = window.location.href;
      console.log("[Gemini-Bridge] Execution successful. URL:", finalUrl);

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
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  connectPort();

  setInterval(() => {
    if (!chrome.runtime || !chrome.runtime.id) return;
    if (!port) connectPort();
    else sendStatusSync();
  }, 10000);

})();
