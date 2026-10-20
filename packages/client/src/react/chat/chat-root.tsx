import { type ReactNode, useEffect, useMemo } from "react";

import { useFramework, useIdentityEpoch } from "../provider.js";
import { ChatScope } from "./context.js";
import { createRootRuntime } from "./create.js";

export interface ChatRootProps {
  /** The thread to show. When omitted, the most recent one, or a blank one for a user with none. */
  readonly threadId?: string | undefined;
  readonly children: ReactNode;
}

/**
 * Owns one chat runtime for its subtree: the `chat` channel on the existing sync stream,
 * its thread in presence `watching` so inline confirmations reach this client, and the
 * confirmation subscription. Renders no DOM of its own. When the signed-in user changes,
 * the subtree remounts with a fresh runtime, so nothing of the previous user remains.
 */
export function Root({ threadId, children }: ChatRootProps): ReactNode {
  return (
    <UserChat key={useIdentityEpoch()} threadId={threadId}>
      {children}
    </UserChat>
  );
}

function UserChat({ threadId, children }: ChatRootProps): ReactNode {
  const { client, agentUi, auth, sync } = useFramework();
  const runtime = useMemo(
    () => createRootRuntime({ client, agentUi, auth, sync, threadId }),
    [client, agentUi, auth, sync, threadId],
  );

  useEffect(() => runtime.start(), [runtime]);

  return <ChatScope value={runtime}>{children}</ChatScope>;
}
