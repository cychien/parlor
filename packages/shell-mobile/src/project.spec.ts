import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import {
  capacitorConfig,
  capacitorProjectFiles,
  ensureCapacitorProject,
} from "./project.js";

const config = parseConfig({
  app: { id: "dev.parlor.hello", name: "Hello", scheme: "hello" },
});

describe("capacitorConfig", () => {
  it("points at the shared web build and adds a live reload server only in dev", () => {
    expect(capacitorConfig(config)).toEqual({
      appId: "dev.parlor.hello",
      appName: "Hello",
      webDir: "../web",
      ios: { contentInset: "automatic" },
    });
    expect(capacitorConfig(config, { devUrl: "http://localhost:5173" })).toMatchObject({
      server: { url: "http://localhost:5173", cleartext: true },
    });
  });
});

describe("ensureCapacitorProject", () => {
  it("writes config and package manifest and links node_modules to the shell's", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-cap-"));
    const nodeModules = await mkdtemp(join(tmpdir(), "parlor-nm-"));
    const projectDir = await ensureCapacitorProject(
      { config, rootDir, configFile: "parlor.config.ts" },
      {},
      nodeModules,
    );
    expect(projectDir).toBe(join(rootDir, ".parlor", "capacitor"));
    const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining([
        "@capacitor/core",
        "@capacitor/ios",
        "@capacitor/local-notifications",
      ]),
    );
    expect((await lstat(join(projectDir, "node_modules"))).isSymbolicLink()).toBe(true);
    await ensureCapacitorProject(
      { config, rootDir, configFile: "parlor.config.ts" },
      {},
      nodeModules,
    );
    expect(Object.keys(capacitorProjectFiles(config))).toContain("capacitor.config.json");
  });
});
