# AGENTS.md — Argon-Bridge Operational Manual

## 1. Mission & Objectives
**Argon-Bridge** is an ultra-fast, zero-overhead bridge between **Antigravity AI Agent** and **Google Gemini Web (`gemini.google.com`)**, specifically designed to leverage the cutting-edge **Gemini 4 Argon** reasoning & coding model directly within agentic workflows.

### Key Performance Indicators (KPIs)
- **Zero Runtime Overhead:** Written in pure Rust; < 5MB RAM consumption, < 3ms cold start for CLI commands.
- **100% Anti-Bot Resilience:** Transports prompts through an authenticated Chrome Extension running inside the user's real browser session.
- **1:1 Strict Conversation Mapping:** Each unique Antigravity `conversation_id` is deterministically mapped to a dedicated Gemini web chat session.
- **Dual Native Interface:** Exposes both Model Context Protocol (MCP stdio JSON-RPC 2.0) for seamless agent tool calling and a high-speed CLI (`argon-bridge ask`) for terminal workflows.

### Scope & Invariants
- **In-Scope:**
  - Rust daemon managing WebSocket server on `127.0.0.1:8765`.
  - Stdio JSON-RPC 2.0 MCP server for Antigravity integration.
  - Session tracker mapping `conversation_id` $\leftrightarrow$ `gemini_chat_url` persisted atomically to `sessions.json`.
  - Manifest V3 Chrome Extension automating DOM interaction on `gemini.google.com` (model selection, prompt injection, completion observation, markdown extraction).
  - Versioned release automation with `build.ps1`.
- **Non-Goals:**
  - Bypassing Google logins (requires user to be normally signed in via Chrome).
  - Heavy browser automation frameworks (no Selenium/Playwright dependencies; uses zero-overhead MV3 extension).

---

## 2. Build & Verification Commands

All build, release, and packaging tasks are automated via `build.ps1`:

```powershell
# Default debug build and verification
.\build.ps1

# Full release build: compiles optimized executable and packages archives
.\build.ps1 -Release

# Clean build artifacts
.\build.ps1 -Clean
```

### Manual Cargo Commands
```powershell
# Run unit and integration tests
cargo test

# Compile release binary
cargo build --release

# Run daemon with verbose logging
cargo run -- serve -v

# Run direct CLI prompt
cargo run -- ask --prompt "Write a quicksort in Rust"
```

---

## 3. Architecture & Invariants

### Threading & Concurrency Model
- The Rust core runs on `tokio` multi-threaded runtime.
- WebSocket server (`tokio-tungstenite`) maintains persistent bi-directional communication with the Chrome extension service worker.
- MCP Server operates over `stdin`/`stdout` using JSON-RPC 2.0. Standard logging (`tracing`) is redirected exclusively to `stderr` or rotating log files to prevent corrupting the MCP stdio stream.

### 1:1 Conversation Mapping Rule
- The bridge accepts an optional `conversation_id`. If omitted, it defaults to the active Antigravity conversation or `default`.
- When a `conversation_id` has no recorded `chat_url`, the extension triggers a clean chat on `https://gemini.google.com/app`, selects the **Gemini 4 Argon** model, submits the prompt, extracts the newly assigned chat URL, and records it in `sessions.json`.
- Subsequent prompts for that same `conversation_id` instruct the extension to navigate/stay in that chat session.

### DOM & Extension Safeguards
- Injects input using synthetic `InputEvent` and `document.execCommand` dispatching to ensure Google's Angular/React/Wiz state properly captures input.
- Observes response completion by tracking the disappearance of the Stop Generating indicator AND the presence of the bottom action bar (Copy button), eliminating false completion triggers during the **Thinking / Reasoning** phase.
- Extracts clean markdown by programmatically triggering the native "Copy response" action on Gemini and reading pristine raw Markdown directly from the clipboard, with automatic fallback to DOM parsing.
- Prevents background tab throttling in Chrome by waking up and activating the Gemini tab via `chrome.tabs.update` upon receiving prompt requests.

---

## 4. Operational Pattern: Architect (Argon) + Builder (Antigravity Agent)

When solving coding tasks in this repository:
1. **Antigravity Agent acts as the Builder (Hands):**
   - Reads files, analyzes project structure, runs linters, compiles targets, and applies code diffs.
2. **Gemini 4 Argon acts as the Chief Architect (Brain):**
   - Automatically consulted via `ask_gemini_argon` for:
     - High-level system architecture and module boundaries.
     - Tricky algorithms, concurrent data structures, or safety-critical logic.
     - Complex refactorings and thorough multi-file code reviews.
3. **Execution Flow:**
   - Builder gathers the relevant files/error logs -> sends them as `context` to `ask_gemini_argon` -> receives pristine architecture/code -> Builder breaks it down and writes it to workspace files, then runs `cargo test` / `build.ps1` to verify.
