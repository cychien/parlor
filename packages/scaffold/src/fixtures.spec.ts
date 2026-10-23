import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { planAddons } from "./add/plan.js";
import { inMemoryFiles, NEVER_COPIED, templateFiles } from "./files.js";
import {
  composeWithAuth,
  DEFAULT_LAYOUT,
  FIXTURES_DIR,
  isGeneratedPath,
  WITH_AUTH,
} from "./fixtures.js";

const dir = join(FIXTURES_DIR, WITH_AUTH.dir);
const authManifest = JSON.parse(
  readFileSync(new URL("../../auth/package.json", import.meta.url), "utf8"),
) as Parameters<typeof composeWithAuth>[1];

function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (NEVER_COPIED.has(entry)) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return files;
}

describe("fixtures/with-auth", () => {
  const fixture = readTree(dir);

  it("equals the default template plus `parlor add auth`, byte for byte", async () => {
    const composed = await composeWithAuth(templateFiles(), authManifest);
    for (const [path, content] of composed) {
      if (!isGeneratedPath(path)) expect(fixture.get(path), path).toBe(content);
    }
    const extra = [...fixture.keys()].filter(
      (path) => !composed.has(path) && !isGeneratedPath(path),
    );
    expect(extra).toEqual([]);
  });

  it("holds the generators' outputs: the sign-in route and the auth migration", () => {
    expect(fixture.get(DEFAULT_LAYOUT.routeTree)).toContain('"/sign-in"');
    const journal = JSON.parse(
      fixture.get(`${DEFAULT_LAYOUT.migrationsDir}/meta/_journal.json`) ?? "{}",
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag)).toEqual(["0000_init", "0001_auth"]);
  });

  it("plans nothing when auth is applied a second time (D3)", async () => {
    const plan = await planAddons(
      { ...DEFAULT_LAYOUT, rootDir: dir },
      WITH_AUTH.addons,
      inMemoryFiles(fixture, new Map([["@parlor/auth", authManifest]])),
      templateFiles(),
    );
    expect(plan).toEqual({ kind: "done", addons: ["auth"] });
  });
});
