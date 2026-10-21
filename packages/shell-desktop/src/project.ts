import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_DIR, type LoadedConfig, type ParlorConfig } from "@parlor/config";
import { appCsp, extendCsp, serializeCsp } from "@parlor/shell-web";

const ICONS = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.icns",
  "icon.ico",
] as const;

export const TAURI_CARGO_PACKAGE = "parlor_app";
const AGENT_HOST_SIGNATURE = "parlor-host.sig";
const SHELL_CRATE_DIR = fileURLToPath(new URL("../rust", import.meta.url));

export function tauriProjectDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "tauri");
}

const TAURI_IPC_SOURCES = ["ipc:", "http://ipc.localhost"];

function tauriCsp(config: ParlorConfig, dev: boolean): string {
  const policy = appCsp(config, { serverOrigin: config.server.url, dev });
  return serializeCsp(extendCsp(policy, { "connect-src": TAURI_IPC_SOURCES }));
}

export function tauriConfig(config: ParlorConfig): Record<string, unknown> {
  return {
    $schema: "https://schema.tauri.app/config/2",
    productName: config.app.name,
    version: config.app.version,
    identifier: config.app.id,
    build: { frontendDist: "../../web" },
    app: {
      windows: [
        {
          title: config.app.name,
          width: config.desktop.width,
          height: config.desktop.height,
          resizable: true,
        },
      ],
      security: { csp: tauriCsp(config, false), devCsp: tauriCsp(config, true) },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: ICONS.map((icon) => `icons/${icon}`),
      ...(config.desktop.agentHost
        ? { externalBin: [AGENT_HOST_SIDECAR], resources: [AGENT_HOST_SIGNATURE] }
        : {}),
    },
    plugins: {
      "deep-link": { desktop: { schemes: config.app.scheme ? [config.app.scheme] : [] } },
    },
  };
}

function agentHostDependencies(config: ParlorConfig): string {
  return config.desktop.agentHost ? 'tauri-plugin-dialog = "2"\n' : "";
}

