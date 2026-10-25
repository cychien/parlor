import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

describe("@parlor/shell-web's dependencies", () => {
  it("takes Vite from the app, so the dev server and every Vite plugin share one copy", () => {
    expect(pkg.dependencies).not.toHaveProperty("vite");
    expect(pkg.peerDependencies).toHaveProperty("vite");
  });
});
