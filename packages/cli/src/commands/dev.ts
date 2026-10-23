import { loadParlorConfig } from "@parlor/config";
import { inspectServerEntry } from "@parlor/scaffold";
import { defineCommand } from "citty";

import { startDevAgentHost } from "../agent-host-process.js";
import { claimDevSession } from "../dev-session.js";
import { CliError } from "../errors.js";
import { handlers } from "../handlers.js";
import { resolveDevPorts } from "../ports.js";
import { startServerProcess, untilListening } from "../server-process.js";
import { onShutdown } from "../shutdown.js";
import { parseTargets, resolveHandler } from "../targets.js";

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
      description:
        "web | ios | android | mac | windows | linux, or several joined by commas (web,mac) to run them against one server",
      default: "web",
    },
    port: {
      type: "string",
      description:
        "Override web.port from parlor.config.ts; a busy port moves to the next free one",
    },
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
    const targets = parseTargets(args.target);
    const targetHandlers = targets.map((target) => resolveHandler(handlers, target));
    for (const handler of targetHandlers) handler.assertHost?.();
    const configured = await loadParlorConfig();
    const port = parsePort(args.port);
    const session = claimDevSession(configured.rootDir, targets);
    onShutdown(() => session.release());
    const ports = await resolveDevPorts({
      server: configured.config.server.port,
      web: port ?? configured.config.web.port,
      targets: targets.length,
    });
    const frontends = ports.web.map((web) => `http://localhost:${web}`);
    session.update(frontends);
    const main = Math.max(targets.indexOf("web"), 0);
    const appOrigin = frontends[main]!;
    const loadedFor = (web: number) => ({
      ...configured,
      config: {
        ...configured.config,
        server: { ...configured.config.server, port: ports.server },
        web: { ...configured.config.web, port: web },
      },
    });
    const shared = loadedFor(ports.web[main]!);
    const server = await inspectServerEntry(shared.rootDir, shared.config.server.entry);
    const serverProcess = startServerProcess(shared, [
      appOrigin,
      ...frontends.filter((origin) => origin !== appOrigin),
    ]);
    await untilListening(serverProcess, ports.server);
    startDevAgentHost(shared, {
      enabled: args["agent-host"],
      serverHasAuth: server.auth === "installed",
    });
    await Promise.all(
      targetHandlers.map((handler, index) =>
        handler.dev(loadedFor(ports.web[index]!), {
          device: args.device,
          appOrigin: index === main ? undefined : appOrigin,
        }),
      ),
    );
  },
});
