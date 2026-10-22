import type { AgentUiClient } from "@parlor/agent-ui/client";
import { localAgentHost, resolveCapability } from "@parlor/capabilities";
import type { ChatUserActionMap } from "@parlor/chat/server";

import { type ActionClient, appOrigin } from "../../action-client.js";
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

export function createRootRuntime(input: RootRuntimeInput): ChatRuntime {
  const { client, agentUi, auth, sync, threadId } = input;
  return createChatRuntime({
    calls: createPluginClient<ChatUserActionMap>(client, "chat"),
    clientId: client.clientId,
    appOrigin: appOrigin(),
    agentUi,
    addChannel: (channel) => sync.addChannel(channel),
    onSyncTags: (listener) =>
      sync.onEvents((events) => listener(events.flatMap((event) => event.tags))),
    onResume: (listener) => sync.onResume(listener),
    transport: () => sync.transport(),
    onNegotiated: (listener) => sync.onNegotiated(listener),
    isHidden: () => globalThis.document?.visibilityState === "hidden",
    auth,
    localHost: resolveCapability(localAgentHost),
    threadId,
  });
}
