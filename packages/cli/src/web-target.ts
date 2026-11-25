import type { LoadedConfig } from "@parlor/config";
import {
  buildServer,
  PresetError,
  renderConditionsFor,
  resolvePreset,
  type ServerBuildResult,
} from "@parlor/host";
import { buildRender, buildWeb, startWebDev } from "@parlor/shell-web";

import { CliError } from "./errors.js";
import { serverlessWarning } from "./serverless-warning.js";
import { onShutdown } from "./shutdown.js";

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && /already in use/.test(error.message);
}

export async function buildWebAndServer(
  loaded: LoadedConfig,
  options: { readonly preset?: string | undefined },
): Promise<ServerBuildResult> {
  const outDir = await buildWeb(loaded);
  console.log(`web build written to ${outDir}`);
  try {
    const { preset, reason } = resolvePreset(options.preset, loaded.config.deploy.preset);
    const render = loaded.config.web.ssr
      ? await buildRender(loaded, { conditions: renderConditionsFor(preset) })
      : undefined;
    if (render) console.log(`server render build written to ${render}`);
    console.log(`building server for ${preset} (${reason})`);
    const result = await buildServer(loaded, { preset, render });
    console.log(
      `server build written to ${result.outputDir} (sync: ${result.syncTransport})`,
    );
    const warning = serverlessWarning(result.syncTransport);
    if (warning) console.warn(warning);
    return result;
  } catch (error) {
    if (error instanceof PresetError) throw new CliError(error.message, { cause: error });
    throw error;
  }
}

export async function startWeb(loaded: LoadedConfig): Promise<void> {
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
}
