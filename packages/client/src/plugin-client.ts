import type { ActionMap } from "@parlor/core";

import type { ActionClient } from "./action-client.js";

/** A plugin's actions at `/_parlor/<plugin>/actions/<name>`, typed by its registry. */
export type PluginClient<T extends ActionMap> = Pick<ActionClient<T>, "call" | "invoke">;

/**
 * Reuses the app client's base URL, headers provider (the session) and client id, so a
 * plugin's actions travel exactly like the app's.
 */
export function createPluginClient<T extends ActionMap>(
  client: Pick<ActionClient<ActionMap>, "basePath" | "clientId" | "request">,
  plugin: string,
): PluginClient<T> {
  // TODO: call/invoke POST `${client.basePath}/${plugin}/actions/${name}` through
  //   client.request, mapping error bodies to ActionError as the action client does.
  void client;
  void plugin;
  throw new Error("not implemented");
}
