import { buildDesktop, startDesktopDev, TauriCliError } from "@parlor/shell-desktop";

import { CliError } from "./errors.js";
import { startServerProcess } from "./server-process.js";
import { onShutdown } from "./shutdown.js";
import type { Target, TargetHandler } from "./targets.js";

const HOST_TARGET: Partial<Record<NodeJS.Platform, Target>> = {
  darwin: "mac",
  win32: "windows",
  linux: "linux",
};

export function assertHostMatches(
  target: Target,
  platform: NodeJS.Platform = process.platform,
) {
  const host = HOST_TARGET[platform];
  if (host !== target) {
    throw new CliError(
      `Target "${target}" can only be built on its own operating system. This machine builds "${host ?? "nothing"}".`,
    );
  }
}

async function surfaceTauriErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TauriCliError)
      throw new CliError(error.message, { cause: error });
    throw error;
  }
}

export function desktopTarget(target: Target): TargetHandler {
  return {
    async dev(loaded) {
      assertHostMatches(target);
      await surfaceTauriErrors(async () => {
        startServerProcess(loaded);
        const controller = new AbortController();
        onShutdown(() => controller.abort());
        await startDesktopDev(loaded, { signal: controller.signal });
      });
    },
    async build(loaded) {
      assertHostMatches(target);
      const bundleDir = await surfaceTauriErrors(() => buildDesktop(loaded));
      console.log(`desktop bundles written to ${bundleDir}`);
    },
  };
}
