import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { workspaceCatalog, WORKSPACE_YAML } from "../scripts/write-catalog.js";
import { CATALOG } from "./catalog.js";

describe("CATALOG", () => {
  it("equals the catalog in pnpm-workspace.yaml (run `pnpm --filter @parlor/scaffold catalog`)", () => {
    expect(CATALOG).toEqual(workspaceCatalog(readFileSync(WORKSPACE_YAML, "utf8")));
  });
});
