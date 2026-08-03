# vendor/ — bring your own browser-client

This directory is **intentionally empty in git**. The Codex/ChatGPT Chrome plugin's
`browser-client.mjs` bundle is OpenAI's proprietary code and is **not redistributed**
with this repo (see the Disclaimer in the top-level README).

To populate it on your machine, copy a bundle from your local plugin cache:

```
~/.codex/plugins/cache/openai-bundled/chrome/<version>/
```

into `vendor/chrome-<version>/`, keeping the `scripts/` and `docs/` directories
together (both are required — `browser_documentation` reads `docs/`).

Then point the MCP server at it via `CODEX_CHROME_CLIENT`:

```
vendor/chrome-<version>/scripts/browser-client.mjs
```

Notes:

- Raw CDP (`cdp_send` / `cdp_events`) requires a **26.727+** client; cache clients
  ≤ 26.715 do not expose the `cdp` tab capability.
- Without a vendored client, the server auto-detects the newest cache client and
  everything except raw CDP works.
