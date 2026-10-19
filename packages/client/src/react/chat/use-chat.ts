import type { ChatCommands, ChatState } from "./runtime.js";

/** The chat's state and commands, for what the primitives do not draw. */
export function useChat(): ChatState & ChatCommands {
  // TODO: runtime = useChatRuntime("useChat"); useSyncExternalStore(runtime.subscribe,
  //   runtime.get) spread with the runtime's commands.
  throw new Error("not implemented");
}
