# Installation Guide

> Installs the **Codex Chrome MCP** — exposing Codex's "Control Chrome with Codex" plugin as MCP tools.

## Step 1 — Prerequisites

1. OS is Windows 10 or 11.
2. Node.js 18+ (`node --version`).
3. ChatGPT desktop (formerly Codex Desktop) with the **Chrome** plugin installed. Verify the bundle exists:
   `~/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs`
4. Keep the ChatGPT desktop app running and Chrome open with its extension enabled, so a `\\.\pipe\codex-browser-use\…` pipe is live.
5. *(Optional — only for raw CDP via `cdp_send`/`cdp_events`)*:
   - `full_cdp_access_enabled = true` in `~/.codex/browser/config.toml`.
   - A 26.727+ client: cache clients ≤ 26.715 do not expose the `cdp` capability, so set `CODEX_CHROME_CLIENT` to the vendored `<ABSOLUTE_REPO_PATH>/vendor/chrome-26.727.51351/scripts/browser-client.mjs` (keep its `scripts/` and `docs/` directories together).

## Step 2 — Build

From the repo root:

```bash
npm install
npm run build
```

Both must exit 0. Output goes to `dist/`.

## Step 3 — Register the MCP server

Register a **stdio** MCP server using the absolute repo path (`<ABSOLUTE_REPO_PATH>`):

- **name**: `codex-chrome`
- **command**: `node`
- **args**: `["<ABSOLUTE_REPO_PATH>/bin/codex-chrome-mcp.js"]`

Generic `mcpServers` example (use forward slashes on Windows):

```json
{
  "mcpServers": {
    "codex-chrome": {
      "command": "node",
      "args": ["<ABSOLUTE_REPO_PATH>/bin/codex-chrome-mcp.js"],
      "env": {
        "CODEX_CHROME_SESSION_NAME": "🔎 Cursor",
        "CODEX_CHROME_CLIENT": "<ABSOLUTE_REPO_PATH>/vendor/chrome-26.727.51351/scripts/browser-client.mjs"
      }
    }
  }
}
```

`env` is optional: drop `CODEX_CHROME_CLIENT` to auto-detect the cache client instead — but raw CDP (`cdp_send`/`cdp_events`) then stops working until the cache ships a 26.727+ client.

For Cursor, add it to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

## Step 4 — Verify

1. Fully restart/reload your MCP client so it loads the server.
2. Call `browser_documentation` — it should return the API reference.
3. Call `list_user_tabs` — it should return your open Chrome tabs.
4. Call `goto` with `{ "url": "https://example.com" }` — a tab should navigate.
5. *(If raw CDP is configured)* Call `cdp_send` with `{ "method": "Runtime.evaluate", "params": { "expression": "document.title", "returnByValue": true } }` on that tab — expect the page title (Chrome will show its "started debugging" bar). Or run the harnesses from the repo root: `node verify-cdp.mjs` (built modules) and `node verify-stdio.mjs` (stdio server, exactly as an MCP client spawns it).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Could not locate Codex chrome plugin browser-client.mjs" | Install/repair the ChatGPT desktop **Chrome** plugin, or set `CODEX_CHROME_CLIENT` to the absolute `browser-client.mjs` path. |
| "Browser is not available: extension" / connect errors | Ensure the ChatGPT desktop app is running and Chrome has its extension enabled (so the `codex-browser-use` pipe exists). Keep `CODEX_CHROME_BROWSER` unset or `extension`. |
| Native-module load error | Use Node 18/20/22 x64 (the plugin ships N-API prebuilds). |
| Approval prompts block actions | Leave `CODEX_CHROME_SECURITY_MODE=disabled-for-local-testing` (default) and `CODEX_CHROME_AUTO_APPROVE=true`. |
| `Capability is not available: cdp` | All three CDP requirements must hold: `CODEX_CHROME_CLIENT` → vendored `vendor/chrome-26.727.51351/scripts/browser-client.mjs` (cache clients ≤ 26.715 lack the capability), `full_cdp_access_enabled = true` in `~/.codex/browser/config.toml`, and the tab navigated to an http(s) page. Inspect with `browser_exec`: `return await tab.capabilities.list()`. |
| `fetch_url` fails: `browser.tabs.content is not a function` | Known incompatibility — `tabs.content` is unsupported on the `extension` backend. Do not retry; use Node `fetch` inside `browser_exec` (public URLs) or `goto` + `eval_js` (authenticated pages). |
