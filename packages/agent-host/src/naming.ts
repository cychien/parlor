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

/** Why this computer cannot connect to an app yet; undefined on macOS. */
export function unsupportedHostPlatform(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "darwin") return undefined;
  const name =
    ({ win32: "Windows", linux: "Linux" } as const)[platform as string] ?? platform;
  return `Parlor Host connects to apps from macOS only for now; ${name} is not supported yet, because it keeps its keys in the macOS Keychain. \`parlor dev\` works on every platform.`;
}
