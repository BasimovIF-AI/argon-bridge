# AGENTS.md — Gemini-Bridge Operational Manual

## 1. Mission & Objectives
**Gemini-Bridge** is an ultra-fast, zero-overhead bridge between **Antigravity AI Agent** and **Google Gemini Web (`gemini.google.com`)**, specifically designed to leverage the cutting-edge **Gemini 4 Argon** reasoning & coding model directly within agentic workflows.

### Key Performance Indicators (KPIs)
- **Zero Runtime Overhead:** Written in pure Rust; < 5MB RAM consumption, < 3ms cold start for CLI commands.
- **100% Anti-Bot Resilience:** Transports prompts through an authenticated Chrome Extension running inside the user's real browser session.
- **1:1 Strict Conversation Mapping:** Each unique Antigravity `conversation_id` is deterministically mapped to a dedicated Gemini web chat session.
- **Dual Native Interface:** Exposes both Model Context Protocol (MCP stdio JSON-RPC 2.0) for seamless agent tool calling and a high-speed CLI (`gemini-bridge ask`) for terminal workflows.

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
- Injects input using synthetic `InputEvent` dispatching to ensure Google's Angular/React/Wiz state handles the text.
- Observes response completion via `MutationObserver` on model response nodes and detects when the streaming indicator / stop button transitions to finished state.
