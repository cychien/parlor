import { buildWeb, startWebDev } from "@parlor/shell-web";

import { CliError } from "./errors.js";
import { startServerProcess } from "./server-process.js";
import { onShutdown } from "./shutdown.js";
import type { TargetHandler } from "./targets.js";

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && /already in use/.test(error.message);
}

export const webTarget: TargetHandler = {
  async dev(loaded) {
    startServerProcess(loaded);
    try {
      const server = await startWebDev(loaded);
      onShutdown(() => server.close());
    } catch (error) {
      if (isPortInUse(error)) {
        throw new CliError(
          `Port ${loaded.config.web.port} is already in use. Pass --port or change web.port in parlor.config.ts.`,
          { cause: error },
        );
      }
      throw error;
    }
  },
  async build(loaded) {
    const outDir = await buildWeb(loaded);
    console.log(`web build written to ${outDir}`);
  },
};
