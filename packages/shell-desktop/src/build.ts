import { join } from "node:path";

import type { LoadedConfig } from "@parlor/config";
import { buildWeb } from "@parlor/shell-web";

import { TAURI_CONDITION } from "./dev.js";
import { assertRustToolchain } from "./prerequisites.js";
import { ensureTauriProject } from "./project.js";
import { runTauri } from "./tauri-cli.js";

export async function buildDesktop(loaded: LoadedConfig): Promise<string> {
  assertRustToolchain();
  const projectDir = await ensureTauriProject(loaded);
  await buildWeb(loaded, { conditions: [TAURI_CONDITION] });
  await runTauri(["build"], { cwd: projectDir });
  return join(projectDir, "src-tauri", "target", "release", "bundle");
}
