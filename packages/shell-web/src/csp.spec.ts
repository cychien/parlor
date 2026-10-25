import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { appCsp, defaultCsp, extendCsp, metaCsp, serializeCsp } from "./csp.js";

describe("defaultCsp", () => {
  it("serializes to the strict production policy", () => {
    expect(serializeCsp(defaultCsp())).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
  });

  it("lets connect-src reach the backend origin and extra origins, without a path", () => {
    expect(
      serializeCsp(
        defaultCsp({
          serverOrigin: "http://localhost:3000/_parlor/",
          connect: ["https://relay.example.com"],
        }),
      ),
    ).toContain("connect-src 'self' http://localhost:3000 https://relay.example.com;");
  });

  it("allows Vite's inline preamble, inline styles and websocket only in dev", () => {
    const dev = serializeCsp(defaultCsp({ dev: true }));
    expect(dev).toContain("script-src 'self' 'unsafe-inline';");
    expect(dev).toContain("style-src 'self' 'unsafe-inline';");
    expect(dev).toContain("connect-src 'self' ws:;");
    expect(serializeCsp(defaultCsp())).not.toContain("unsafe-inline");
  });

  it("never allows eval", () => {
    expect(serializeCsp(defaultCsp({ dev: true }))).not.toContain("unsafe-eval");
  });
});

describe("extendCsp", () => {
  it("adds sources after the defaults without duplicating", () => {
    const extended = extendCsp(defaultCsp(), {
      "img-src": ["https://cdn.example.com", "data:"],
      "font-src": ["https://fonts.gstatic.com"],
    });
    const header = serializeCsp(extended);
    expect(header).toContain("img-src 'self' data: https://cdn.example.com;");
    expect(header).toContain("font-src 'self' https://fonts.gstatic.com;");
  });

  it("replaces 'none' when an app opens a directive on purpose", () => {
    const header = serializeCsp(
      extendCsp(defaultCsp(), { "frame-ancestors": ["https://partner.example.com"] }),
    );
    expect(header).toContain("frame-ancestors https://partner.example.com;");
  });

  it.each(["'unsafe-inline'", "'unsafe-eval'", "'UNSAFE-INLINE'"])(
    "throws when script-src is asked to take %s",
    (source) => {
      expect(() => extendCsp(defaultCsp(), { "script-src": [source] })).toThrow(
        /script-src/,
      );
    },
  );

  it("does not change the base", () => {
    const base = defaultCsp();
    extendCsp(base, { "img-src": ["https://cdn.example.com"] });
    expect(base["img-src"]).toEqual(["'self'", "data:"]);
  });
});

describe("serializeCsp", () => {
  it("writes an empty source list as 'none' and skips absent directives", () => {
    expect(serializeCsp({ "script-src": ["'self'"], "frame-src": [] })).toBe(
      "script-src 'self'; frame-src 'none'",
    );
  });

  it.each(["https://a.example; script-src *", "a b", "a,b", "a\nb"])(
    "refuses a source that could smuggle another directive: %j",
    (source) => {
      expect(() => serializeCsp({ "img-src": [source] })).toThrow(/img-src/);
    },
  );
});

describe("metaCsp", () => {
  it("drops directives a meta element ignores", () => {
    expect(
      serializeCsp(metaCsp({ "script-src": ["'self'"], "frame-ancestors": ["'none'"] })),
    ).toBe("script-src 'self'");
  });
});

describe("appCsp", () => {
  const app = { id: "com.example.todo", name: "Todo" };

  it("applies the app's additions on the default for the shell's backend", () => {
    const config = parseConfig({
      app,
      web: { csp: { "connect-src": ["https://api.example.com"] } },
    });
    expect(
      serializeCsp(appCsp(config, { serverOrigin: "https://app.example.com" })),
    ).toContain("connect-src 'self' https://app.example.com https://api.example.com;");
  });

  it("is the plain default for an app that adds nothing", () => {
    expect(serializeCsp(appCsp(parseConfig({ app }), {}))).toBe(
      serializeCsp(defaultCsp()),
    );
  });
});
