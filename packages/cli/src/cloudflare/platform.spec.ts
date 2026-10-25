import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { devVarsFiles, exposeVars, withUnavailable } from "./platform.js";

describe("devVarsFiles", () => {
  it("reads .dev.vars alone when it exists, as Wrangler does", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-cf-vars-"));
    expect(devVarsFiles(rootDir)).toEqual([
      join(rootDir, ".env"),
      join(rootDir, ".env.local"),
    ]);
    await writeFile(join(rootDir, ".dev.vars"), "SECRET=1\n");
    expect(devVarsFiles(rootDir)).toEqual([join(rootDir, ".dev.vars")]);
  });
});

describe("exposeVars", () => {
  it("puts text vars and secrets in process.env, keeping what the shell set", () => {
    const target: NodeJS.ProcessEnv = { REGION: "from-shell" };
    exposeVars(
      { REGION: "eu", SECRET: "s3", LIMITS: { max: 1 }, MEDIA: { put() {} } },
      target,
    );
    expect(target).toEqual({ REGION: "from-shell", SECRET: "s3" });
  });
});

describe("withUnavailable", () => {
  const env = withUnavailable({ MEDIA: "bucket" }, [
    { binding: "FRIDGE", className: "Fridge" },
  ]);

  it("passes every other binding through", () => {
    expect(env.MEDIA).toBe("bucket");
    expect(env.MISSING).toBeUndefined();
  });

  it("says why a Durable Object the app's Worker defines is missing", () => {
    expect(() => env.FRIDGE).toThrow(
      /env\.FRIDGE is unavailable in parlor dev: it binds Fridge, a Durable Object class the app's own Worker defines/,
    );
  });
});
