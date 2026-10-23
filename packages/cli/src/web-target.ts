import type { LoadedConfig } from "@parlor/config";
import {
  buildServer,
  PresetError,
  resolvePreset,
  type ServerBuildResult,
} from "@parlor/host";
import { buildWeb, startWebDev } from "@parlor/shell-web";

import { CliError } from "./errors.js";
import { startServerProcess, untilListening } from "./server-process.js";
import { onShutdown } from "./shutdown.js";
import type { BuildOptions, TargetHandler } from "./targets.js";

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && /already in use/.test(error.message);
}

export async function buildWebAndServer(
  loaded: LoadedConfig,
  options: BuildOptions,
): Promise<ServerBuildResult> {
  const outDir = await buildWeb(loaded);
  console.log(`web build written to ${outDir}`);
  try {
    const { preset, reason } = resolvePreset(options.preset, loaded.config.deploy.preset);
    console.log(`building server for ${preset} (${reason})`);
    const result = await buildServer(loaded, { preset });
    console.log(
      `server build written to ${result.outputDir} (sync: ${result.syncTransport})`,
    );
    return result;
  } catch (error) {
    if (error instanceof PresetError) throw new CliError(error.message, { cause: error });
    throw error;
  }
}

export const webTarget: TargetHandler = {
  async dev(loaded) {
    const serverProcess = startServerProcess(loaded);
    await untilListening(serverProcess, loaded.config.server.port);
    try {
      const server = await startWebDev(loaded);
      onShutdown(() => server.close());
    } catch (error) {
      if (isPortInUse(error)) {
        throw new CliError(
          `Port ${loaded.config.web.port} was taken while parlor dev was starting. Run it again.`,
          { cause: error },
        );
      }
      throw error;
    }
  },
  async build(loaded, options) {
    await buildWebAndServer(loaded, options);
  },
};
