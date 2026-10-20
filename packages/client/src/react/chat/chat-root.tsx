import { type ReactNode, useEffect, useMemo } from "react";

import { useFramework } from "../provider.js";
import { ChatScope } from "./context.js";
import { createRootRuntime } from "./create.js";

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
export function Root({ threadId, children }: ChatRootProps): ReactNode {
  const { client, agentUi, auth, sync } = useFramework();
  const runtime = useMemo(
    () => createRootRuntime({ client, agentUi, auth, sync, threadId }),
    [client, agentUi, auth, sync, threadId],
  );

  useEffect(() => runtime.start(), [runtime]);

  return <ChatScope value={runtime}>{children}</ChatScope>;
}
