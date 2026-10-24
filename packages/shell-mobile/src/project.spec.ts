import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import {
  CAPACITOR_PLUGINS,
  capacitorConfig,
  capacitorProjectFiles,
  DEVICE_KEY_PLUGIN,
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
        "@parlor/capacitor-device-key",
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

describe("DEVICE_KEY_PLUGIN", () => {
  it("K6: DEVICE_KEY_PLUGIN names ParlorDeviceKey and its package, and the generated project depends on it", () => {
    expect(DEVICE_KEY_PLUGIN).toEqual({
      name: "ParlorDeviceKey",
      package: "@parlor/capacitor-device-key",
    });
    const files = capacitorProjectFiles(config);
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.dependencies[DEVICE_KEY_PLUGIN.package]).toBe("*");
  });
});

describe("the native plugins Capacitor links", () => {
  it("each resolves <name>/package.json, as `cap sync` does to find it, or the app ships without it", () => {
    const fromShell = createRequire(import.meta.url);
    for (const name of [...CAPACITOR_PLUGINS, DEVICE_KEY_PLUGIN.package]) {
      expect(() => fromShell.resolve(`${name}/package.json`), name).not.toThrow();
    }
  });
});
