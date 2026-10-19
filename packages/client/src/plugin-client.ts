import type { ActionMap } from "@parlor/core";

import { type ActionClient, invokeAt } from "./action-client.js";

/** A plugin's actions at `/_parlor/<plugin>/actions/<name>`, typed by its registry. */
export type PluginClient<T extends ActionMap> = Pick<ActionClient<T>, "call" | "invoke">;

/**
 * Reuses the app client's base URL, headers provider (the session) and client id, so a
 * plugin's actions travel exactly like the app's. A server without the plugin answers
 * `not_found`.
 */
export function createPluginClient<T extends ActionMap>(
  client: Pick<ActionClient<ActionMap>, "basePath" | "clientId" | "request">,
  plugin: string,
): PluginClient<T> {
  const invoke: PluginClient<T>["invoke"] = (name, input, options) =>
    invokeAt<T, typeof name>(
      client.request,
      `${client.basePath}/${plugin}/actions/${name}`,
      input,
      { ...options, missingIsNotFound: true },
    );
  return {
    invoke,
    call: async (name, input, options) => (await invoke(name, input, options)).data,
  };
}
