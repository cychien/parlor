import { CHAT_TAG, HOST_GRANTS_TAG, HOSTS_TAG } from "@parlor/chat/server";
import { describe, expect, it } from "vitest";

import {
  CHAT_TAG as clientChatTag,
  HOST_GRANTS_TAG as clientGrantsTag,
  HOSTS_TAG as clientHostsTag,
} from "./runtime.js";

describe("the sync tags the browser listens for", () => {
  it("are the ones the chat backend writes and reads", () => {
    expect([clientChatTag, clientHostsTag, clientGrantsTag]).toEqual([
      CHAT_TAG,
      HOSTS_TAG,
      HOST_GRANTS_TAG,
    ]);
    expect([clientChatTag, clientHostsTag, clientGrantsTag]).toEqual([
      "parlor_chat",
      "parlor_chat_hosts",
      "parlor_auth_hosts",
    ]);
  });
});
