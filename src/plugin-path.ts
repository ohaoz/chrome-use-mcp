// Locates the Codex "chrome" plugin's browser-client.mjs on this machine.
// The chrome plugin is not self-contained: it ships as a proprietary Node
// bundle inside the Codex plugin cache. We reuse whatever version is installed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function fromNativeHostsV1(home: string): string | null {
  try {
    const p = path.join(home, "chrome-native-hosts.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    const hosts = Array.isArray(data?.chromeNativeHosts) ? data.chromeNativeHosts : [];
    const sorted = [...hosts].sort((a, b) =>
      String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")),
    );
    for (const h of sorted) {
      const c = h?.browserClientPath;
      if (typeof c === "string" && existsSync(c)) return c;
    }
  } catch {}
  return null;
}

function fromNativeHostsV2(home: string): string | null {
  try {
    const p = path.join(home, "chrome-native-hosts-v2.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const sorted = [...entries].sort((a, b) =>
      String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")),
    );
    for (const e of sorted) {
      const c = e?.paths?.browserClientPath;
      if (typeof c === "string" && existsSync(c)) return c;
    }
  } catch {}
  return null;
}

function newestVersionDir(home: string): string | null {
  try {
    const base = path.join(home, "plugins", "cache", "openai-bundled", "chrome");
    const versions = readdirSync(base)
      .filter((name) => name !== "latest")
      .map((name) => path.join(base, name))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
    // Sort by directory mtime, newest first (version strings are not lexicographically safe).
    versions.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const dir of versions) {
      const c = path.join(dir, "scripts", "browser-client.mjs");
      if (existsSync(c)) return c;
    }
  } catch {}
  return null;
}

export function resolveBrowserClient(): string {
  const override = process.env.CODEX_CHROME_CLIENT?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CODEX_CHROME_CLIENT does not exist: ${override}`);
    }
    return override;
  }

  const home = codexHome();

  const latest = path.join(
    home,
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "latest",
    "scripts",
    "browser-client.mjs",
  );
  if (existsSync(latest)) return latest;

  return (
    fromNativeHostsV1(home) ??
    fromNativeHostsV2(home) ??
    newestVersionDir(home) ??
    (() => {
      throw new Error(
        "Could not locate Codex chrome plugin browser-client.mjs. Is the Codex Desktop 'Chrome' plugin installed? " +
          "Set CODEX_CHROME_CLIENT to the absolute path of scripts/browser-client.mjs to override.",
      );
    })()
  );
}
