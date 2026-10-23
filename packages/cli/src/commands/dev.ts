import { loadParlorConfig } from "@parlor/config";
import { inspectServerEntry } from "@parlor/scaffold";
import { defineCommand } from "citty";

import { startDevAgentHost } from "../agent-host-process.js";
import { CliError } from "../errors.js";
import { handlers } from "../handlers.js";
import { parseTarget, resolveHandler } from "../targets.js";

export function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CliError(`Invalid --port "${String(value)}"`);
  }
  return port;
}

export const dev = defineCommand({
  meta: { name: "dev", description: "Run the app in development mode" },
  args: {
    target: {
      type: "string",
      description: "web | ios | android | mac | windows | linux",
      default: "web",
    },
    port: { type: "string", description: "Override web.port from parlor.config.ts" },
    device: {
      type: "string",
      description: "Simulator or device name for ios and android",
    },
    "agent-host": {
      type: "boolean",
      default: true,
      description: "Serve the chat with this computer's agents (--no-agent-host to skip)",
    },
  },
  async run({ args }) {
    const target = parseTarget(args.target);
    const handler = resolveHandler(handlers, target);
    const loaded = await loadParlorConfig();
    const port = parsePort(args.port);
    const server = await inspectServerEntry(loaded.rootDir, loaded.config.server.entry);
    startDevAgentHost(loaded, {
      enabled: args["agent-host"],
      serverHasAuth: server.auth === "installed",
    });
    await handler.dev(
      port === undefined
        ? loaded
        : {
            ...loaded,
            config: { ...loaded.config, web: { ...loaded.config.web, port } },
          },
      { device: args.device },
    );
  },
});
