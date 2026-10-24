export const SERVERLESS_UNSUPPORTED_WARNING =
  "Warning: serverless presets are not supported yet. Pages and actions work, but agents cannot see or use the screen (ui_* tools), actions that need the user's approval always fail when an agent calls them, and the agent sidebar replies without streaming. Deploy with node-server or bun for now.";

/** A build whose sync polls is a serverless one: its functions cannot hold a stream. */
export function serverlessWarning(syncTransport: "sse" | "poll"): string | undefined {
  return syncTransport === "poll" ? SERVERLESS_UNSUPPORTED_WARNING : undefined;
}
