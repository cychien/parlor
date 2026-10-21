import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENT_PROFILES } from "./agents.js";
import { releaseBytes } from "./release.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { devDependencies: Record<string, string> };

describe("the release script", () => {
  it("signs the same canonical bytes the host verifies", async () => {
    const { releaseBytes: signed } = (await import("../scripts/release.mjs")) as {
      releaseBytes: typeof releaseBytes;
    };
    const body = {
      v: 1 as const,
      version: "1.2.3",
      platform: "darwin-arm64",
      sha256: "ab",
    };
    expect(Buffer.from(signed(body)).toString()).toBe(
      Buffer.from(releaseBytes(body)).toString(),
    );
  });

  it("embeds exactly the adapter versions the built-in profiles pin", () => {
    for (const profile of AGENT_PROFILES) {
      if (profile.launch.kind !== "adapter") continue;
      expect(packageJson.devDependencies[profile.launch.package]).toBe(
        profile.launch.version,
      );
    }
  });
});
