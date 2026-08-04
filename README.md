# Codex Chrome MCP

**English** | [中文](README_CN.md)

Exposes Codex's **Chrome ("Control Chrome with Codex") plugin** as an MCP server, so any MCP client (Cursor, Claude Code, etc.) can drive your **real, logged-in Chrome** — navigate, snapshot the DOM, click, type, screenshot, run Playwright, and more.

This is the browser-control sibling of [`codex-cua-mcp`](https://github.com/RS-Nocsi/codex-cua-mcp) (which wraps Codex Computer Use).

## How it works

Unlike Computer Use (a self-contained `.exe`), the Chrome plugin is a Node bundle (`browser-client.mjs`) that talks to Chrome through a Codex-owned native pipe and the Codex Chrome extension:

```
MCP client (Cursor, ...)
  ↓ MCP (stdio)
codex-chrome-mcp  ──imports──▶ <Codex plugin cache>/chrome/<ver>/scripts/browser-client.mjs
  ↓ named pipe  \\.\pipe\codex-browser-use\<uuid>
extension-host.exe  ↔  Codex Chrome extension (hehggadaopoacecdllhhajmbjkdcmajg)
  ↓
your Chrome tabs
```

This server provides the host-environment shims that the Codex `node_repl` normally supplies (privileged pipe bridge, per-turn metadata, security mode, approval callback, fetch) and then reuses the **official** browser-client, so the API always matches your installed plugin.

## Requirements

- Windows 10/11
- Node.js 18+
- **ChatGPT desktop (formerly Codex Desktop) with the "Chrome" plugin installed** ("Control Chrome with ChatGPT"; compatibility identifiers keep the Codex-era names — `~/.codex`, `codex-browser-use`, …). The plugin's `browser-client.mjs` must exist under `~/.codex/plugins/cache/openai-bundled/chrome/…`, or use the vendored client under `vendor/` (required for raw CDP, see below).
- A live `codex-browser-use` pipe — created by the extension/host. In practice, keep the ChatGPT desktop app running and Chrome open with its extension enabled.

## Install

See [INSTALL.md](INSTALL.md). In short: `npm install && npm run build`, then register `node <repo>/bin/codex-chrome-mcp.js` as a stdio MCP server.

## Tools

| Tool | Description |
|------|-------------|
| `browser_documentation` | Full live API reference for `browser`/`tab` (read before `browser_exec`). |
| `browser_exec` | Run arbitrary async JS against the API (`agent`, `browser`, `tabs`, `user`, `tab` in scope). Full-power escape hatch. |
| `list_user_tabs` | List the user's real open Chrome tabs. |
| `list_tabs` | List tabs controlled by this session. |
| `new_tab` | Create a controlled tab (optionally navigate). |
| `claim_tab` | Take control of an existing user tab. |
| `goto` | Navigate the active tab to a URL. Auto-restores the previous page if a failed navigation leaves a `chrome-error://` page. |
| `snapshot` | url + title + node-id DOM (`get_visible_dom`); warns on `chrome-error://` pages. |
| `screenshot` | Screenshot the active tab. |
| `click` | Click by node_id, selector, text, or x/y. |
| `type_text` | Type text (optionally fill a selector). |
| `press_key` | Press a key/chord. |
| `scroll` | Scroll by delta / into a container (`node_id`) / wheel at `x`+`y` / `scrollIntoView` a `selector`. Returns before/after position, `pageHeight`, `nearBottom`. |
| `eval_js` | Evaluate JS in the page via Playwright's hardened read-only sandbox (no fetch/XHR/DOM writes); warns on `chrome-error://` pages. |
| `fetch_url` | ⚠️ Known-incompatible with the `extension` backend this bridge targets: `tabs.content` is marked `unsupportedByDefaultIn: extension` in the 26.727 API docs, so it fails with `browser.tabs.content is not a function`. Use Node `fetch` inside `browser_exec` (public URLs) or `goto` + `eval_js` (authenticated pages) instead. |
| `get_console_logs` | Read the tab's console logs. |
| `cdp_send` | Send a raw Chrome DevTools Protocol command to the tab or an attached child target (developer mode). See [Raw CDP](#raw-cdp-developer-mode). |
| `cdp_events` | Read buffered CDP events with cursor paging (`{ cursor, events, hasMore, truncated }`). See [Raw CDP](#raw-cdp-developer-mode). |
| `name_session` | Name the browser session. |
| `finalize` | Clean up session tabs (optionally keep some). |

## Raw CDP (developer mode)

`cdp_send` / `cdp_events` expose the tab's `cdp` capability — raw Chrome DevTools Protocol for developer/debugging work (network interception, emulation, profiling, breakpoints). Upstream's own guidance applies: prefer the higher-level tools for ordinary automation.

Requirements — all three must hold, otherwise the tools fail with `Capability is not available: cdp`:

1. A **26.727+ browser-client**: only 26.727+ injects the `cdp` tab capability (the plugin cache currently ships `26.715.31925`, which lacks it). This repo vendors a working client at `vendor/chrome-26.727.51351/`; point `CODEX_CHROME_CLIENT` at its `scripts/browser-client.mjs` and keep the `scripts/` and `docs/` siblings together (else `browser_documentation` breaks).
2. **`full_cdp_access_enabled = true`** in `~/.codex/browser/config.toml` — the client's full-CDP gate reads it through the shim's `nodeRepl.config` surface (`src/runtime.ts`).
3. The tab is on an **http(s) origin**: navigate first; raw CDP is scoped to the tab's current web origin.

Behavior:

- The first `cdp_send` auto-attaches the debugger extension-side; Chrome shows its "started debugging" bar. Event domains (`Page`, `Network`, …) emit nothing until their `.enable` command is sent.
- To observe events for an action: take a cursor with `cdp_events`, perform the action, then read from that cursor with `after_sequence`; page while `hasMore` is true (`truncated` means older events were evicted; reuse the same filters while paging).
- Child targets (iframes, workers): discover selectors from `Target.attachedToTarget` events, then pass `session_id` or `target_id`.

Guardrails enforced upstream (some commands are refused with guidance):

- No top-level `Document` interception — intercept sub-resources or page-initiated requests instead.
- `Fetch.enable` patterns must name an explicit non-`Document` `resourceType` (`XHR`, `Fetch`, `Script`, …); an unscoped pattern implicitly includes `Document` and is rejected.
- No `Fetch.disable` — clear interception with `Fetch.enable({ patterns: [] })`.
- Breakpoints: a pause blocks the `Runtime.evaluate` that triggered it. Trigger fire-and-forget (`awaitPromise: false`, or wrap in `setTimeout(fn, 0)`), then poll `Debugger.paused`, inspect with `Debugger.evaluateOnCallFrame`, and `Debugger.resume`.

Verification harnesses (repo root): `node verify-cdp.mjs` runs the built modules end to end (capability injection, auto-attach, `Runtime.evaluate`, event paging); `node verify-stdio.mjs` spawns `bin/codex-chrome-mcp.js` over stdio exactly as an MCP client does. Verified end to end 2026-08-04 against the vendored 26.727 client.

## Configuration (env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEX_CHROME_CLIENT` | auto-detected | Absolute path to `browser-client.mjs`. Auto-detection (cache `latest` → native-host manifests → newest cache dir) currently resolves `26.715.31925`, which has no `cdp` capability — pin `vendor/chrome-26.727.51351/scripts/browser-client.mjs` for raw CDP. |
| `CODEX_HOME` | `~/.codex` | Codex home directory. |
| `CODEX_CHROME_BROWSER` | `extension` | Backend id: `extension`, `iab`, `cdp`, or a specific id. |
| `CODEX_CHROME_SECURITY_MODE` | `disabled-for-local-testing` | `""` re-enables Codex's consent checks. |
| `CODEX_CHROME_AUTO_APPROVE` | `true` | Auto-approve elicitation prompts. |
| `CODEX_CHROME_SESSION_NAME` | `🔎 Cursor` | Session name shown in the UI. |

## Caveats

- Not self-contained/redistributable: it reuses the proprietary plugin from your machine and is tied to the installed plugin version.
- Requires a live `codex-browser-use` pipe (generally the ChatGPT desktop app + the Chrome extension active).
- May share/contend with the app's own browser session; behavior can change across app/plugin updates.
- Raw CDP attaches Chrome's debugger to the tab (visible "started debugging" bar), is scoped to the tab's current web origin, and upstream refuses some commands (see [Raw CDP](#raw-cdp-developer-mode)). If CDP changes page/browser state beyond ordinary navigation and the change is left in place, upstream guidance is to tell the user what changed.

## Disclaimer

Uses OpenAI's proprietary bundled `browser-client.mjs` at runtime; it is not redistributed here. No affiliation with OpenAI. Use at your own risk.
