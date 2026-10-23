// content.js - Argon-Bridge Content Script for gemini.google.com

(function () {
  console.log("[Argon-Bridge] Content script loaded on gemini.google.com");

  let port = null;
  let isExecuting = false;
  let capturedMarkdownFromPage = null;

  // Listen for captured Markdown from injected.js (runs in MAIN world)
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data && event.data.type === "GEMINI_BRIDGE_CAPTURED_MARKDOWN") {
      capturedMarkdownFromPage = event.data.markdown;
      console.log(`[Argon-Bridge] Received captured Markdown via window.postMessage (${capturedMarkdownFromPage ? capturedMarkdownFromPage.length : 0} bytes)`);
    }
  });

  function isContextValid() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // 1. Maintain long-lived port connection to background service worker
  function connectPort() {
    if (!isContextValid()) return;

    try {
      port = chrome.runtime.connect({ name: "gemini_tab" });

      port.onMessage.addListener(async (msg) => {
        console.log("[Argon-Bridge] Received command from background:", msg.action);
        if (msg.action === "EXECUTE_PROMPT") {
          await handleExecutePrompt(msg);
        }
      });

      port.onDisconnect.addListener(() => {
        const _ = chrome.runtime?.lastError; // Cleanly consume error to prevent unchecked runtime warnings
        port = null;
        if (isContextValid()) {
          setTimeout(() => {
            if (isContextValid()) connectPort();
          }, 2000);
        }
      });

      sendStatusSync();
    } catch (_) {
      // If extension context invalidated or any connect error, cleanly terminate retry loop.
      // Do NOT log to console.warn/error to avoid spamming chrome://extensions.
      return;
    }
  }

  function sendStatusSync() {
    if (port && isContextValid()) {
      try {
        port.postMessage({
          action: "STATUS_SYNC",
          current_chat_url: window.location.href,
          current_model: detectCurrentModel()
        });
      } catch (_) {}
    }
  }

  function triggerClick(el) {
    if (!el) return;
    el.focus();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();
  }

  // 2. Model Detection and Selection
  function detectCurrentModel() {
    const btn = findModelPickerButton();
    if (btn) {
      const text = (btn.innerText || btn.textContent || "").trim();
      if (text.length > 0) return text;
    }
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
    const inputEl = findInputField();
    const container = inputEl
      ? inputEl.closest('form, [class*="input-area"], [class*="chat-input"], [class*="prompt"]') ||
        inputEl.parentElement?.parentElement?.parentElement?.parentElement ||
        document.body
      : document.body;

    const localButtons = Array.from(container.querySelectorAll('button, div[role="button"], [role="combobox"]'));
    for (const btn of localButtons) {
      if (btn.closest('nav, aside, .side-nav, div[class*="profile"], div[class*="user"], .user-badge')) continue;

      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (
        text.includes("flash-lite") ||
        text.includes("flash") ||
        text.includes("argon") ||
        text.includes("pro") ||
        text.includes("advanced")
      ) {
        return btn;
      }
    }

    // 2. Global search excluding sidebar
    const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], [role="combobox"]'));
    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.left < 200) continue; // Skip sidebar
      if (btn.closest('nav, aside, .side-nav, div[class*="profile"], div[class*="user"], .user-badge')) continue;

      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (
        text.includes("flash-lite") ||
        text.includes("flash") ||
        text.includes("argon") ||
        (text.includes("pro") && text.length < 25) ||
        (text.includes("advanced") && text.length < 25)
      ) {
        return btn;
      }
    }
    return null;
  }

  let activeModelNotice = null;

  function isItemAvailable(itemEl) {
    if (itemEl.disabled || itemEl.getAttribute("aria-disabled") === "true") {
      return false;
    }
    const classList = itemEl.className || "";
    if (classList.includes("disabled") || classList.includes("is-disabled")) {
      return false;
    }
    const fullText = (itemEl.innerText || itemEl.textContent || "").toLowerCase();
    if (
      fullText.includes("лимит") ||
      fullText.includes("обновится") ||
      fullText.includes("limit") ||
      fullText.includes("resets") ||
      fullText.includes("upgrade") ||
      fullText.includes("превышен")
    ) {
      return false;
    }
    return true;
  }

  async function ensureModelSelected(targetModel) {
    activeModelNotice = null;
    const target = (targetModel || "argon").toLowerCase();
    const isProOrArgon = target.includes("argon") || target.includes("аргон") || target.includes("pro");

    // Wait up to 5s for the switcher button to mount
    const switcherBtn = await waitForCondition(() => findModelPickerButton(), 5000, 200);
    if (!switcherBtn) {
      throw new Error("Не удалось найти кнопку выбора модели в интерфейсе Gemini.");
    }

    const currentText = (switcherBtn.innerText || switcherBtn.textContent || "").toLowerCase();
    if (isProOrArgon) {
      if (currentText.includes("argon") || currentText.includes("аргон")) {
        console.log("[Argon-Bridge] Target model (Argon) is already active:", currentText);
        return;
      }
    }

    console.log("[Argon-Bridge] Opening model picker menu from button:", switcherBtn.innerText);
    triggerClick(switcherBtn);

    // Wait up to 4s for menu options to mount in DOM
    const menuOptions = await waitForCondition(() => {
      const opts = Array.from(
        document.querySelectorAll(
          'gem-menu-item, [role="menuitem"], [role="menuitemradio"], [role="option"], mat-option, .mat-mdc-menu-item, div[role="menu"] button, div[role="menu"] div[role="button"], [data-test-id*="model-option"]'
        )
      ).filter(el => el.offsetParent !== null || el.tagName.toLowerCase() === "gem-menu-item");
      return opts.length > 0 ? opts : null;
    }, 4000, 150) || [];

    if (menuOptions.length === 0) {
      console.log("[Argon-Bridge] No menu options rendered; dismissing.");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      throw new Error("Не удалось открыть выпадающее меню выбора модели в Gemini.");
    }

    // Parse options with availability and rate limit awareness
    const parsedOptions = menuOptions.map((opt, idx) => {
      const fullText = (opt.innerText || opt.textContent || "").trim();
      const textLower = fullText.toLowerCase();
      const available = isItemAvailable(opt);

      let modelType = "other";
      if (textLower.includes("argon") || textLower.includes("аргон")) modelType = "argon";
      else if (textLower.includes("pro") || textLower.includes("про")) modelType = "pro";
      else if (textLower.includes("3.8 flash")) modelType = "flash";
      else if (textLower.includes("flash-lite") || textLower.includes("lite")) modelType = "flash-lite";

      return { element: opt, text: fullText, modelType, available, idx };
    });

    console.log("[Argon-Bridge] Parsed model menu options:", JSON.stringify(parsedOptions.map(p => ({
      idx: p.idx,
      type: p.modelType,
      available: p.available,
      text: p.text.replace(/\n/g, " ")
    })), null, 2));

    let chosen = null;

    if (isProOrArgon) {
      const argonOpt = parsedOptions.find(o => o.modelType === "argon");
      if (!argonOpt) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(200);
        throw new Error("Модель Gemini 4 Argon не найдена в списке моделей интерфейса Gemini.");
      }

      if (!argonOpt.available) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(200);
        const resetMatch = argonOpt.text.match(/(?:обновится|resets?)[^\n]*/i);
        const resetInfo = resetMatch ? ` (${resetMatch[0].trim()})` : "";
        throw new Error(`Модель Gemini 4 Argon недоступна: исчерпан лимит запросов${resetInfo}. Запрос отклонён мостом без отправки.`);
      }

      chosen = argonOpt;
    } else {
      chosen = parsedOptions.find(o => (o.modelType === "flash" || o.modelType === "flash-lite") && o.available) 
            || parsedOptions.find(o => o.available);
      if (!chosen) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(200);
        throw new Error("Нет доступных моделей для выполнения запроса.");
      }
    }

    if (chosen) {
      if (chosen.element.classList.contains("selected")) {
        console.log(`[Argon-Bridge] Option ${chosen.modelType} is already selected in menu; dismissing.`);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(200);
      } else {
        console.log(`[Argon-Bridge] Selecting option: ${chosen.text.replace(/\n/g, " ")} (type: ${chosen.modelType})`);
        triggerClick(chosen.element);
        await sleep(600);
      }
      const afterBtn = findModelPickerButton();
      const afterText = afterBtn ? (afterBtn.innerText || afterBtn.textContent || "").toLowerCase() : "";
      console.log("[Argon-Bridge] Active model is now:", afterText);
      if (isProOrArgon && !afterText.includes("argon") && !afterText.includes("аргон")) {
        throw new Error(`Не удалось переключить модель на Gemini 4 Argon (активна: ${afterText || "Flash"}). Запрос отклонён.`);
      }
    } else {
      console.log("[Argon-Bridge] No selectable option found; dismissing menu.");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(200);
      throw new Error("Не удалось активировать модель Gemini 4 Argon.");
    }
  }

  // 3. Input Injection & Sending
  function findInputField() {
    const selectors = [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'div.ql-editor',
      'textarea[aria-label*="prompt" i]',
      'textarea'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
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
      console.log("[Argon-Bridge] execCommand fallback to innerText...");
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
      console.log("[Argon-Bridge] Overriding previous request for new request:", req.id);
    }
    isExecuting = true;
    console.log(`[Argon-Bridge] Starting execution for request ${req.id}...`);

    try {
      // Step A: Locate input field first so we know the prompt area is fully loaded
      const inputEl = await waitForCondition(() => findInputField(), 15000, 300);
      if (!inputEl) {
        throw new Error("Could not find Gemini chat input field.");
      }

      // Step B: Ensure model selector is on Argon (throws immediately if Argon is unavailable)
      await ensureModelSelected(req.model);

      // Step C: Record baseline state before prompt submission
      const allResponsesBefore = Array.from(
        document.querySelectorAll('model-response, message-content, .model-response-text, [data-test-id*="model-response"]')
      );
      const initialResponseCount = allResponsesBefore.length;
      const previousLastEl = allResponsesBefore[allResponsesBefore.length - 1] || null;

      // Step D: Inject prompt into input
      await injectPrompt(inputEl, req.prompt);

      // Step E: Locate and click Send button
      const sendBtn = await waitForCondition(() => findSendButton(), 5000, 200);
      if (!sendBtn) {
        console.log("[Argon-Bridge] Send button not found; sending Enter key...");
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      } else {
        console.log("[Argon-Bridge] Clicking Send button...");
        sendBtn.click();
      }

      // Step F: Wait for response generation to complete
      console.log("[Argon-Bridge] Waiting for Gemini response generation...");
      const maxWaitMs = (req.timeout_secs || 240) * 1000;
      const startTime = Date.now();
      let lastText = "";
      let stableCount = 0;
      let hasStarted = false;

      while (Date.now() - startTime < maxWaitMs) {
        await sleep(700);

        const stopBtn = findStopButton();
        const currentResponses = Array.from(
          document.querySelectorAll('model-response, message-content, .model-response-text, [data-test-id*="model-response"]')
        );
        const currentLastEl = currentResponses[currentResponses.length - 1] || null;

        // Has generation started?
        if (stopBtn || currentResponses.length > initialResponseCount || (currentLastEl && currentLastEl !== previousLastEl)) {
          hasStarted = true;
        }

        if (hasStarted) {
          const curText = currentLastEl ? (currentLastEl.innerText || "").trim() : "";

          // Generation has started. Now check if it has finished:
          // Stop button must be GONE and text must have content (> 0 chars)
          if (!stopBtn && curText.length > 0) {
            if (curText === lastText) {
              stableCount++;
              if (stableCount >= 2) { // 1.4s of stability
                console.log("[Argon-Bridge] Response complete! Length:", curText.length);
                break;
              }
            } else {
              stableCount = 0;
              lastText = curText;
            }
          } else {
            stableCount = 0;
            lastText = curText;
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
          console.log("[Argon-Bridge] Triggering native Copy button...");
          copyBtn.click();
          const waitStart = Date.now();
          while (Date.now() - waitStart < 500 && !capturedMarkdownFromPage) {
            await sleep(50);
          }
          if (capturedMarkdownFromPage && capturedMarkdownFromPage.trim().length > 0) {
            markdown = capturedMarkdownFromPage.trim();
            console.log("[Argon-Bridge] Captured Markdown via MainWorld interceptor! Bytes:", markdown.length);
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

      // Prepend model rate-limit warning if fallback occurred
      if (activeModelNotice && markdown && markdown.length > 0) {
        markdown = `> ⚠️ **Argon-Bridge:** ${activeModelNotice}\n\n` + markdown;
      }

      const finalUrl = window.location.href;
      console.log("[Argon-Bridge] Execution successful. URL:", finalUrl);

      port.postMessage({
        action: "PROMPT_FINISHED",
        id: req.id,
        status: "SUCCESS",
        content: markdown,
        chat_url: finalUrl,
        error: null
      });

    } catch (err) {
      console.log("[Argon-Bridge] Prompt rejected / execution stopped:", err.message || err);
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

  const heartbeatTimer = setInterval(() => {
    if (!isContextValid()) {
      clearInterval(heartbeatTimer);
      return;
    }
    if (!port) {
      connectPort();
    } else {
      sendStatusSync();
    }
  }, 10000);

})();
