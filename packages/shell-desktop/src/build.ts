import { join } from "node:path";

import type { LoadedConfig } from "@parlor/config";
import { buildWeb } from "@parlor/shell-web";

import { TAURI_CONDITION } from "./dev.js";
import { assertRustToolchain } from "./prerequisites.js";
import { ensureTauriProject, stageAgentHost } from "./project.js";
import { hostTargetTriple } from "./target-triple.js";
import { runTauri } from "./tauri-cli.js";

export async function buildDesktop(loaded: LoadedConfig): Promise<string> {
  assertRustToolchain();
  const projectDir = await ensureTauriProject(loaded);
  if (loaded.config.desktop.agentHost) {
    await stageAgentHost(projectDir, hostTargetTriple());
  }
  await buildWeb(loaded, {
    conditions: [TAURI_CONDITION],
    serverUrl: loaded.config.server.url,
  });
  await runTauri(["build"], { cwd: projectDir });
  return join(projectDir, "src-tauri", "target", "release", "bundle");
}
