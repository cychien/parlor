import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";

export function workspaceOf(workspaceRoot: string, appOrigin: string): string {
  return join(workspaceRoot, new URL(appOrigin).host.replaceAll(":", "-"));
}

export function appServerOf(appName: string): string {
  const name = appName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "app";
}

export function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
      }).trim();
      if (name) return name;
    } catch {}
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
