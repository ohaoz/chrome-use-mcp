// Bridges Codex's bundled chrome plugin (browser-client.mjs) into a standalone
// process by shimming the host environment that the Codex node_repl normally
// provides: a privileged named-pipe bridge, per-turn metadata, a security mode,
// an elicitation (approval) callback, and a fetch for URL checks.

import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveBrowserClient, codexHome } from "./plugin-path.js";

/**
 * Minimal TOML reader for the flat key/value files Codex uses under
 * `~/.codex/browser/config.toml` (strings, booleans, ints, floats, and
 * `[section]` headers). It is intentionally small: the browser-client only
 * needs a plain object back, and the only key we care about for CDP is the
 * top-level `full_cdp_access_enabled`.
 */
function parseToml(text: string): Record<string, any> {
  const out: Record<string, any> = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      if (!out[section]) out[section] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let vs = line.slice(eq + 1).trim();
    let val: any;
    if (/^".*"$/.test(vs) || /^'.*'$/.test(vs)) {
      val = vs.slice(1, -1);
    } else {
      const hash = vs.indexOf("#");
      if (hash >= 0) vs = vs.slice(0, hash).trim();
      if (vs === "true") val = true;
      else if (vs === "false") val = false;
      else if (/^-?\d+$/.test(vs)) val = parseInt(vs, 10);
      else if (/^-?\d*\.\d+$/.test(vs)) val = parseFloat(vs);
      else val = vs;
    }
    if (section) (out[section] as Record<string, any>)[key] = val;
    else out[key] = val;
  }
  return out;
}

function resolveCodexRelative(rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(codexHome(), rel);
}

// Captured BEFORE importing browser-client, which patches process.exit to throw.
const REAL_EXIT = process.exit.bind(process);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  (...args: string[]) => (...a: any[]) => Promise<any>;

export interface ExecResult {
  result: unknown;
  logs: string[];
  images: string[]; // base64 png/jpeg data
}

class Runtime {
  private started: Promise<void> | null = null;
  private agent: any = null;
  private browser: any = null;
  private currentTab: any = null;
  private currentTabId: string | null = null;
  private pendingImages: Uint8Array[] = [];
  private pendingContentItems: string[] = [];
  private afterHooks: Array<{ timeoutMs?: number; run: () => Promise<void> | void }> = [];

  private readonly securityMode =
    process.env.CODEX_CHROME_SECURITY_MODE?.trim() ?? "disabled-for-local-testing";
  private readonly autoApprove = process.env.CODEX_CHROME_AUTO_APPROVE !== "false";
  private readonly sessionName = process.env.CODEX_CHROME_SESSION_NAME?.trim() || "🔎 Cursor";
  private readonly browserId = process.env.CODEX_CHROME_BROWSER?.trim() || "extension";
  private readonly sessionId = randomUUID();

  async start(): Promise<void> {
    if (!this.started) {
      this.started = this.init().catch((err) => {
        this.started = null;
        throw err;
      });
    }
    return this.started;
  }

  /** Refresh the turn id; call at the start of each MCP tool invocation. */
  beginTurn(): void {
    const meta = (globalThis as any).nodeRepl?.requestMeta?.["x-codex-turn-metadata"];
    if (meta) meta.turn_id = randomUUID();
  }

