import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";

describe("parseConfig", () => {
  it("fills defaults for server and web", () => {
    expect(parseConfig({ app: { id: "com.example.todo", name: "Todo" } })).toEqual({
      app: { id: "com.example.todo", name: "Todo" },
      server: { entry: "server.ts", port: 3000 },
      web: { port: 5173, pwa: true, themeColor: "#ffffff", backgroundColor: "#ffffff" },
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
