import {
  buildMobile,
  CapacitorCliError,
  type MobilePlatform,
  startMobileDev,
} from "@parlor/shell-mobile";

import { CliError } from "./errors.js";
import { startServerProcess } from "./server-process.js";
import { onShutdown } from "./shutdown.js";
import type { TargetHandler } from "./targets.js";

export function assertIosHost(
  platform: MobilePlatform,
  host: NodeJS.Platform = process.platform,
) {
  if (platform === "ios" && host !== "darwin") {
    throw new CliError('Target "ios" can only be built on macOS.');
  }
}

async function surfaceCapacitorErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CapacitorCliError)
      throw new CliError(error.message, { cause: error });
    throw error;
  }
}

export function mobileTarget(platform: MobilePlatform): TargetHandler {
  return {
    async dev(loaded, options) {
      assertIosHost(platform);
      await surfaceCapacitorErrors(async () => {
        startServerProcess(loaded);
        const controller = new AbortController();
        onShutdown(() => controller.abort());
        await startMobileDev(loaded, platform, {
          device: options.device,
          signal: controller.signal,
        });
      });
    },
    async build(loaded) {
      assertIosHost(platform);
      const projectDir = await surfaceCapacitorErrors(() =>
        buildMobile(loaded, platform),
      );
      console.log(`${platform} project synced at ${projectDir}`);
    },
  };
}
