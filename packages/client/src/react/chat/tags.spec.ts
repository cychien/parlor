import { CHAT_TAG as browserChatTag, HOSTS_TAG as browserHostsTag } from "@parlor/chat";
import { CHAT_TAG, HOST_GRANTS_TAG, HOSTS_TAG } from "@parlor/chat/server";
import { describe, expect, it } from "vitest";

import { HOST_GRANTS_TAG as clientGrantsTag } from "./runtime.js";

describe("the sync tags the browser listens for", () => {
  it("are the ones the chat backend writes and reads", () => {
    expect([browserChatTag, browserHostsTag, clientGrantsTag]).toEqual([
      CHAT_TAG,
      HOSTS_TAG,
      HOST_GRANTS_TAG,
    ]);
    expect([browserChatTag, browserHostsTag, clientGrantsTag]).toEqual([
      "parlor_chat",
      "parlor_chat_hosts",
      "parlor_auth_hosts",
    ]);
  });
});
