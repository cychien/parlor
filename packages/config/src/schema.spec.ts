import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";

describe("parseConfig", () => {
  it("fills defaults for server and web", () => {
    expect(parseConfig({ app: { id: "com.example.todo", name: "Todo" } })).toEqual({
      app: { id: "com.example.todo", name: "Todo", version: "0.1.0" },
      server: { entry: "server.ts", port: 3000 },
      web: { port: 5173, pwa: true, themeColor: "#ffffff", backgroundColor: "#ffffff" },
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

describe("app.version", () => {
  it("validates semver", () => {
    expect(() =>
      parseConfig({ app: { id: "com.example.todo", name: "T", version: "1.0" } }),
    ).toThrow(/semver/);
  });
});

describe("a config written for the native shells", () => {
  it("still loads, without the keys only those shells read", () => {
    const config = parseConfig({
      app: { id: "com.example.todo", name: "T", scheme: "todo" },
      server: { url: "https://api.example.com" },
      desktop: { width: 800, agentHost: true },
    });
    expect(config.app).not.toHaveProperty("scheme");
    expect(config.server).not.toHaveProperty("url");
    expect(config).not.toHaveProperty("desktop");
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

describe("web.icons", () => {
  const app = { id: "com.example.todo", name: "T" };

  it("is unset by default, so the manifest stays as it was", () => {
    expect(parseConfig({ app }).web.icons).toBeUndefined();
  });

  it("keeps icons that name a file under public/ and its sizes", () => {
    const icons = [
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
    expect(parseConfig({ app, web: { icons } }).web.icons).toEqual(icons);
  });

  it("rejects a relative path or sizes the manifest cannot read", () => {
    expect(() =>
      parseConfig({ app, web: { icons: [{ src: "icon.png", sizes: "512x512" }] } }),
    ).toThrow();
    expect(() =>
      parseConfig({ app, web: { icons: [{ src: "/icon.png", sizes: "512" }] } }),
    ).toThrow();
  });
});

describe("web.ssr", () => {
  const app = { id: "com.example.todo", name: "T" };

  it("is off unless the app names the module that builds it", () => {
    expect(parseConfig({ app }).web.ssr).toBeUndefined();
    expect(parseConfig({ app, web: { ssr: { app: "src/app.tsx" } } }).web.ssr).toEqual({
      app: "src/app.tsx",
    });
    expect(() => parseConfig({ app, web: { ssr: {} } })).toThrow();
  });
});
