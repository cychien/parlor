import { describe, expect, it } from "vitest";

import { hostPaths } from "./paths.js";

describe("hostPaths", () => {
  it("lays out ~/.parlor/host with its sockets under run/ and the workspaces in ~/Parlor", () => {
    expect(hostPaths("/Users/alice/.parlor/host")).toEqual({
      root: "/Users/alice/.parlor/host",
      grants: "/Users/alice/.parlor/host/grants.json",
      trust: "/Users/alice/.parlor/host/trust.json",
      policy: "/Users/alice/.parlor/host/policy.json",
      sessions: "/Users/alice/.parlor/host/sessions.json",
      agents: "/Users/alice/.parlor/host/agents.json",
      learned: "/Users/alice/.parlor/host/learned.json",
      control: "/Users/alice/.parlor/host/run/control.sock",
      proxy: "/Users/alice/.parlor/host/run/proxy.sock",
      lock: "/Users/alice/.parlor/host/service.lock",
      logs: "/Users/alice/.parlor/host/logs",
      workspaces: "/Users/alice/Parlor",
    });
  });
});
