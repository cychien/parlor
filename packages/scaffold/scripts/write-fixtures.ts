import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { templateFiles, writeFiles } from "../src/files.js";
import { composeWithAuth, FIXTURES_DIR, WITH_AUTH } from "../src/fixtures.js";

/**
 * `pnpm --filter @parlor/scaffold fixtures`: the one way the fixture changes. Resets
 * `fixtures/with-auth` to the engine's composition, then runs the same generators `parlor add
 * auth` runs, through the fixture's own `parlor` bin.
 */
const dir = join(FIXTURES_DIR, WITH_AUTH.dir);
const authManifest = JSON.parse(
  readFileSync(new URL("../../auth/package.json", import.meta.url), "utf8"),
) as Parameters<typeof composeWithAuth>[1];

for (const entry of readdirSync(dir)) {
  if (entry !== "node_modules" && entry !== ".parlor") {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}
await writeFiles(dir, await composeWithAuth(templateFiles(), authManifest));
execFileSync("pnpm", ["install", "--offline"], { cwd: dir, stdio: "inherit" });
for (const args of [
  ["parlor", "typegen"],
  ["parlor", "db", "generate", "--name", "auth"],
  ["oxfmt", "--write", "."],
]) {
  execFileSync("pnpm", ["exec", ...args], { cwd: dir, stdio: "inherit" });
}
