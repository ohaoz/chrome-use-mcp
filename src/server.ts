// Tool surface for the Codex Chrome MCP. Convenience tools cover the common
// browser actions; browser_exec is the full-power escape hatch that runs
// arbitrary JS against the live `browser`/`tab` API (read browser_documentation
// for the complete surface).

import { runtime, safeStringify } from "./runtime.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: safeStringify(data) }] };
}

function imageContent(bytes: Uint8Array): { type: "image"; data: string; mimeType: string } {
  const mime =
    bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime };
}

async function tabInfo(tab: any) {
  const [url, title] = await Promise.all([
    tab.url().catch(() => undefined),
    tab.title().catch(() => undefined),
  ]);
  return { id: tab.id, url, title };
}

/**
 * The page's own view of its URL (location.href). After a failed navigation
 * Chrome commits chrome-error://chromewebdata/, which the extension-side
 * tab.url() may hide (it can keep reporting the attempted URL), so read it
 * from inside the page.
 */
async function readPageHref(tab: any): Promise<string | undefined> {
  try {
    const href = await tab.playwright.evaluate("location.href");
    return typeof href === "string" ? href : undefined;
  } catch {
    return undefined;
  }
}

function isErrorPageUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("chrome-error://");
}

const ERROR_PAGE_WARNING =
  "WARNING: this tab is on a Chrome error page (chrome-error://) left behind by a failed navigation. " +
  "Page results here are empty/meaningless. Use goto with a valid URL first.";

interface ScrollMetrics {
  x: number;
  y: number;
  pageHeight: number;
  viewportHeight: number;
}

/** Page-level scroll position + document size, measured inside the page. */
async function readScrollMetrics(tab: any): Promise<ScrollMetrics | null> {
  try {
    const m = await tab.playwright.evaluate(
      "({ x: window.scrollX, y: window.scrollY, pageHeight: document.documentElement ? document.documentElement.scrollHeight : 0, viewportHeight: window.innerHeight })",
    );
    if (m && typeof m.y === "number" && typeof m.x === "number") return m as ScrollMetrics;
  } catch {
    /* e.g. error pages; caller degrades gracefully */
  }
  return null;
}

/** Build a CDP target selector ({ sessionId } | { targetId }) from tool args. */
function cdpTarget(args: Record<string, any>): { sessionId: string } | { targetId: string } | undefined {
  if (args.session_id != null) return { sessionId: String(args.session_id) };
  if (args.target_id != null) return { targetId: String(args.target_id) };
  return undefined;
}

/**
 * Resolve the tab's `cdp` capability, turning the raw "not available" error
 * into actionable guidance (the capability is only advertised when the
 * browser-client supports it and full CDP access is enabled).
 */
async function getCdp(tab: any): Promise<any> {
  try {
    return await tab.capabilities.get("cdp");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message}. Raw CDP requires a browser-client that advertises the "cdp" tab capability ` +
        `(26.727+), full CDP access enabled in ~/.codex/browser/config.toml (full_cdp_access_enabled = true), ` +
        `and a tab on an http(s) origin. Check tab.capabilities via browser_exec: ` +
        `\`return await tab.capabilities.list()\`.`,
    );
  }
}

