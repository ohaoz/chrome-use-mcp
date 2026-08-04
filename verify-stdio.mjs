// Simulate EXACTLY what an MCP client does: spawn bin/codex-chrome-mcp.js as
// an MCP stdio server, initialize, list tools, then drive a real CDP
// round-trip. Proves the packaged entry point (not just the imported modules)
// works. Client resolution mirrors verify-cdp.mjs: env override, else the
// newest vendored client, else the server's auto-detection.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function findVendoredClient(root) {
  try {
    // Lexicographic sort is enough for the YY.WWW.BUILD version scheme.
    const dirs = readdirSync(path.join(root, "vendor"))
      .filter((n) => n.startsWith("chrome-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const c = path.join(root, "vendor", d, "scripts", "browser-client.mjs");
      if (existsSync(c)) return c;
    }
  } catch {}
  return null;
}

const env = { ...process.env, CODEX_CHROME_SESSION_NAME: "🧪 stdio verify" };
if (!env.CODEX_CHROME_CLIENT) {
  const vendored = findVendoredClient(repoRoot);
  if (vendored) env.CODEX_CHROME_CLIENT = vendored;
}

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(repoRoot, "bin", "codex-chrome-mcp.js")],
  env,
});

const client = new Client({ name: "verify-stdio", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

function txt(res) {
  return (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args ?? {} });
  const out = txt(res);
  console.log(`\n=== ${name} ${JSON.stringify(args ?? {})} ===`);
  console.log((out.length > 700 ? out.slice(0, 700) + " ...[truncated]" : out) + (res.isError ? "  <isError>" : ""));
  return { out, isError: !!res.isError };
}

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log("tools/list ->", names.join(", "));
console.log("has cdp_send:", names.includes("cdp_send"), "| has cdp_events:", names.includes("cdp_events"));

await call("name_session", { name: "🧪 stdio verify" });
await call("new_tab", { url: "https://example.com" });
const cap = await call("browser_exec", { code: "return (await tab.capabilities.list()).map(c=>c.id);" });
const evalRes = await call("cdp_send", {
  method: "Runtime.evaluate",
  params: { expression: "document.title", returnByValue: true },
});
await call("finalize", {});

await client.close();

const ok = cap.out.includes("cdp") && /Example Domain/i.test(evalRes.out) && !evalRes.isError;
console.log("\n" + (ok ? "STDIO E2E PASSED (cdp advertised + Runtime.evaluate ok)" : "STDIO E2E FAILED"));
process.exit(ok ? 0 : 1);
