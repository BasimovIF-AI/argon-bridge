# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2026-10-23

### Added
- **Chrome Extension (v0.2.6)**:
  - Strict model selector targeting custom component `<gem-menu-item>`.
  - Rate-limit awareness: checks `aria-disabled="true"` and limit reset times (`Лимит обновится ...`).
  - Strict "Argon Only" policy: immediately rejects with clear error reason if Argon is rate-limited without sending prompt to fallback models.
  - Silent on-demand tab resolution: eliminates duplicate tabs on reload/startup and only opens a tab if none exists in browser.
  - Multi-turn conversation tracking: detects new response turns and tracks text stability until stop button disappears.
  - Context invalidation safety: suppresses Chrome warnings on extension reload.

## [0.1.0] - 2026-10-23

### Added
- **Rust Core (`gemini-bridge`)**:
  - Asynchronous multi-threaded daemon built with Tokio and Tokio-Tungstenite.
  - WebSocket hub on `127.0.0.1:8765` for communicating with Chrome Extension.
  - Native Model Context Protocol (MCP) server over `stdio` for Antigravity integration.
  - CLI client subcommand `ask` with support for prompt files and conversation mapping.
  - Thread-safe session management with atomic `sessions.json` persistence.
- **Chrome Extension (Manifest V3)**:
  - Background service worker maintaining auto-reconnecting WebSocket connection to Rust daemon.
  - Content script injecting into `gemini.google.com` to control model selection (Gemini 4 Argon), input dispatching, and response extraction via MutationObserver.
  - Extension popup with connection status and diagnostics.
- **DevOps & Standards**:
  - `build.ps1` automated release packager (binary compilation, source zip archive, versioning).
  - Strict deny-all `.gitignore`.
  - Comprehensive documentation (`AGENTS.md`, `ARCHITECTURE.md`, `README.md`).
