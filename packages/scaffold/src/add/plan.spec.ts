import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { inMemoryFiles, templateFiles } from "../files.js";
import { DEFAULT_LAYOUT } from "../fixtures.js";
import { planAddons } from "./plan.js";

const layout = { ...DEFAULT_LAYOUT, rootDir: "/app" };
const authManifest = JSON.parse(
  readFileSync(new URL("../../../auth/package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };

async function defaultTemplate(): Promise<Map<string, string>> {
  const templates = templateFiles();
  const files = new Map<string, string>();
  for (const path of await templates.list("default", "")) {
    files.set(path, await templates.read("default", path));
  }
  return files;
}

describe("planAddons", () => {
  it("plans nothing for agent on the default template, which already has it", async () => {
    const plan = await planAddons(
      layout,
      ["agent"],
      inMemoryFiles(await defaultTemplate()),
      templateFiles(),
    );
    expect(plan).toEqual({ kind: "done", addons: ["agent"] });
  });

  it("plans auth on the default template: payload, edits, env, both dependencies and both generations", async () => {
    const plan = await planAddons(
      layout,
      ["auth"],
      inMemoryFiles(await defaultTemplate()),
      templateFiles(),
    );
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.writes.map((write) => [write.path, write.change]).sort()).toEqual([
      [".env.example", "create"],
      ["auth.ts", "create"],
      ["schema/auth.ts", "create"],
      ["schema/index.ts", "update"],
      ["server.ts", "update"],
      ["src/auth/client.ts", "create"],
      ["src/auth/sign-in-gate.tsx", "create"],
      ["src/auth/sign-out-button.tsx", "create"],
      ["src/header-actions.tsx", "update"],
      ["src/main.tsx", "update"],
      ["src/routes/__root.tsx", "update"],
      ["src/routes/link.tsx", "create"],
      ["src/routes/sign-in.tsx", "create"],
    ]);
    expect(plan.dependencies).toEqual([
      { name: "@parlor/auth", version: "0.0.0", dev: false },
      {
        name: "better-auth",
        version: { fromPackage: "@parlor/auth", dependency: "better-auth" },
        dev: false,
      },
    ]);
    expect(plan.generate.map((generation) => generation.kind)).toEqual([
      "route-tree",
      "migration",
    ]);
  });

  it("resolves a FromPackage pin at plan time once that package is installed", async () => {
    const plan = await planAddons(
      layout,
      ["auth"],
      inMemoryFiles(await defaultTemplate(), new Map([["@parlor/auth", authManifest]])),
      templateFiles(),
    );
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(
      plan.dependencies.find((dependency) => dependency.name === "better-auth"),
    ).toMatchObject({ version: authManifest.dependencies["better-auth"] });
  });

  it("is blocked, with the exact manual change, on a server.ts it cannot edit (D4)", async () => {
    const files = await defaultTemplate();
    files.set(
      "server.ts",
      `import { createServer } from "@parlor/server";\n\nimport { options } from "./options.js";\n\nexport default createServer(options);\n`,
    );
    const plan = await planAddons(
      layout,
      ["auth"],
      inMemoryFiles(files),
      templateFiles(),
    );
    expect(plan).toMatchObject({
      kind: "blocked",
      addons: ["auth"],
      manual: [
        {
          file: "server.ts",
          reason: expect.stringContaining("`options`"),
          change: expect.stringContaining("auth: createAuth("),
        },
      ],
    });
  });

  it("is blocked when the layout moves what the payload imports by relative path", async () => {
    const plan = await planAddons(
      { ...layout, serverEntry: "src/server/index.ts" },
      ["auth"],
      inMemoryFiles(await defaultTemplate()),
      templateFiles(),
    );
    expect(plan).toMatchObject({
      kind: "blocked",
      manual: [{ reason: expect.stringContaining("project root") }],
    });
  });
});
