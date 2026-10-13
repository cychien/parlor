import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";

describe("parseConfig", () => {
  it("fills defaults for server and web", () => {
    expect(parseConfig({ app: { id: "com.example.todo", name: "Todo" } })).toEqual({
      app: { id: "com.example.todo", name: "Todo", version: "0.1.0" },
      server: { entry: "server.ts", port: 3000 },
      web: { port: 5173, pwa: true, themeColor: "#ffffff", backgroundColor: "#ffffff" },
      desktop: { width: 1024, height: 768 },
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
