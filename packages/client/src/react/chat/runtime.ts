import type { AgentConfirmation, AgentUiClient } from "@parlor/agent-ui/client";
import type { CapabilityHandle, LocalAgentHost } from "@parlor/capabilities";
import type { ChatItem, HostSummary, ThreadSummary } from "@parlor/chat";
import type { ChatUserActionMap } from "@parlor/chat/server";
import type { Tag } from "@parlor/core";
import type { ClientChannel } from "@parlor/sync";

import type { PluginClient } from "../../plugin-client.js";
import type { DeviceSource, HostAuthorizer } from "../../session.js";

/** One agent the user can talk to; `key` is `<hostId>/<agentId>`. */
export interface AgentChoice {
  readonly key: string;
  readonly name: string;
  readonly hostName: string;
  readonly online: boolean;
  readonly ready: boolean;
  readonly problem: string | undefined;
}

/** How this client adds a computer, decided by the `localAgentHost` capability. */
export type ConnectOption =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "here"; start(): Promise<void> };

export type ChatStatus = "loading" | "idle" | "sending" | "running";

export interface ChatState {
  readonly status: ChatStatus;
  readonly thread: ThreadSummary | undefined;
  readonly threads: readonly ThreadSummary[];
  readonly items: readonly ChatItem<AgentConfirmation>[];
  readonly hosts: readonly HostSummary[];
  readonly agents: readonly AgentChoice[];
  readonly agent: AgentChoice | undefined;
  readonly connect: ConnectOption;
  readonly draft: string;
}

export interface ChatCommands {
  setDraft(text: string): void;
  /** Signs the draft (or `text`) and sends it to the chosen agent; idempotent per call. */
  send(text?: string): Promise<void>;
  stop(): Promise<void>;
  /** A `presence` ask triggers the OS prompt first; a `computer` ask refuses. */
  answer(
    askId: string,
    choice: string,
    values?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void>;
  choose(agentKey: string): void;
  openThread(threadId: string | undefined): void;
}

export interface ChatRuntime extends ChatCommands {
  subscribe(listener: () => void): () => void;
  get(): ChatState;
  /** Registers the channel, `watching` and the sync subscription; returns the stop. */
  start(): () => void;
}

export interface ChatRuntimeDeps {
  readonly calls: PluginClient<ChatUserActionMap>;
  readonly clientId: string;
  readonly appOrigin: string;
  readonly agentUi: AgentUiClient;
  readonly addChannel: (channel: ClientChannel) => () => void;
  readonly onSyncTags: (listener: (tags: readonly Tag[]) => void) => () => void;
  readonly auth: Partial<DeviceSource & HostAuthorizer> | undefined;
  readonly localHost: Promise<CapabilityHandle<LocalAgentHost>>;
  readonly threadId: string | undefined;
}

/**
 * One store, three inputs, folded by `foldThread`: `open` on mount; sync events tagged
 * `["parlor_chat", threadId]`, answered with `items` after the last seq; and `chat`
 * channel frames for token deltas. Turn and prompt ids are minted here, so a retried send
 * is a no-op.
 */
export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  // TODO: start(): addChannel({ event: CHAT_CHANNEL, receive: parseChatFrame -> open
  //   turns }), agentUi.watch(threadId), onSyncTags(parlor_chat -> calls.call("items")),
  //   calls.call("open"). connect is "here" when
  //   localHost is available (start = localHost.connect({ appOrigin, authorize:
  //   auth.authorizeHost })), else the `npx @parlor/agent-host connect <appOrigin>` command.
  void deps;
  throw new Error("not implemented");
}
