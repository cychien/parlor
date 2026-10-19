import type { ReactNode } from "react";

export interface ChatRootProps {
  /** The most recent thread, or a new one, when omitted. */
  readonly threadId?: string | undefined;
  readonly children: ReactNode;
}

/**
 * Owns one chat runtime for its subtree: the `chat` channel on the existing sync stream,
 * its thread in presence `watching` so inline confirmations reach this client, and the
 * confirmation subscription. Renders no DOM of its own.
 */
export function Root(props: ChatRootProps): ReactNode {
  // TODO: const { client, agentUi, auth, sync } = useFramework(); runtime = useState(() =>
  //   createChatRuntime({ calls: createPluginClient(client, "chat"), addChannel:
  //   sync.addChannel, onSyncTags: sync.onEvents, auth, localHost:
  //   resolveCapability(localAgentHost), ... })); useEffect(runtime.start);
  //   useAgentConfirmations() to subscribe; <ChatScope value={runtime}>.
  void props;
  throw new Error("not implemented");
}
