import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { mobileWebOptions } from "./build.js";

describe("mobileWebOptions", () => {
  it("builds against the server url and writes the policy into the page, which has no headers", () => {
    const config = parseConfig({
      app: { id: "dev.parlor.hello", name: "Hello" },
      server: { url: "https://hello.example.com" },
    });
    expect(
      mobileWebOptions({ config, rootDir: "/app", configFile: "parlor.config.ts" }),
    ).toEqual({
      conditions: ["parlor-capacitor"],
      serverUrl: "https://hello.example.com",
      cspMeta: true,
    });
  });
});
