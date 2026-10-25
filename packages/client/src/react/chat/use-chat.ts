import { useMemo } from "react";

import { useChatRuntime, useChatState } from "./context.js";
import type { ChatCommands, ChatState } from "./runtime.js";

/** The chat's state and commands, for what the primitives do not draw. */
export function useChat(): ChatState & ChatCommands {
  const runtime = useChatRuntime("useChat");
  const state = useChatState("useChat");
  return useMemo(
    () => ({
      ...state,
      setDraft: runtime.setDraft,
      send: runtime.send,
      stop: runtime.stop,
      answer: runtime.answer,
      resend: runtime.resend,
      loadOlder: runtime.loadOlder,
      loadMoreThreads: runtime.loadMoreThreads,
      choose: runtime.choose,
      setOption: runtime.setOption,
      disconnect: runtime.disconnect,
      openThread: runtime.openThread,
      newThread: runtime.newThread,
      startLink: runtime.startLink,
    }),
    [state, runtime],
  );
}
