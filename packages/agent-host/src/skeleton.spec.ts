import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(PACKAGE, "..", "..");
const SDK_IMPORT =
  /from\s+["']@agentclientprotocol\/sdk["']|import\(\s*["']@agentclientprotocol\/sdk["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [path] : [];
  });
}

describe("the phase 4 skeleton contract", () => {
  it("K4: acp.ts is the only file that imports the ACP SDK", () => {
    const importers = ["packages", "examples"]
      .flatMap((root) => sources(join(REPOSITORY, root)))
      .filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPOSITORY, file));
    expect(importers).toEqual(["packages/agent-host/src/acp.ts"]);
  });

  it("K4: policy.spec-d.ts holds under the type checker", () => {
    const tsc = join(PACKAGE, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["-p", "tsconfig.spec.json", "--noEmit"], {
        cwd: PACKAGE,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 60_000);
});
