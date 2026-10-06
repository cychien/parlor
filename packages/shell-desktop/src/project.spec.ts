import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { ensureTauriProject, tauriConfig, tauriProjectFiles } from "./project.js";

const config = parseConfig({
  app: { id: "dev.parlor.hello", name: "Hello", scheme: "hello", version: "1.2.3" },
  desktop: { width: 900, height: 700 },
});

describe("tauriConfig", () => {
  it("derives identity, window, and deep link scheme from parlor config", () => {
    expect(tauriConfig(config)).toMatchObject({
      productName: "Hello",
      version: "1.2.3",
      identifier: "dev.parlor.hello",
      build: { frontendDist: "../../web" },
      app: { windows: [{ title: "Hello", width: 900, height: 700 }] },
      plugins: { "deep-link": { desktop: { schemes: ["hello"] } } },
    });
  });

  it("registers no scheme when none is configured", () => {
    const plain = parseConfig({ app: { id: "dev.parlor.hello", name: "Hello" } });
    expect(tauriConfig(plain)).toMatchObject({
      plugins: { "deep-link": { desktop: { schemes: [] } } },
    });
  });
});

describe("tauriProjectFiles", () => {
  it("wires both plugins into Cargo, Rust, and capabilities", () => {
    const files = tauriProjectFiles(config);
    expect(files["src-tauri/Cargo.toml"]).toContain('tauri-plugin-notification = "2"');
    expect(files["src-tauri/Cargo.toml"]).toContain('version = "1.2.3"');
    expect(files["src-tauri/src/lib.rs"]).toContain("tauri_plugin_deep_link::init()");
    expect(files["src-tauri/capabilities/default.json"]).toContain(
      "notification:default",
    );
  });
});

describe("ensureTauriProject", () => {
  it("writes the project, copies icons, and leaves unrelated files alone on rerun", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-tauri-"));
    const loaded = { config, rootDir, configFile: "parlor.config.ts" };

    const projectDir = await ensureTauriProject(loaded);
    expect(projectDir).toBe(join(rootDir, ".parlor", "tauri"));
    expect(await readdir(join(projectDir, "src-tauri", "icons"))).toHaveLength(5);

    const targetDir = join(projectDir, "src-tauri", "target");
    await mkdir(targetDir, { recursive: true });
    const marker = join(targetDir, "keep.txt");
    await writeFile(marker, "cache");
    const before = await stat(join(projectDir, "src-tauri", "tauri.conf.json"));

    await ensureTauriProject(loaded);
    expect(await readFile(marker, "utf8")).toBe("cache");
    const after = await stat(join(projectDir, "src-tauri", "tauri.conf.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
