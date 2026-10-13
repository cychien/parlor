import { describe, expect, it } from "vitest";

import { drizzleKitArgs } from "./db.js";

describe("drizzleKitArgs", () => {
  it("points drizzle-kit at the configured schema and migrations folders", () => {
    expect(drizzleKitArgs("/app", "schema", "migrations")).toEqual([
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "/app/schema",
      "--out",
      "/app/migrations",
    ]);
  });
});
