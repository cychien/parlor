import type { LoadedConfig } from "@parlor/config";
import { inspectServerEntry, type ServerShape } from "@parlor/scaffold";

export const AGENT_UNAVAILABLE_WARNING =
  'Warning: this app installs chat() without sign-in, so in production the agent sidebar is unavailable (useChat().status is "unavailable"). Run `parlor add auth` to turn it on.';

/** Only when sure: an `unknown` shape stays quiet rather than warn about a working app. */
export function agentUnavailableInProduction(server: ServerShape): boolean {
  return server.chat === "installed" && server.auth === "absent";
}

/** The server is the same for every target, so every production build warns, not only web. */
export async function warnChatWithoutAuth({
  config,
  rootDir,
}: LoadedConfig): Promise<void> {
  const server = await inspectServerEntry(rootDir, config.server.entry);
  if (agentUnavailableInProduction(server)) console.warn(AGENT_UNAVAILABLE_WARNING);
}
