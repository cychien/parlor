import { AGENT_PROFILES } from "./agents.js";
import { adapterKey, embeddedAdapters } from "./embedded.js";

async function runClaudeAdapter(): Promise<void> {
  const { applyManagedPolicyEnv } =
    await import("@agentclientprotocol/claude-agent-acp/dist/managed-policy.js");
  const { serveAcp } =
    await import("@agentclientprotocol/claude-agent-acp/dist/serve.js");
  await applyManagedPolicyEnv();
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  const acp = serveAcp(undefined, { experimentalV2: false });
  const shutdown = async () => {
    await acp.dispose().catch(() => undefined);
    process.exit(0);
  };
  void acp.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.resume();
}

async function runCodexAdapter(): Promise<void> {
  await import("@agentclientprotocol/codex-acp/dist/index.js");
}

const ADAPTERS: Readonly<Record<string, () => Promise<void>>> = {
  claude: runClaudeAdapter,
  codex: runCodexAdapter,
};

for (const profile of AGENT_PROFILES) {
  if (profile.launch.kind === "adapter" && profile.id in ADAPTERS) {
    embeddedAdapters.set(adapterKey(profile.launch), profile.id);
  }
}

async function main(): Promise<void> {
  const [command, adapter] = process.argv.slice(2);
  if (command !== "adapter") {
    await import("./main.js");
    return;
  }
  const run = adapter === undefined ? undefined : ADAPTERS[adapter];
  if (!run) {
    process.stderr.write(`parlor-host adapter <${Object.keys(ADAPTERS).join("|")}>\n`);
    process.exit(2);
  }
  await run();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
