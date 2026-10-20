import type { AgentUiClient } from "@parlor/agent-ui/client";
import type { CapabilityHandle, LocalAgentHost } from "@parlor/capabilities";
import type { ChatUserActionMap } from "@parlor/chat/server";

import { type ActionClient, resolveServerOrigin } from "../../action-client.js";
import { createPluginClient } from "../../plugin-client.js";
import type { RegisteredActions } from "../../register.js";
import type { FrameworkAuth } from "../../session.js";
import type { FrameworkSync } from "../sync-bridge.js";
import { type ChatRuntime, createChatRuntime } from "./runtime.js";

export interface RootRuntimeInput {
  readonly client: ActionClient<RegisteredActions>;
  readonly agentUi: AgentUiClient;
  readonly auth: FrameworkAuth | undefined;
  readonly sync: FrameworkSync;
  readonly threadId: string | undefined;
}

const NO_LOCAL_HOST: CapabilityHandle<LocalAgentHost> = {
  available: false,
  reason: "Parlor Host cannot be reached from this client",
};

export function createRootRuntime(input: RootRuntimeInput): ChatRuntime {
  const { client, agentUi, auth, sync, threadId } = input;
  return createChatRuntime({
    calls: createPluginClient<ChatUserActionMap>(client, "chat"),
    clientId: client.clientId,
    appOrigin: resolveServerOrigin(),
    agentUi,
    addChannel: (channel) => sync.addChannel(channel),
    onSyncTags: (listener) =>
      sync.onEvents((events) => listener(events.flatMap((event) => event.tags))),
    auth,
    localHost: Promise.resolve(NO_LOCAL_HOST),
    threadId,
  });
}
