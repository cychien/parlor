import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";

/** The agents' working directory for an app: its host, with the port's `:` as `-`. */
export function workspaceOf(workspaceRoot: string, appOrigin: string): string {
  return join(workspaceRoot, new URL(appOrigin).host.replaceAll(":", "-"));
}

/** The MCP server the agent sees for an app: its name in lower case, `hello` for Hello. */
export function appServerOf(appName: string): string {
  const name = appName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "app";
}

/** The name the sidebar shows: the Mac's own name, as `scutil --get ComputerName` gives it. */
export function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
      }).trim();
      if (name) return name;
    } catch {
      // Fall back to the network name.
    }
  }
  return hostname();
}

const PLATFORMS: Readonly<Record<string, string>> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux",
};

export function platformName(): string {
  return PLATFORMS[process.platform] ?? process.platform;
}
