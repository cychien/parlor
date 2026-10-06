import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ParlorConfig } from "@parlor/config";

import { runCapacitor } from "./capacitor-cli.js";
import { withUrlScheme } from "./ios-plist.js";
import type { MobilePlatform } from "./prerequisites.js";

export const IOS_INFO_PLIST = "ios/App/App/Info.plist";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function ensurePlatform(
  projectDir: string,
  platform: MobilePlatform,
): Promise<void> {
  if (await exists(join(projectDir, platform))) return;
  await runCapacitor(["add", platform], { cwd: projectDir });
}

export async function applyIosScheme(
  projectDir: string,
  config: ParlorConfig,
): Promise<void> {
  if (!config.app.scheme) return;
  const plistPath = join(projectDir, IOS_INFO_PLIST);
  const plist = await readFile(plistPath, "utf8");
  const patched = withUrlScheme(plist, config.app.id, config.app.scheme);
  if (patched !== plist) await writeFile(plistPath, patched);
}
