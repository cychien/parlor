import type { LoadedConfig } from "@parlor/config";
import { startWebDev } from "@parlor/shell-web";

import { runCapacitor } from "./capacitor-cli.js";
import { applyIosScheme, ensurePlatform } from "./platforms.js";
import { assertMobileToolchain, type MobilePlatform } from "./prerequisites.js";
import { ensureCapacitorProject } from "./project.js";
import { listIosSimulators, pickIosSimulator } from "./simulators.js";

export const CAPACITOR_CONDITION = "parlor-capacitor";

export interface MobileDevOptions {
  readonly device?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

function runArgs(platform: MobilePlatform, device: string | undefined): string[] {
  if (platform === "ios") {
    const simulator = pickIosSimulator(listIosSimulators(), device);
    console.log(`Using simulator ${simulator.name}`);
    return ["run", "ios", "--target", simulator.udid];
  }
  return device ? ["run", "android", "--target", device] : ["run", "android"];
}

export async function startMobileDev(
  loaded: LoadedConfig,
  platform: MobilePlatform,
  options: MobileDevOptions = {},
): Promise<void> {
  assertMobileToolchain(platform);
  const devUrl = `http://localhost:${loaded.config.web.port}`;
  const projectDir = await ensureCapacitorProject(loaded, { devUrl });
  await ensurePlatform(projectDir, platform);
  if (platform === "ios") await applyIosScheme(projectDir, loaded.config);
  const web = await startWebDev(loaded, { conditions: [CAPACITOR_CONDITION] });
  try {
    await runCapacitor(runArgs(platform, options.device), {
      cwd: projectDir,
      signal: options.signal,
    });
    if (!options.signal?.aborted) {
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve()),
      );
    }
  } finally {
    await web.close();
  }
}