export function cargoToml(config: ParlorConfig): string {
  return `[package]
name = "${TAURI_CARGO_PACKAGE}"
version = "${config.app.version}"
description = "${config.app.description ?? config.app.name}"
edition = "2024"

[lib]
name = "${TAURI_CARGO_PACKAGE}_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-deep-link = "2"
tauri-plugin-notification = "2"
${agentHostDependencies(config)}parlor-shell = { path = ${JSON.stringify(SHELL_CRATE_DIR)} }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;
}

export const AGENT_HOST_SIDECAR = "binaries/parlor-host";

const SHELL_COMMANDS = [
  "parlor_device_key_public",
  "parlor_device_key_sign",
  "parlor_session_get",
  "parlor_session_set",
];

const AGENT_HOST_COMMANDS = [
  "parlor_host_bundled",
  "parlor_host_status",
  "parlor_host_begin",
  "parlor_host_finish",
];

/**
 * Every app registers the Keychain `parlor_session_*` and `parlor_device_key_*` commands.
 * With `desktop.agentHost`, `setup()` also runs the bundled `parlor-host daemon --ensure`
 * (adopt, install or upgrade the per-user service) and the `parlor_host_*` commands
 * and the dialog plugin join them.
 */
export function libRs(config: ParlorConfig): string {
  const agentHost = Boolean(config.desktop.agentHost);
  const commands = [...(agentHost ? AGENT_HOST_COMMANDS : []), ...SHELL_COMMANDS];
  return `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
${agentHost ? "        .plugin(tauri_plugin_dialog::init())\n        .setup(|app| parlor_shell::setup(app))\n" : ""}        .invoke_handler(tauri::generate_handler![
${commands.map((command) => `            parlor_shell::${command},`).join("\n")}
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
}

const PREBUILT_HOST_PACKAGES: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "@parlor/agent-host-darwin-arm64",
};

export class AgentHostStageError extends Error {
  override readonly name = "AgentHostStageError";
}

function prebuiltHostDir(targetTriple: string): string {
  const name = PREBUILT_HOST_PACKAGES[targetTriple];
  if (!name) {
    throw new AgentHostStageError(
      `There is no prebuilt Parlor Host for ${targetTriple}; desktop.agentHost supports ${Object.keys(PREBUILT_HOST_PACKAGES).join(", ")}.`,
    );
  }
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch (error) {
    throw new AgentHostStageError(`${name} is not installed.`, { cause: error });
  }
}

/** Copies a prebuilt host's `bin/` into the Tauri project, where `externalBin` and `resources` expect it. */
export async function stageAgentHostFrom(
  packageDir: string,
  projectDir: string,
  targetTriple: string,
): Promise<string> {
  const bin = join(packageDir, "bin");
  const source = {
    binary: join(bin, "parlor-host"),
    signature: join(bin, AGENT_HOST_SIGNATURE),
  };
  for (const file of Object.values(source)) {
    if (!(await stat(file).catch(() => undefined))) {
      throw new AgentHostStageError(
        `${file} is missing: build it with pnpm --filter @parlor/agent-host-darwin-arm64 build (needs PARLOR_HOST_SIGNING_KEY and PARLOR_HOST_RELEASE_KEY_FILE).`,
      );
    }
  }
  const sidecar = join(projectDir, "src-tauri", `${AGENT_HOST_SIDECAR}-${targetTriple}`);
  await mkdir(dirname(sidecar), { recursive: true });
  await copyFile(source.binary, sidecar);
  await chmod(sidecar, 0o755);
  await copyFile(source.signature, join(projectDir, "src-tauri", AGENT_HOST_SIGNATURE));
  return sidecar;
}

/**
 * Copies the prebuilt host for `targetTriple` from its `@parlor/agent-host-<platform>`
 * package to `binaries/parlor-host-<triple>`; copies only, compiles nothing.
 */
export async function stageAgentHost(
  projectDir: string,
  targetTriple: string,
): Promise<string> {
  return stageAgentHostFrom(prebuiltHostDir(targetTriple), projectDir, targetTriple);
}

export const MAIN_RS = `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${TAURI_CARGO_PACKAGE}_lib::run()
}
`;

export const BUILD_RS = `fn main() {
    tauri_build::build()
}
`;

export const CAPABILITIES = {
  $schema: "../gen/schemas/desktop-schema.json",
  identifier: "default",
  description: "Permissions Parlor needs on desktop",
  windows: ["main"],
  permissions: ["core:default", "notification:default", "deep-link:default"],
};

function capabilitiesOf(config: ParlorConfig) {
  if (!config.desktop.agentHost) return CAPABILITIES;
  return {
    ...CAPABILITIES,
    permissions: [...CAPABILITIES.permissions, "dialog:default"],
  };
}

export function tauriProjectFiles(config: ParlorConfig): Record<string, string> {
  return {
    "src-tauri/tauri.conf.json": `${JSON.stringify(tauriConfig(config), null, 2)}\n`,
    "src-tauri/Cargo.toml": cargoToml(config),
    "src-tauri/build.rs": BUILD_RS,
    "src-tauri/src/main.rs": MAIN_RS,
    "src-tauri/src/lib.rs": libRs(config),
    "src-tauri/capabilities/default.json": `${JSON.stringify(capabilitiesOf(config), null, 2)}\n`,
    "src-tauri/.gitignore": "target/\ngen/schemas/\n",
    ".gitignore": "*\n",
  };
}

function iconsSourceDir(): string {
  return fileURLToPath(new URL("../assets/icons/", import.meta.url));
}

async function writeIfChanged(path: string, content: string | Uint8Array): Promise<void> {
  const current = await readFile(path).catch(() => undefined);
  if (current && Buffer.compare(current, Buffer.from(content)) === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function ensureTauriProject(
  { config, rootDir }: LoadedConfig,
  icons: string = iconsSourceDir(),
): Promise<string> {
  const projectDir = tauriProjectDir(rootDir);
  for (const [relative, content] of Object.entries(tauriProjectFiles(config))) {
    await writeIfChanged(join(projectDir, relative), content);
  }
  for (const icon of ICONS) {
    await writeIfChanged(
      join(projectDir, "src-tauri", "icons", icon),
      await readFile(join(icons, icon)),
    );
  }
  return projectDir;
}

export interface PrepareTauriProjectOptions {
  /** What a missing prebuilt host does: `fail` the build, or `warn` and go on without the sidecar. */
  readonly onMissingHost?: "fail" | "warn";
  readonly stage?: typeof stageAgentHost;
  readonly warn?: (message: string) => void;
}

/**
 * Generates the Tauri project, bundling the Parlor Host sidecar when `desktop.agentHost` is
 * set. With no prebuilt host for the target it throws the staging error, or with
 * `onMissingHost: "warn"` warns once and generates the project as if `agentHost` were off,
 * so the app runs and the sidebar offers the install command.
 */
export async function prepareTauriProject(
  loaded: LoadedConfig,
  targetTriple: string,
  {
    onMissingHost = "fail",
    stage = stageAgentHost,
    warn = console.warn,
  }: PrepareTauriProjectOptions = {},
): Promise<string> {
  if (!loaded.config.desktop.agentHost) return ensureTauriProject(loaded);
  try {
    await stage(tauriProjectDir(loaded.rootDir), targetTriple);
  } catch (error) {
    if (!(error instanceof AgentHostStageError) || onMissingHost === "fail") throw error;
    warn(
      `Building without the bundled Parlor Host, so the sidebar will show the install command: ${error.message}`,
    );
    const { desktop } = loaded.config;
    return ensureTauriProject({
      ...loaded,
      config: { ...loaded.config, desktop: { ...desktop, agentHost: false } },
    });
  }
  return ensureTauriProject(loaded);
}