  private installShim(): void {
    const self = this;

    // Neutralize the plugin's Statsig telemetry (hardcoded to ab.chatgpt.com),
    // which otherwise spams stderr with ECONNREFUSED when that host is unreachable.
    if (!(globalThis as any).__codexChromeTelemetrySilenced) {
      (globalThis as any).__codexChromeTelemetrySilenced = true;
      const origFetch = (globalThis as any).fetch?.bind(globalThis);
      if (origFetch) {
        (globalThis as any).fetch = (input: any, init?: any) => {
          const url = typeof input === "string" ? input : input?.url ?? "";
          if (typeof url === "string" && (url.includes("ab.chatgpt.com") || url.includes("statsig"))) {
            return Promise.resolve(
              new Response('{"has_updates":false,"time":0}', {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return origFetch(input, init);
        };
      }
    }

    (globalThis as any).nodeRepl = {
      env: {
        BROWSER_USE_SECURITY_MODE: this.securityMode,
      },
      requestMeta: {
        "x-codex-turn-metadata": {
          session_id: this.sessionId,
          turn_id: randomUUID(),
        },
      },
      nativePipe: {
        createConnection(pipePath: string) {
          return new Promise((resolve, reject) => {
            const sock = net.createConnection(pipePath);
            const onErr = (e: unknown) => {
              sock.removeListener("connect", onOk);
              reject(e);
            };
            const onOk = () => {
              sock.removeListener("error", onErr);
              resolve(sock);
            };
            sock.once("connect", onOk);
            sock.once("error", onErr);
          });
        },
      },
      fetch: (...a: any[]) => (globalThis as any).fetch(...a),
      async createElicitation() {
        return self.autoApprove ? { action: "accept" } : { action: "decline" };
      },
      tmpDir: os.tmpdir(),
      cwd: codexHome(),
      homeDir: os.homedir(),
      // Image emission (used by the client's displayImage) and the two hooks
      // below are required by the 26.727+ client's setupBrowserRuntime, which
      // calls addAfterSubmittedCodeHook + emitContentItem UNCONDITIONALLY at
      // init (26.715 did not). Missing any of them throws
      // "addAfterSubmittedCodeHook is not a function" before the browser starts.
      async emitImage(bytes: Uint8Array) {
        self.pendingImages.push(bytes);
      },
      emitContentItem(item: unknown) {
        if (item != null && item !== "") self.pendingContentItems.push(String(item));
      },
      // Codex fires these hooks after each submitted REPL command. This bridge
      // runs each tool call as a turn, so we store hooks and flush them
      // explicitly (see flushAfterHooks) after browser_exec.
      addAfterSubmittedCodeHook(hook: {
        timeoutMs?: number;
        run: () => Promise<void> | void;
      }) {
        self.afterHooks.push(hook);
        return {
          dispose() {
            const i = self.afterHooks.indexOf(hook);
            if (i >= 0) self.afterHooks.splice(i, 1);
          },
        };
      },
      // The 26.727+ browser-client verifies "full CDP access" by reading
      // `browser/config.toml` (key `full_cdp_access_enabled`) and enterprise
      // requirements through this config surface. The Codex node_repl normally
      // provides it; we shim a read-only view plus a no-op writer so the CDP
      // tab capability is advertised without ever rewriting the user's config.
      config: {
        async readToml(rel: string) {
          try {
            return parseToml(fs.readFileSync(resolveCodexRelative(rel), "utf8"));
          } catch {
            return {};
          }
        },
        // No-op: consent persistence is optional (createElicitation auto-accepts),
        // and we must never risk clobbering the real config.toml.
        async writeToml() {
          return;
        },
        // No enterprise policy in this local bridge; `{ requirements: null }`
        // makes both the full-CDP gate and the site-policy path pass cleanly.
        async readRequirements() {
          return { requirements: null };
        },
        async read() {
          return {};
        },
      },
      setResponseMeta() {},
      telemetry: null,
      console,
    };
  }

  private async init(): Promise<void> {
    this.installShim();

    const clientPath = resolveBrowserClient();
    const mod: any = await import(pathToFileURL(clientPath).href);

    // browser-client patches process.exit to throw; restore normal exit for the MCP host.
    process.exit = REAL_EXIT as typeof process.exit;

    if (typeof mod.setupBrowserRuntime !== "function") {
      throw new Error(`browser-client.mjs has no setupBrowserRuntime export: ${clientPath}`);
    }
    await mod.setupBrowserRuntime({ globals: globalThis });
    process.exit = REAL_EXIT as typeof process.exit;

    this.agent = (globalThis as any).agent;
    if (!this.agent) throw new Error("setupBrowserRuntime did not install globalThis.agent");

    this.browser = await this.agent.browsers.get(this.browserId);
    try {
      await this.browser.nameSession(this.sessionName);
    } catch {
      /* non-fatal */
    }
  }

  getAgent(): any {
    return this.agent;
  }

  getBrowser(): any {
    if (!this.browser) throw new Error("Runtime not started");
    return this.browser;
  }

  drainImages(): string[] {
    const imgs = this.pendingImages.splice(0).map((b) => Buffer.from(b).toString("base64"));
    return imgs;
  }

  drainContentItems(): string[] {
    return this.pendingContentItems.splice(0);
  }

  /**
   * Run the client's registered after-submitted-code hooks. Codex fires these
   * after each REPL command; this bridge runs each tool call as a turn, so we
   * flush them explicitly (bounded by each hook's timeout) to surface advisory
   * browser notifications and settle bookkeeping. Advisory only: never let a
   * hook failure or hang break the tool call.
   */
  async flushAfterHooks(): Promise<void> {
    for (const hook of this.afterHooks) {
      const timeoutMs =
        typeof hook.timeoutMs === "number" && hook.timeoutMs > 0 ? hook.timeoutMs : 10000;
      try {
        await Promise.race([
          Promise.resolve(hook.run()),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {
        /* advisory only; ignore */
      }
    }
  }

  setCurrentTab(tab: any, id?: string): void {
    this.currentTab = tab;
    this.currentTabId = id ?? tab?.id ?? null;
  }

  /** Resolve a tab: explicit id, else the current tab, else the selected tab. */
  async resolveTab(tabId?: string): Promise<any> {
    if (tabId) {
      const tab = await this.browser.tabs.get(tabId);
      this.setCurrentTab(tab, tabId);
      return tab;
    }
    if (this.currentTab) return this.currentTab;
    const selected = await this.browser.tabs.selected();
    if (selected) {
      this.setCurrentTab(selected);
      return selected;
    }
    throw new Error(
      "No active tab. Use new_tab, claim_tab, or goto first (or pass tab_id).",
    );
  }

  /** Resolve a tab or create a new one (for goto with no active tab). */
  async resolveOrCreateTab(tabId?: string): Promise<any> {
    if (tabId) return this.resolveTab(tabId);
    if (this.currentTab) return this.currentTab;
    const selected = await this.browser.tabs.selected();
    if (selected) {
      this.setCurrentTab(selected);
      return selected;
    }
    const tab = await this.browser.tabs.new();
    this.setCurrentTab(tab);
    return tab;
  }

  async exec(code: string, tabId?: string): Promise<ExecResult> {
    const logs: string[] = [];
    const log = (...args: any[]) =>
      logs.push(args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "));
    const scopedConsole = { ...console, log, info: log, warn: log, error: log };

    let tab: any = null;
    if (tabId) {
      tab = await this.resolveTab(tabId);
    } else {
      tab = this.currentTab;
      if (!tab) {
        // Fall back to the session's selected tab, matching resolveTab().
        try {
          const selected = await this.browser.tabs.selected();
          if (selected) {
            this.setCurrentTab(selected);
            tab = selected;
          }
        } catch {
          /* tab stays null; exec code can still use browser/tabs */
        }
      }
    }

    this.drainImages(); // clear any stale images
    const fn = AsyncFunction(
      "agent",
      "browser",
      "tabs",
      "user",
      "tab",
      "console",
      "log",
      code,
    );
    const result = await fn(
      this.agent,
      this.browser,
      this.browser.tabs,
      this.browser.user,
      tab,
      scopedConsole,
      log,
    );
    // Flush after-submitted-code hooks (advisory browser notifications, etc.).
    await this.flushAfterHooks();
    for (const item of this.drainContentItems()) logs.push(item);
    return { result, logs, images: this.drainImages() };
  }

  async stop(): Promise<void> {
    try {
      await this.browser?.tabs?.finalize?.({});
    } catch {
      /* ignore */
    }
  }
}

export function safeStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export const runtime = new Runtime();
