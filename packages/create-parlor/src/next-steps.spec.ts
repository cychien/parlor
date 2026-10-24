import type { CreatedProject } from "@parlor/scaffold";
import { describe, expect, it } from "vitest";

import { dryRunReport, nextSteps } from "./next-steps.js";

function created(overrides: Partial<CreatedProject> = {}): CreatedProject {
  return {
    directory: "/work/my-app",
    identity: {
      directoryName: "my-app",
      packageName: "my-app",
      appName: "My App",
      appId: "com.example.myapp",
    },
    packageManager: { name: "pnpm", version: "11.21.0" },
    files: ["package.json", "server.ts"],
    install: { kind: "installed" },
    addons: { applied: [], deferred: [] },
    git: { kind: "committed" },
    ...overrides,
  };
}

describe("next steps (D5)", () => {
  it("prints cd, dev, parlor add auth, the mac target and the agent lines for pnpm", () => {
    const lines = nextSteps(created(), "/work");
    expect(lines).toEqual([
      "Created my-app with pnpm.",
      "",
      "  cd my-app",
      "  pnpm dev                       web app on http://localhost:5173, API on :3000",
      "  pnpm parlor add auth           sign-in with Better Auth",
      "  pnpm parlor dev --target mac   the same app as a desktop window",
      "",
      "Open http://localhost:5173 and press Agent to chat with your coding agent.",
      "AGENTS.md tells coding agents how this project works. Docs: https://cychien.github.io/parlor/llms.txt",
    ]);
  });

  it.each([
    ["npm", "npm run dev", "npx parlor add auth"],
    ["yarn", "yarn dev", "yarn parlor add auth"],
    ["bun", "bun run dev", "bunx parlor add auth"],
  ] as const)("speaks %s", (name, dev, add) => {
    const lines = nextSteps(
      created({ packageManager: { name, version: undefined } }),
      "/work",
    ).join("\n");
    expect(lines).toContain(dev);
    expect(lines).toContain(add);
  });

  it("prints the install command before dev when install was skipped or failed", () => {
    const skipped = nextSteps(
      created({
        packageManager: { name: "npm", version: undefined },
        install: { kind: "skipped" },
      }),
      "/work",
    );
    expect(skipped.findIndex((line) => line.includes("npm install"))).toBeLessThan(
      skipped.findIndex((line) => line.includes("npm run dev")),
    );
    const failed = nextSteps(
      created({ install: { kind: "failed", command: "pnpm install", exitCode: 1 } }),
      "/work",
    );
    expect(failed.some((line) => line.includes("pnpm install"))).toBe(true);
  });

  it("lists a deferred add-on as its own command instead of the auth hint", () => {
    const lines = nextSteps(
      created({
        install: { kind: "skipped" },
        addons: { applied: [], deferred: ["auth"] },
      }),
      "/work",
    );
    expect(lines.filter((line) => line.includes("parlor add auth"))).toEqual([
      "  pnpm parlor add auth           finish adding auth",
    ]);
    const applied = nextSteps(
      created({ addons: { applied: ["auth"], deferred: [] } }),
      "/work",
    );
    expect(applied.some((line) => line.includes("parlor add auth"))).toBe(false);
  });

  it("says why there is no initial commit when git failed", () => {
    const lines = nextSteps(
      created({
        git: {
          kind: "failed",
          message: "Author identity unknown\n\n*** Please tell me who you are.",
        },
      }),
      "/work",
    );
    expect(lines.slice(-2)).toEqual([
      "",
      "No initial commit: Author identity unknown. Commit the files once git works.",
    ]);
  });

  it("prints every path and a count for a dry run", () => {
    expect(dryRunReport(created())).toEqual([
      "my-app/package.json",
      "my-app/server.ts",
      "",
      "2 files would be written to my-app. Nothing was.",
    ]);
  });
});
