import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { serverEnv } from "./server-process.js";

describe("serverEnv", () => {
  it("tells the server its port and the origin the web dev server serves the app on", () => {
    const config = parseConfig({
      app: { id: "dev.parlor.test", name: "Test" },
      server: { port: 3100 },
      web: { port: 5200 },
    });
    expect(serverEnv(config, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      PORT: "3100",
      PARLOR_WEB_ORIGIN: "http://localhost:5200",
    });
  });
});
