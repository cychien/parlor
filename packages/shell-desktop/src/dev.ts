import type { LoadedConfig } from "@parlor/config";
import { startWebDev } from "@parlor/shell-web";

import { assertRustToolchain } from "./prerequisites.js";
import { ensureTauriProject } from "./project.js";
import { runTauri } from "./tauri-cli.js";

export const TAURI_CONDITION = "parlor-tauri";

export interface DesktopDevOptions {
  readonly signal?: AbortSignal | undefined;
}

export async function startDesktopDev(
  loaded: LoadedConfig,
  options: DesktopDevOptions = {},
): Promise<void> {
  assertRustToolchain();
  const projectDir = await ensureTauriProject(loaded);
  const web = await startWebDev(loaded, { conditions: [TAURI_CONDITION] });
  const devUrl = `http://localhost:${loaded.config.web.port}`;
  try {
    await runTauri(["dev", "--config", JSON.stringify({ build: { devUrl } })], {
      cwd: projectDir,
      signal: options.signal,
    });
  } finally {
    await web.close();
  }
}
