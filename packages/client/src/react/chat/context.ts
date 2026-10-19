import { createContext, use } from "react";

import type { ChatRuntime } from "./runtime.js";

export const ChatScope = createContext<ChatRuntime | undefined>(undefined);

export function useChatRuntime(part: string): ChatRuntime {
  const runtime = use(ChatScope);
  if (!runtime) throw new Error(`${part} must be rendered inside Chat.Root.`);
  return runtime;
}
