import { defineCommand, runMain } from "citty";

import { runMcpProxyProcess } from "./mcp-proxy.js";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

const connect = defineCommand({
  meta: { name: "connect", description: "Connect this computer to a Parlor app" },
  args: { url: { type: "positional", required: true, description: "The app's URL" } },
  // TODO: ensureService(paths, { kind: "cli", release }), then control `connect`, asking
  //   this session's questions with terminalPrompter.
  run: notImplemented,
});

const disconnect = defineCommand({
  meta: { name: "disconnect", description: "Disconnect this computer from a Parlor app" },
  args: { url: { type: "positional", required: true, description: "The app's URL" } },
  run: notImplemented,
});

const status = defineCommand({
  meta: { name: "status", description: "Show connected apps, agents and running turns" },
  run: notImplemented,
});

const daemon = defineCommand({
  meta: { name: "daemon", description: "Run the background host, started at login" },
  args: {
    ensure: {
      type: "boolean",
      description: "Adopt, install or upgrade the per-user service, then exit",
    },
  },
  run: notImplemented,
});

const dev = defineCommand({
  meta: { name: "dev", description: "Serve a local `parlor dev` server" },
  args: {
    app: { type: "string", required: true, description: "http://localhost:<port>" },
  },
  // TODO: POST <app>/_parlor/dev-auth/host for a dev host token; control `dev_attach` to a
  //   running daemon, else an in-process daemon with DEV_POLICY, devHostKeys and an
  //   in-memory grant whose workspace is the app's directory; detach on exit.
  run: notImplemented,
});

const mcpProxy = defineCommand({
  meta: { name: "mcp-proxy", description: "Internal: an agent's stdio MCP server" },
  run: () => runMcpProxyProcess(process.env),
});

await runMain(
  defineCommand({
    meta: {
      name: "parlor-host",
      description: "Run your own agents for your Parlor apps",
    },
    subCommands: { connect, disconnect, status, daemon, dev, "mcp-proxy": mcpProxy },
  }),
);
