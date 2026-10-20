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
