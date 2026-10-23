import { isPromptTooLong } from "@parlor/chat";
import { createContext, use, useSyncExternalStore } from "react";

import type { ChatRuntime, ChatState } from "./runtime.js";

export const ChatScope = createContext<ChatRuntime | undefined>(undefined);

export function useChatRuntime(part: string): ChatRuntime {
  const runtime = use(ChatScope);
  if (!runtime) throw new Error(`${part} must be rendered inside Chat.Root.`);
  return runtime;
}

export function useChatState(part: string): ChatState {
  const runtime = useChatRuntime(part);
  return useSyncExternalStore(runtime.subscribe, runtime.get, runtime.get);
}

export function canSend(state: ChatState): boolean {
  const { agent } = state;
  return (
    state.draft.trim() !== "" &&
    state.setup === undefined &&
    state.link.status === "linked" &&
    !isPromptTooLong(state.draft) &&
    agent !== undefined &&
    agent.ready &&
    (state.status === "idle" || state.status === "running" || state.status === "waiting")
  );
}
