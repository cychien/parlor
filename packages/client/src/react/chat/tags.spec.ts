import { CHAT_TAG, HOSTS_TAG } from "@parlor/chat/server";
import { describe, expect, it } from "vitest";

import { CHAT_TAG as clientChatTag, HOSTS_TAG as clientHostsTag } from "./runtime.js";

describe("the sync tags the browser listens for", () => {
  it("are the ones the chat backend writes", () => {
    expect([clientChatTag, clientHostsTag]).toEqual([CHAT_TAG, HOSTS_TAG]);
    expect([clientChatTag, clientHostsTag]).toEqual(["parlor_chat", "parlor_chat_hosts"]);
  });
});
