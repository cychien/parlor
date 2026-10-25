import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { samplePaths, samplesCompilerOptions } from "./samples.ts";

function workspace(packages: Record<string, { manifest: object; built: string[] }>) {
  const root = mkdtempSync(join(tmpdir(), "parlor-samples-"));
  for (const [dir, { manifest, built }] of Object.entries(packages)) {
    mkdirSync(join(root, dir, "dist"), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
    for (const file of built) writeFileSync(join(root, dir, file), "export {};\n");
  }
  return { root, url: pathToFileURL(`${root}/`) };
}

const published = (name: string, entries: string[]) => ({
  name,
  publishConfig: {
    exports: Object.fromEntries(
      entries.map((entry) => [
        entry === "index" ? "." : `./${entry}`,
        { types: `./dist/${entry}.d.ts`, import: `./dist/${entry}.js` },
      ]),
    ),
  },
});

test("maps a built package to its declarations, and leaves one built in part or private to its source", () => {
  const { root, url } = workspace({
    core: { manifest: published("@app/core", ["index"]), built: ["dist/index.d.ts"] },
    client: {
      manifest: published("@app/client", ["index", "router"]),
      built: ["dist/index.d.ts"],
    },
    tools: {
      manifest: { ...published("@app/tools", ["index"]), private: true },
      built: ["dist/index.d.ts"],
    },
  });

  expect(samplePaths(url)).toEqual({
    "@app/core": [join(root, "core/dist/index.d.ts")],
  });
});

test("compiles samples against what is built now, not what was built before", () => {
  const { root, url } = workspace({
    client: {
      manifest: published("@app/client", ["index", "router"]),
      built: ["dist/index.d.ts"],
    },
  });
  expect(samplesCompilerOptions(url).paths).toEqual({});

  writeFileSync(join(root, "client/dist/router.d.ts"), "export {};\n");
  expect(samplesCompilerOptions(url).paths).toEqual({
    "@app/client": [join(root, "client/dist/index.d.ts")],
    "@app/client/router": [join(root, "client/dist/router.d.ts")],
  });
});
