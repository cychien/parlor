import { describe, expect, it } from "vitest";

import { hostPaths } from "./paths.js";

describe("hostPaths", () => {
  it("lays out ~/.parlor/host with its sockets under run/ and the workspaces in ~/Parlor", () => {
    expect(hostPaths("/Users/alice/.parlor/host")).toEqual({
      root: "/Users/alice/.parlor/host",
      grants: "/Users/alice/.parlor/host/grants.json",
      trust: "/Users/alice/.parlor/host/trust.json",
      sessions: "/Users/alice/.parlor/host/sessions.json",
      agents: "/Users/alice/.parlor/host/agents.json",
      control: "/Users/alice/.parlor/host/run/control.sock",
      proxy: "/Users/alice/.parlor/host/run/proxy.sock",
      versions: "/Users/alice/.parlor/host/versions",
      current: "/Users/alice/.parlor/host/current",
      workspaces: "/Users/alice/Parlor",
    });
  });
});
