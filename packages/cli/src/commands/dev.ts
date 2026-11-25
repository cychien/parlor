import { loadParlorConfig } from "@parlor/config";
import { inspectServerEntry } from "@parlor/scaffold";
import { defineCommand } from "citty";

import { startDevAgentHost } from "../agent-host-process.js";
import { prepareCloudflareDev } from "../cloudflare/prepare.js";
import { claimDevSession } from "../dev-session.js";
import { CliError } from "../errors.js";
import { resolveDevPorts } from "../ports.js";
import { startServerProcess, untilListening } from "../server-process.js";
import { onShutdown } from "../shutdown.js";
import { startWeb } from "../web-target.js";

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
    port: {
      type: "string",
      description:
        "Override web.port from parlor.config.ts; a busy port moves to the next free one",
    },
    "agent-host": {
      type: "boolean",
      default: true,
      description: "Serve the chat with this computer's agents (--no-agent-host to skip)",
    },
  },
  async run({ args }) {
    const configured = await loadParlorConfig();
    const cloudflare = await prepareCloudflareDev(configured);
    const port = parsePort(args.port);
    const session = claimDevSession(configured.rootDir);
    onShutdown(() => session.release());
    const ports = await resolveDevPorts({
      server: configured.config.server.port,
      web: port ?? configured.config.web.port,
    });
    session.update(`http://localhost:${ports.web}`);
    const loaded = {
      ...configured,
      config: {
        ...configured.config,
        server: { ...configured.config.server, port: ports.server },
        web: { ...configured.config.web, port: ports.web },
      },
    };
    const server = await inspectServerEntry(loaded.rootDir, loaded.config.server.entry);
    const serverProcess = startServerProcess(loaded, cloudflare);
    await untilListening(serverProcess, ports.server);
    startDevAgentHost(loaded, {
      enabled: args["agent-host"],
      serverHasAuth: server.auth === "installed",
    });
    await startWeb(loaded);
  },
});
