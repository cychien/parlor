import { type ReactNode, useEffect, useState } from "react";

import { useFramework } from "../provider.js";
import { ChatScope } from "./context.js";
import type { ChatRuntime, ChatState } from "./runtime.js";

export interface ChatRootProps {
  /** The most recent thread, or a new one, when omitted. */
  readonly threadId?: string | undefined;
  readonly children: ReactNode;
}

const LOADING_STATE: ChatState = {
  status: "loading",
  thread: undefined,
  threads: [],
  items: [],
  hosts: [],
  agents: [],
  agent: undefined,
  connect: { kind: "command", command: "" },
  draft: "",
};

/** Stands in while the runtime's chunk loads, so the primitives render at once. */
const LOADING: ChatRuntime = {
  subscribe: () => () => {},
  get: () => LOADING_STATE,
  start: () => () => {},
  setDraft: () => {},
  send: async () => {},
  stop: async () => {},
  answer: async () => {},
  choose: () => {},
  openThread: () => {},
};

/**
 * Owns one chat runtime for its subtree: the `chat` channel on the existing sync stream,
 * its thread in presence `watching` so inline confirmations reach this client, and the
 * confirmation subscription. Renders no DOM of its own. The runtime loads on first mount,
 * so an app that never renders this pays nothing for it.
 */
export function Root({ threadId, children }: ChatRootProps): ReactNode {
  const { client, agentUi, auth, sync } = useFramework();
  const [runtime, setRuntime] = useState<ChatRuntime>(LOADING);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void import("./create.js").then(({ createRootRuntime }) => {
      if (!active) return;
      const created = createRootRuntime({ client, agentUi, auth, sync, threadId });
      stop = created.start();
      setRuntime(created);
    });
    return () => {
      active = false;
      stop?.();
      setRuntime(LOADING);
    };
  }, [client, agentUi, auth, sync, threadId]);

  return <ChatScope value={runtime}>{children}</ChatScope>;
}
