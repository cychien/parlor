import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { parseAddonNames, projectLayout } from "./add.js";

describe("parlor add arguments", () => {
  it("takes known add-ons once each", () => {
    expect(parseAddonNames(["auth", "agent", "auth"])).toEqual(["auth", "agent"]);
  });

  it("asks for a name and refuses an unknown one", () => {
    expect(() => parseAddonNames([])).toThrow("Name what to add: agent, auth");
    expect(() => parseAddonNames(["x"])).toThrow(
      'Unknown add-on "x". Expected one of: agent, auth',
    );
  });

  it("reads the layout from the config", () => {
    const config = parseConfig({
      app: { id: "com.example.todo", name: "Todo" },
      web: { routeTree: "app/routeTree.gen.ts" },
    });
    expect(
      projectLayout({ config, rootDir: "/app", configFile: "/app/parlor.config.ts" }),
    ).toEqual({
      rootDir: "/app",
      serverEntry: "server.ts",
      schemaDir: "schema",
      migrationsDir: "migrations",
      routeTree: "app/routeTree.gen.ts",
    });
  });
});
