import { join } from "node:path";

import type { LoadedConfig } from "@parlor/config";
import { buildWeb } from "@parlor/shell-web";

import { runCapacitor } from "./capacitor-cli.js";
import { CAPACITOR_CONDITION } from "./dev.js";
import { applyIosScheme, ensurePlatform } from "./platforms.js";
import { assertMobileToolchain, type MobilePlatform } from "./prerequisites.js";
import { ensureCapacitorProject } from "./project.js";

export async function buildMobile(
  loaded: LoadedConfig,
  platform: MobilePlatform,
): Promise<string> {
  assertMobileToolchain(platform);
  const projectDir = await ensureCapacitorProject(loaded);
  await ensurePlatform(projectDir, platform);
  if (platform === "ios") await applyIosScheme(projectDir, loaded.config);
  await buildWeb(loaded, { conditions: [CAPACITOR_CONDITION] });
  await runCapacitor(["sync", platform], { cwd: projectDir });
  return join(projectDir, platform);
}
