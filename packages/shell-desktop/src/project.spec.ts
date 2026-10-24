import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import {
  AGENT_HOST_SIDECAR,
  AgentHostStageError,
  ensureTauriProject,
  libRs,
  prepareTauriProject,
  stageAgentHost,
  stageAgentHostFrom,
  tauriConfig,
  tauriProjectFiles,
} from "./project.js";

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

  it("applies the default policy with the server origin and the Tauri ipc sources", () => {
    const withServer = parseConfig({
      app: { id: "dev.parlor.hello", name: "Hello" },
      server: { url: "http://localhost:3000" },
      web: { csp: { "img-src": ["https://cdn.example.com"] } },
    });
    const { security } = (tauriConfig(withServer) as { app: { security: unknown } }).app;
    expect(security).toEqual({
      csp: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.example.com; font-src 'self'; connect-src 'self' http://localhost:3000 ipc: http://ipc.localhost; worker-src 'self'; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
      devCsp:
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.example.com; font-src 'self'; connect-src 'self' http://localhost:3000 ws: ipc: http://ipc.localhost; worker-src 'self'; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
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

const SHELL_COMMANDS = [
  "parlor_shell::parlor_device_key_public,",
  "parlor_shell::parlor_device_key_sign,",
  "parlor_shell::parlor_session_get,",
  "parlor_shell::parlor_session_set,",
];

const withHost = parseConfig({
  app: { id: "dev.parlor.hello", name: "Hello", scheme: "hello", version: "1.2.3" },
  desktop: { width: 900, height: 700, agentHost: true },
});

describe("desktop.agentHost", () => {
  it("K6: tauriConfig lists the sidecar as externalBin only with desktop.agentHost", () => {
    expect(AGENT_HOST_SIDECAR).toBe("binaries/parlor-host");
    expect(tauriConfig(config)).toMatchObject({ bundle: { active: true } });
    expect((tauriConfig(config) as { bundle: object }).bundle).not.toHaveProperty(
      "externalBin",
    );
    expect(tauriConfig(withHost)).toMatchObject({
      bundle: { externalBin: [AGENT_HOST_SIDECAR], resources: ["parlor-host.sig"] },
    });
  });

  it("registers the Keychain commands and the dialog and fs plugins for files in every app, with no sidecar without it", () => {
    const files = tauriProjectFiles(config);
    const cargo = files["src-tauri/Cargo.toml"]!;
    expect(cargo).toMatch(/parlor-shell = \{ path = ".*shell-desktop\/rust" \}/);
    expect(cargo).toContain('tauri-plugin-dialog = "2"');
    expect(cargo).toContain('tauri-plugin-fs = "2"');
    const lib = files["src-tauri/src/lib.rs"]!;
    expect(libRs(config)).toBe(lib);
    expect(lib.match(/parlor_shell::parlor_\w+,/g)).toEqual(SHELL_COMMANDS);
    expect(lib).toContain(".plugin(tauri_plugin_dialog::init())");
    expect(lib).toContain(".plugin(tauri_plugin_fs::init())");
    expect(lib).not.toContain("parlor_shell::setup");
    expect(lib).not.toContain("parlor_host_");
    expect(JSON.parse(files["src-tauri/capabilities/default.json"]!).permissions).toEqual(
      [
        "core:default",
        "notification:default",
        "deep-link:default",
        "dialog:default",
        "fs:allow-read-file",
        "fs:allow-write-file",
        "fs:allow-stat",
      ],
    );
    expect(JSON.stringify(tauriConfig(config))).not.toMatch(/parlor-host|externalBin/);
  });

  it("adds the sidecar launch and the host commands on top", () => {
    const files = tauriProjectFiles(withHost);
    const cargo = files["src-tauri/Cargo.toml"]!;
    expect(cargo).toContain('tauri-plugin-dialog = "2"');
    expect(cargo).toMatch(/parlor-shell = \{ path = ".*shell-desktop\/rust" \}/);
    expect(
      JSON.parse(files["src-tauri/capabilities/default.json"]!).permissions,
    ).toContain("dialog:default");
    const lib = files["src-tauri/src/lib.rs"]!;
    expect(lib).toContain("tauri_plugin_dialog::init()");
    expect(lib).toContain(".setup(|app| parlor_shell::setup(app))");
    expect(lib.match(/parlor_shell::parlor_\w+,/g)).toEqual([
      "parlor_shell::parlor_host_bundled,",
      "parlor_shell::parlor_host_status,",
      "parlor_shell::parlor_host_begin,",
      "parlor_shell::parlor_host_finish,",
      ...SHELL_COMMANDS,
    ]);
  });
});

describe("stageAgentHost", () => {
  async function prebuilt(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "parlor-host-pkg-"));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "parlor-host"), "binary");
    await writeFile(join(dir, "bin", "parlor-host.sig"), "{}");
    return dir;
  }

  it("copies the binary beside the target triple and the signature into the project", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "parlor-tauri-"));
    const sidecar = await stageAgentHostFrom(
      await prebuilt(),
      projectDir,
      "aarch64-apple-darwin",
    );
    expect(sidecar).toBe(
      join(projectDir, "src-tauri", "binaries", "parlor-host-aarch64-apple-darwin"),
    );
    expect(await readFile(sidecar, "utf8")).toBe("binary");
    expect((await stat(sidecar)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(projectDir, "src-tauri", "parlor-host.sig"), "utf8")).toBe(
      "{}",
    );
  });

  it("says how to build the package when its bin is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "parlor-host-pkg-"));
    await expect(
      stageAgentHostFrom(
        empty,
        await mkdtemp(join(tmpdir(), "p-")),
        "aarch64-apple-darwin",
      ),
    ).rejects.toThrow(/pnpm --filter @parlor\/agent-host-darwin-arm64 build/);
  });

  it("has no prebuilt host for another target", async () => {
    await expect(stageAgentHost("/tmp/x", "x86_64-unknown-linux-gnu")).rejects.toThrow(
      /no prebuilt Parlor Host for x86_64-unknown-linux-gnu/,
    );
  });
});