export function getTools(): ToolDefinition[] {
  return [
    {
      name: "browser_documentation",
      description:
        "Return the full Codex Chrome (browser use) API reference for the live `browser`/`tab` object graph. Read this before writing browser_exec code.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_exec",
      description:
        "Run arbitrary async JavaScript against Codex's Chrome API. In scope: `agent`, `browser`, `tabs` (=browser.tabs), `user` (=browser.user), `tab` (current or selected tab, else null), `console`, `log`. Use `return` to produce a JSON result; images returned/emitted are attached. Code runs in the MCP server's Node process: Node APIs like `fetch` work here (no browser cookies), while in-page JS must go through `tab.playwright.evaluate` (sandboxed, see eval_js). This is the full-power escape hatch.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Async function body. e.g. `return await tab.title();`" },
          tab_id: { type: "string", description: "Optional tab id to bind as `tab`." },
        },
        required: ["code"],
      },
    },
    {
      name: "list_user_tabs",
      description:
        "List the user's real open Chrome tabs (across windows), newest first. Use an entry's id with claim_tab to take control.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_tabs",
      description: "List tabs currently controlled by this browser session.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "new_tab",
      description: "Create a new controlled tab (optionally navigate to url) and make it the active tab.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Optional URL to open." } },
      },
    },
    {
      name: "claim_tab",
      description:
        "Take control of one of the user's existing Chrome tabs (id from list_user_tabs) and make it the active tab.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Tab id from list_user_tabs." } },
        required: ["id"],
      },
    },
    {
      name: "goto",
      description: "Navigate the active tab (or tab_id) to a URL. Creates a tab if none is active.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
        required: ["url"],
      },
    },
    {
      name: "snapshot",
      description:
        "Return the active tab's url, title, and a filtered DOM listing interactable elements with node ids. Use a node_id with the click tool.",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "string", description: "Optional tab id." } },
      },
    },
    {
      name: "screenshot",
      description: "Capture a screenshot of the active tab (or tab_id).",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "string", description: "Optional tab id." },
          full_page: { type: "boolean", description: "Capture full page instead of viewport." },
        },
      },
    },
    {
      name: "click",
      description:
        "Click on the active tab. Prefer node_id (from snapshot) or x+y (viewport coordinates); selector/text use Playwright and may be less reliable when Codex shares the page.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "DOM node id from a visible-dom snapshot." },
          selector: { type: "string", description: "CSS selector." },
          text: { type: "string", description: "Visible text to match." },
          x: { type: "number", description: "Viewport X coordinate." },
          y: { type: "number", description: "Viewport Y coordinate." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
      },
    },
    {
      name: "type_text",
      description:
        "Type text. With `selector`, fills that element; otherwise types at the current focus (click first to focus).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type." },
          selector: { type: "string", description: "Optional CSS selector to fill." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
        required: ["text"],
      },
    },
    {
      name: "press_key",
      description: "Press a key or chord at the current focus, e.g. keys=['Enter'] or ['Control','a'].",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Key names to press together.",
          },
          tab_id: { type: "string", description: "Optional tab id." },
        },
        required: ["keys"],
      },
    },
    {
      name: "scroll",
      description:
        "Scroll the active tab by a delta (positive scrollY scrolls down). By default scrolls the page reliably regardless of layout; pass node_id to scroll inside a specific scroll container, x+y to send a mouse wheel at a viewport point, or selector to scrollIntoView a specific element. Returns before/after scroll position, pageHeight, and nearBottom. On virtualized lists (e.g. Discourse post streams) use small steps (<= ~2 viewports) and extract between steps, or content will be skipped.",
      inputSchema: {
        type: "object",
        properties: {
          scrollX: { type: "number", description: "Horizontal delta (default 0)." },
          scrollY: { type: "number", description: "Vertical delta, positive = down (default 600)." },
          node_id: { type: "string", description: "Optional node id (from snapshot) of a scroll container." },
          x: { type: "number", description: "Optional viewport X for a wheel-at-point scroll." },
          y: { type: "number", description: "Optional viewport Y for a wheel-at-point scroll." },
          selector: {
            type: "string",
            description: "Optional CSS selector: scrollIntoView the first matching element instead of scrolling by delta.",
          },
          tab_id: { type: "string", description: "Optional tab id." },
        },
      },
    },
    {
      name: "eval_js",
      description:
        "Evaluate JavaScript in the page via Playwright and return the result (JSON-projected; depth<=8, strings<=200k chars). Pass an expression or `() => ...` function source as `code`; top-level await is allowed. The sandbox is READ-ONLY and stripped: DOM reads, getComputedStyle, and scrolling work, but there is NO fetch/XMLHttpRequest/network, NO DOM mutation, no setInterval, and `window` only exposes an allowlist - use fetch_url or goto for network data. Warns if the tab is on a chrome-error:// page.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Expression or function source to evaluate in the page." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
        required: ["code"],
      },
    },
    {
      name: "fetch_url",
      description:
        "Fetch rendered content for one or more URLs through the user's Chrome (their cookies/session) WITHOUT touching the active tab, via browser.tabs.content. Ideal for JSON endpoints (e.g. Discourse /t/<id>.json) or reading pages in bulk - much faster than goto+scroll+DOM scraping. content_type: 'text' (default), 'html', or 'domSnapshot'. May fail if the browser host does not support tabs_content or a content-blocker extension blocks the URL; fall back to goto + eval_js then.",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description: "http(s) URLs to fetch (keep the batch small, e.g. 1-5).",
          },
          content_type: {
            type: "string",
            enum: ["text", "html", "domSnapshot"],
            description: "Content format (default 'text').",
          },
          timeout_ms: { type: "number", description: "Per-URL timeout in ms (default 15000)." },
        },
        required: ["urls"],
      },
    },
    {
      name: "get_console_logs",
      description: "Return recent console log messages captured for the active tab.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries (default 50)." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
      },
    },
    {
      name: "cdp_send",
      description:
        "Send a raw Chrome DevTools Protocol command to the active tab (or tab_id) via the browser's `cdp` tab capability, for developer/debugging use. Navigate the tab to its intended http(s) page first; raw CDP is scoped to the tab's current web origin and attaching shows Chrome's 'started debugging' bar. Prefer the higher-level tools for ordinary automation. To observe events for an action, capture a cursor with cdp_events, send the command, then read from that cursor. Requires full CDP access to be enabled (browser/config.toml full_cdp_access_enabled=true).",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "CDP method, e.g. 'Page.navigate' or 'Runtime.evaluate'." },
          params: { type: "object", description: "CDP command params object." },
          session_id: { type: "string", description: "Attached child target sessionId (omit to target the tab itself)." },
          target_id: { type: "string", description: "Attached child targetId (alternative to session_id)." },
          timeout_ms: { type: "number", description: "Maximum command wait in milliseconds." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
        required: ["method"],
      },
    },
    {
      name: "cdp_events",
      description:
        "Read buffered Chrome DevTools Protocol events from the active tab (or tab_id) via the `cdp` tab capability. Returns { cursor, events, hasMore, truncated }. Page from each returned cursor with after_sequence while hasMore is true; truncated means older events were evicted. Discover child target selectors from Target.attachedToTarget events. Requires full CDP access enabled.",
      inputSchema: {
        type: "object",
        properties: {
          after_sequence: { type: "number", description: "Return events after this cursor; omit to start at the current position." },
          limit: { type: "number", description: "Max events to return (1-1000)." },
          methods: { type: "array", items: { type: "string" }, description: "Only return these CDP event methods (must be non-empty if given)." },
          session_id: { type: "string", description: "Filter by child target sessionId." },
          target_id: { type: "string", description: "Filter by child target targetId." },
          timeout_ms: { type: "number", description: "Wait up to this many ms for the first match." },
          tab_id: { type: "string", description: "Optional tab id." },
        },
      },
    },
    {
      name: "name_session",
      description: "Set the browser session name (shown in the Codex/Chrome UI).",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Short session name." } },
        required: ["name"],
      },
    },
    {
      name: "finalize",
      description:
        "End browser work for now, cleaning up session tabs. Optionally keep specific tabs open (status 'deliverable' or 'handoff').",
      inputSchema: {
        type: "object",
        properties: {
          keep: {
            type: "array",
            description: "Array of { tab_id, status } to keep open.",
            items: {
              type: "object",
              properties: {
                tab_id: { type: "string" },
                status: { type: "string", enum: ["deliverable", "handoff"] },
              },
              required: ["tab_id", "status"],
            },
          },
        },
      },
    },
  ];
}

