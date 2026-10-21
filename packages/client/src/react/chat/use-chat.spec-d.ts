import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import { expectTypeOf, test } from "vitest";

import type { ChatWait, ConnectOption } from "./runtime.js";
import type { useChat } from "./use-chat.js";

type Chat = ReturnType<typeof useChat>;

test("adding a computer is data with two kinds, so the app never asks which shell it runs in", () => {
  expectTypeOf<Chat["connect"]>().toEqualTypeOf<ConnectOption>();
  expectTypeOf<ConnectOption["kind"]>().toEqualTypeOf<"command" | "here">();
});

test("the chat's items are the folded log; an inline confirmation is the app's own card", () => {
  expectTypeOf<Chat["items"][number]>().toEqualTypeOf<ChatItem<AgentConfirmation>>();
  expectTypeOf<
    Extract<Chat["items"][number], { kind: "confirm" }>["confirmation"]
  >().toEqualTypeOf<AgentConfirmation>();
});

test("a waiting chat names the computer and why, so the app never guesses from the items", () => {
  expectTypeOf<Chat["wait"]>().toEqualTypeOf<ChatWait | undefined>();
  expectTypeOf<ChatWait["reason"]>().toEqualTypeOf<"offline" | "approval">();
  expectTypeOf<ChatWait["hostName"]>().toEqualTypeOf<string>();
});