describe("prepareTauriProject", () => {
  async function loadedWithHost() {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-tauri-"));
    return { config: withHost, rootDir, configFile: "parlor.config.ts" };
  }

  it("generates the project without the sidecar and warns once when no prebuilt host exists for the target", async () => {
    const loaded = await loadedWithHost();
    const warnings: string[] = [];
    const projectDir = await prepareTauriProject(loaded, "x86_64-unknown-linux-gnu", {
      onMissingHost: "warn",
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no prebuilt Parlor Host for x86_64-unknown-linux-gnu/);
    const conf = await readFile(join(projectDir, "src-tauri", "tauri.conf.json"), "utf8");
    expect(conf).not.toMatch(/parlor-host|externalBin/);
    const lib = await readFile(join(projectDir, "src-tauri", "src", "lib.rs"), "utf8");
    expect(lib).not.toMatch(/parlor_host_|parlor_shell::setup/);
    expect(lib).toContain("parlor_shell::parlor_session_get,");
  });

  it("fails with the staging error when the prebuilt bin is missing", async () => {
    const loaded = await loadedWithHost();
    const warnings: string[] = [];
    await expect(
      prepareTauriProject(loaded, "aarch64-apple-darwin", {
        stage: (dir, triple) =>
          stageAgentHostFrom(join(loaded.rootDir, "no-package"), dir, triple),
        warn: (message) => warnings.push(message),
      }),
    ).rejects.toBeInstanceOf(AgentHostStageError);
    expect(warnings).toEqual([]);
  });

  it("warns and goes on without the sidecar when asked to and the prebuilt bin is missing", async () => {
    const loaded = await loadedWithHost();
    const warnings: string[] = [];
    const projectDir = await prepareTauriProject(loaded, "aarch64-apple-darwin", {
      onMissingHost: "warn",
      stage: (dir, triple) =>
        stageAgentHostFrom(join(loaded.rootDir, "no-package"), dir, triple),
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(
      await readFile(join(projectDir, "src-tauri", "tauri.conf.json"), "utf8"),
    ).not.toContain("externalBin");
  });

  it("keeps the sidecar and stays quiet when the host is staged", async () => {
    const loaded = await loadedWithHost();
    const warnings: string[] = [];
    const staged: string[] = [];
    const projectDir = await prepareTauriProject(loaded, "aarch64-apple-darwin", {
      stage: async (dir, triple) => {
        staged.push(dir, triple);
        return dir;
      },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(staged).toEqual([projectDir, "aarch64-apple-darwin"]);
    expect(
      await readFile(join(projectDir, "src-tauri", "tauri.conf.json"), "utf8"),
    ).toContain("externalBin");
  });

  it("does not stage anything without desktop.agentHost", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-tauri-"));
    const stage = async () => {
      throw new Error("staged");
    };
    await expect(
      prepareTauriProject({ config, rootDir, configFile: "x" }, "aarch64-apple-darwin", {
        stage,
      }),
    ).resolves.toBe(join(rootDir, ".parlor", "tauri"));
  });

  it("does not swallow an unexpected staging failure", async () => {
    const loaded = await loadedWithHost();
    await expect(
      prepareTauriProject(loaded, "aarch64-apple-darwin", {
        stage: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
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