export async function callTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  await runtime.start();
  runtime.beginTurn();
  const browser = runtime.getBrowser();

  switch (name) {
    case "browser_documentation":
      return text(await browser.documentation());

    case "browser_exec": {
      const { result, logs, images } = await runtime.exec(String(args.code), args.tab_id);
      const content: ToolResult["content"] = [];
      const body: string[] = [];
      if (logs.length) body.push("// logs:\n" + logs.join("\n"));
      body.push(result === undefined ? "// (no return value)" : safeStringify(result));
      content.push({ type: "text", text: body.join("\n\n") });
      for (const img of images) content.push({ type: "image", data: img, mimeType: "image/png" });
      return { content };
    }

    case "list_user_tabs":
      return json(await browser.user.openTabs());

    case "list_tabs":
      return json(await browser.tabs.list());

    case "new_tab": {
      const tab = await browser.tabs.new();
      runtime.setCurrentTab(tab);
      if (args.url) {
        try {
          await tab.goto(String(args.url));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `new_tab created tab ${tab.id} but navigating it to ${args.url} failed: ${message} ` +
              `The tab is still open (blank or on an error page); goto a valid URL to reuse it, or finalize to clean up.`,
          );
        }
      }
      return json(await tabInfo(tab));
    }

    case "claim_tab": {
      const tab = await browser.user.claimTab(String(args.id));
      runtime.setCurrentTab(tab);
      return json(await tabInfo(tab));
    }

    case "goto": {
      const tab = await runtime.resolveOrCreateTab(args.tab_id);
      const url = String(args.url);
      const prevUrl: string | undefined = await tab.url().catch(() => undefined);
      try {
        await tab.goto(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A blocked/failed navigation (e.g. net::ERR_BLOCKED_BY_CLIENT) commits
        // chrome-error://chromewebdata/ in the tab; try to restore the previous page.
        let state = "";
        const currentHref = (await readPageHref(tab)) ?? (await tab.url().catch(() => undefined));
        if (isErrorPageUrl(currentHref)) {
          if (prevUrl && /^https?:\/\//.test(prevUrl)) {
            try {
              await tab.goto(prevUrl);
              state = ` The tab landed on a chrome-error:// page and was navigated back to the previous URL (${prevUrl}).`;
            } catch {
              state = ` The tab is now stuck on a Chrome error page (${currentHref}); snapshot/eval_js there return empty results. goto a valid URL before continuing.`;
            }
          } else {
            state = ` The tab is now on a Chrome error page (${currentHref}); goto a valid URL before continuing.`;
          }
        }
        throw new Error(`goto ${url} failed: ${message}${state}`);
      }
      return json(await tabInfo(tab));
    }

    case "snapshot": {
      const tab = await runtime.resolveTab(args.tab_id);
      const [info, dom, pageHref] = await Promise.all([
        tabInfo(tab),
        tab.dom_cua.get_visible_dom(),
        readPageHref(tab),
      ]);
      if (isErrorPageUrl(pageHref) || isErrorPageUrl(info.url)) {
        return json({ ...info, pageHref, warning: ERROR_PAGE_WARNING, dom });
      }
      return json({ ...info, dom });
    }

    case "screenshot": {
      const tab = await runtime.resolveTab(args.tab_id);
      const bytes: Uint8Array = await tab.screenshot({ fullPage: !!args.full_page });
      const info = await tabInfo(tab);
      return {
        content: [
          { type: "text", text: safeStringify(info) },
          imageContent(bytes),
        ],
      };
    }

    case "click": {
      const tab = await runtime.resolveTab(args.tab_id);
      if (args.node_id != null) await tab.dom_cua.click({ node_id: String(args.node_id) });
      else if (args.x != null && args.y != null)
        await tab.cua.click({ x: Number(args.x), y: Number(args.y) });
      else if (args.selector) await tab.playwright.locator(String(args.selector)).click();
      else if (args.text) await tab.playwright.getByText(String(args.text)).click();
      else throw new Error("click requires one of: node_id, selector, text, or x+y");
      return text("clicked");
    }

    case "type_text": {
      const tab = await runtime.resolveTab(args.tab_id);
      if (args.selector) await tab.playwright.locator(String(args.selector)).fill(String(args.text));
      else await tab.cua.type({ text: String(args.text) });
      return text("typed");
    }

    case "press_key": {
      const tab = await runtime.resolveTab(args.tab_id);
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [String(args.keys)];
      await tab.cua.keypress({ keys });
      return text(`pressed ${keys.join("+")}`);
    }

    case "scroll": {
      const tab = await runtime.resolveTab(args.tab_id);
      const dx = Number(args.scrollX ?? 0);
      const dy = Number(args.scrollY ?? 600);
      const before = await readScrollMetrics(tab);

      let action: string;
      if (args.selector) {
        // Scroll a specific element into view (works for inner containers too).
        action = `scrollIntoView ${args.selector}`;
        const found = await tab.playwright.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(String(args.selector))}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "nearest" }); return true; })()`,
        );
        if (!found) throw new Error(`scroll: no element matches selector: ${args.selector}`);
      } else if (args.x != null && args.y != null) {
        // Explicit coordinate: send a mouse wheel at that viewport point.
        action = `wheel at (${args.x},${args.y}) dx=${dx} dy=${dy}`;
        await tab.cua.scroll({ x: Number(args.x), y: Number(args.y), scrollX: dx, scrollY: dy });
      } else {
        // Reliable, layout-independent page (or container) scroll by delta.
        action = args.node_id ? `container ${args.node_id} dx=${dx} dy=${dy}` : `page dx=${dx} dy=${dy}`;
        await tab.dom_cua.scroll({
          x: dx,
          y: dy,
          ...(args.node_id ? { node_id: String(args.node_id) } : {}),
        });
      }

      // Let wheel dispatch / smooth scrolling settle before measuring.
      try {
        await tab.playwright.waitForTimeout(200);
      } catch {
        /* non-fatal */
      }
      const after = await readScrollMetrics(tab);

      if (!before || !after) return text(`scrolled: ${action} (scroll position unavailable on this page)`);

      const moved = before.x !== after.x || before.y !== after.y;
      const result: Record<string, unknown> = {
        action,
        before: { x: before.x, y: before.y },
        after: { x: after.x, y: after.y },
        moved,
        pageHeight: after.pageHeight,
        viewportHeight: after.viewportHeight,
        nearBottom: after.y + after.viewportHeight >= after.pageHeight - 2,
      };
      if (!moved) {
        result.note = args.node_id || args.selector
          ? "page-level scroll position unchanged (an inner-container scroll is not reflected here; use snapshot/eval_js to verify content moved)"
          : "page did not move: the scrollable area is likely an inner container - retry with node_id (from snapshot), a selector, or x+y inside the container";
      }
      if (after.pageHeight !== before.pageHeight) {
        result.pageHeightChanged = `${before.pageHeight} -> ${after.pageHeight} (dynamic/virtualized page)`;
      }
      return json(result);
    }

    case "eval_js": {
      const tab = await runtime.resolveTab(args.tab_id);
      const code = String(args.code).trim();
      // Playwright evaluate(string) treats the string as an expression. If the
      // user passed a function form, invoke it so its return value is produced.
      const looksFn =
        /^async\b/.test(code) ||
        /^function\b/.test(code) ||
        /^\(?[\w\s,{}=]*\)?\s*=>/.test(code);
      const expr = looksFn ? `(${code})()` : code;
      // Wrap the expression so one round-trip also reports location.href
      // (detects chrome-error:// pages) and supports top-level await.
      const wrapped =
        `(async () => { const __r = await (async () => (${expr}))(); ` +
        `let __href = null; try { __href = location.href; } catch {} ` +
        `return { __evalJs: 1, has: __r !== undefined, r: __r, href: __href }; })()`;
      const raw = await tab.playwright.evaluate(wrapped);

      let result: unknown = raw;
      let href: string | undefined;
      if (raw && typeof raw === "object" && (raw as any).__evalJs === 1) {
        result = (raw as any).has ? (raw as any).r : undefined;
        href = typeof (raw as any).href === "string" ? (raw as any).href : undefined;
      }
      if (isErrorPageUrl(href)) {
        return {
          content: [{ type: "text", text: `${ERROR_PAGE_WARNING}\n\n${safeStringify(result)}` }],
        };
      }
      return json(result);
    }

    case "fetch_url": {
      const urls = (Array.isArray(args.urls) ? args.urls : [args.urls]).map(String);
      if (urls.length === 0) throw new Error("fetch_url requires at least one URL");
      const bad = urls.find((u) => !/^https?:\/\//.test(u));
      if (bad) throw new Error(`fetch_url only supports http(s) URLs, got: ${bad}`);
      const contentType = String(args.content_type ?? "text");
      const timeoutMs = Number(args.timeout_ms ?? 15000);
      const results = await browser.tabs.content({ urls, contentType, timeoutMs });
      return json(results);
    }

    case "get_console_logs": {
      const tab = await runtime.resolveTab(args.tab_id);
      const logs = await tab.dev.logs({ limit: Number(args.limit ?? 50) });
      return json(logs);
    }

    case "cdp_send": {
      const tab = await runtime.resolveTab(args.tab_id);
      const cdp = await getCdp(tab);
      const method = String(args.method);
      const params =
        args.params && typeof args.params === "object" ? args.params : undefined;
      const options: Record<string, unknown> = {};
      const target = cdpTarget(args);
      if (target) options.target = target;
      if (args.timeout_ms != null) options.timeoutMs = Number(args.timeout_ms);
      const result = await cdp.send(
        method,
        params,
        Object.keys(options).length ? options : undefined,
      );
      return json(result);
    }

    case "cdp_events": {
      const tab = await runtime.resolveTab(args.tab_id);
      const cdp = await getCdp(tab);
      const options: Record<string, unknown> = {};
      if (args.after_sequence != null) options.afterSequence = Number(args.after_sequence);
      if (args.limit != null) options.limit = Number(args.limit);
      if (Array.isArray(args.methods) && args.methods.length)
        options.methods = args.methods.map(String);
      const target = cdpTarget(args);
      if (target) options.target = target;
      if (args.timeout_ms != null) options.timeoutMs = Number(args.timeout_ms);
      const result = await cdp.readEvents(
        Object.keys(options).length ? options : undefined,
      );
      return json(result);
    }

    case "name_session":
      await browser.nameSession(String(args.name));
      return text(`session named: ${args.name}`);

    case "finalize": {
      const keepInput = Array.isArray(args.keep) ? args.keep : [];
      const keep = keepInput.map((k: any) => ({ tab: String(k.tab_id), status: k.status }));
      await browser.tabs.finalize({ keep });
      return text("finalized");
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
