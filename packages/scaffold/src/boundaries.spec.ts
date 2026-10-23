import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
    publishConfig: { exports: Record<string, unknown> };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

describe("package boundaries (K2)", () => {
  it("exposes only the root entry and package.json of @parlor/scaffold", () => {
    const scaffold = manifest("../package.json");
    expect(Object.keys(scaffold.exports)).toEqual([".", "./package.json"]);
    expect(Object.keys(scaffold.publishConfig.exports)).toEqual([".", "./package.json"]);
  });

  it("keeps @parlor/cli off create-parlor, and both bins on @parlor/scaffold", () => {
    const cli = manifest("../../cli/package.json");
    const create = manifest("../../create-parlor/package.json");
    expect({ ...cli.dependencies, ...cli.devDependencies }).not.toHaveProperty(
      "create-parlor",
    );
    expect(cli.dependencies).toHaveProperty("@parlor/scaffold");
    expect(create.dependencies).toHaveProperty("@parlor/scaffold");
  });
});
