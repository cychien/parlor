import { loadConfig } from "c12";
import { z } from "zod";

import { type ParlorConfig, parlorConfigSchema } from "./schema.js";

export const CONFIG_NAME = "parlor";
export const GENERATED_DIR = ".parlor";

export interface LoadedConfig {
  readonly config: ParlorConfig;
  readonly configFile: string;
  readonly rootDir: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export async function loadParlorConfig(
  cwd: string = process.cwd(),
): Promise<LoadedConfig> {
  const { config, configFile, layers } = await loadConfig({
    name: CONFIG_NAME,
    cwd,
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
  });

  if (!configFile || !layers || layers.length === 0) {
    throw new ConfigError(`No ${CONFIG_NAME}.config.ts found in ${cwd}`);
  }

  const parsed = parlorConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${configFile}:\n${z.prettifyError(parsed.error)}`);
  }

  return { config: parsed.data, configFile, rootDir: cwd };
}
