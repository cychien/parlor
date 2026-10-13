import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_DIR, type LoadedConfig, type ParlorConfig } from "@parlor/config";

const ICONS = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.icns",
  "icon.ico",
] as const;

export const TAURI_CARGO_PACKAGE = "parlor_app";

export function tauriProjectDir(rootDir: string): string {
  return join(rootDir, GENERATED_DIR, "tauri");
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
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: ICONS.map((icon) => `icons/${icon}`),
    },
    plugins: {
      "deep-link": { desktop: { schemes: config.app.scheme ? [config.app.scheme] : [] } },
    },
  };
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
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;
}

export const LIB_RS = `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;

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

export function tauriProjectFiles(config: ParlorConfig): Record<string, string> {
  return {
    "src-tauri/tauri.conf.json": `${JSON.stringify(tauriConfig(config), null, 2)}\n`,
    "src-tauri/Cargo.toml": cargoToml(config),
    "src-tauri/build.rs": BUILD_RS,
    "src-tauri/src/main.rs": MAIN_RS,
    "src-tauri/src/lib.rs": LIB_RS,
    "src-tauri/capabilities/default.json": `${JSON.stringify(CAPABILITIES, null, 2)}\n`,
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
