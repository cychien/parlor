import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GENERATED_DIR, type LoadedConfig } from "@parlor/config";
import {
  devWranglerConfig,
  PresetError,
  resolvePreset,
  type UnavailableDurableObject,
} from "@parlor/host";

import { CliError } from "../errors.js";
import { resolveWrangler, WRANGLER_MISSING } from "./wrangler.js";

export const CLOUDFLARE_DEV_DIR = join(GENERATED_DIR, "cloudflare");

export interface CloudflareDev {
  readonly configPath: string;
  readonly unavailable: readonly UnavailableDurableObject[];
}

/** Writes the Wrangler config the dev server's bindings come from, when the app deploys to cloudflare-durable. */
export async function prepareCloudflareDev(
  { config, rootDir }: Pick<LoadedConfig, "config" | "rootDir">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudflareDev | undefined> {
  let preset: string;
  try {
    preset = resolvePreset(undefined, config.deploy.preset, env).preset;
  } catch (error) {
    if (error instanceof PresetError) throw new CliError(error.message, { cause: error });
    throw error;
  }
  if (preset !== "cloudflare-durable") return undefined;
  if (!resolveWrangler(rootDir)) throw new CliError(WRANGLER_MISSING);
  const { wrangler, unavailable } = devWranglerConfig(config);
  const dir = join(rootDir, CLOUDFLARE_DEV_DIR);
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "wrangler.json");
  await writeFile(configPath, `${JSON.stringify(wrangler, null, 2)}\n`);
  return { configPath, unavailable };
}
