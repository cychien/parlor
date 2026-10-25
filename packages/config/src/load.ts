import { resolve } from "node:path";

import { loadConfig } from "c12";
import { z } from "zod";

import { type ParlorConfig, parlorConfigSchema } from "./schema.js";

export const CONFIG_NAME = "parlor";
export const GENERATED_DIR = ".parlor";
export const GENERATED_DIR_ENV = "PARLOR_GENERATED_DIR";

/**
 * Where this run keeps its generated files and local state: `.parlor`, or the directory
 * `PARLOR_GENERATED_DIR` names, absolute or relative to the project.
 */
export function generatedDir(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(rootDir, env[GENERATED_DIR_ENV] || GENERATED_DIR);
}

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
