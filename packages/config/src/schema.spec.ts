import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";

describe("parseConfig", () => {
  it("fills defaults for server and web", () => {
    expect(parseConfig({ app: { id: "com.example.todo", name: "Todo" } })).toEqual({
      app: { id: "com.example.todo", name: "Todo", version: "0.1.0" },
      server: { entry: "server.ts", port: 3000 },
      web: { port: 5173, pwa: true, themeColor: "#ffffff", backgroundColor: "#ffffff" },
      desktop: { width: 1024, height: 768 },
      database: { schema: "schema", migrations: "migrations" },
      deploy: {},
    });
  });

  it("rejects an app id that is not reverse-DNS", () => {
    expect(() => parseConfig({ app: { id: "todo", name: "Todo" } })).toThrow(
      /reverse-DNS/,
    );
    expect(() => parseConfig({ app: { id: "Com.Example", name: "Todo" } })).toThrow();
  });

  it("rejects an empty app name", () => {
    expect(() => parseConfig({ app: { id: "com.example.todo", name: "" } })).toThrow();
  });
});

describe("app.version and app.scheme", () => {
  it("validates semver and url scheme formats", () => {
    expect(() =>
      parseConfig({ app: { id: "com.example.todo", name: "T", version: "1.0" } }),
    ).toThrow(/semver/);
    expect(() =>
      parseConfig({ app: { id: "com.example.todo", name: "T", scheme: "Hello App" } }),
    ).toThrow(/URL scheme/);
    expect(
      parseConfig({ app: { id: "com.example.todo", name: "T", scheme: "todo" } }).app
        .scheme,
    ).toBe("todo");
  });
});

describe("web.csp", () => {
  const app = { id: "com.example.todo", name: "T" };

  it("keeps the source lists an app adds", () => {
    expect(
      parseConfig({
        app,
        web: { csp: { "connect-src": ["https://api.example.com"] } },
      }).web.csp,
    ).toEqual({ "connect-src": ["https://api.example.com"] });
  });

  it("rejects a directive the policy builder does not know", () => {
    expect(() =>
      parseConfig({ app, web: { csp: { "script-src-elem": ["'self'"] } } }),
    ).toThrow();
  });
});

describe("desktop.agentHost", () => {
  const app = { id: "com.example.todo", name: "Todo" };

  it("K6: is a boolean left unset by default, so a desktop app carries no host until it asks", () => {
    expect(parseConfig({ app }).desktop).not.toHaveProperty("agentHost");
    expect(parseConfig({ app, desktop: { agentHost: true } }).desktop.agentHost).toBe(true);
    expect(parseConfig({ app, desktop: { agentHost: false } }).desktop.agentHost).toBe(
      false,
    );
    expect(() => parseConfig({ app, desktop: { agentHost: "yes" } })).toThrow();
  });
});
