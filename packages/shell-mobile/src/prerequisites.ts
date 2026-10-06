import { spawnSync } from "node:child_process";

import { CapacitorCliError } from "./capacitor-cli.js";

export type MobilePlatform = "ios" | "android";

export function hasXcode(run: typeof spawnSync = spawnSync): boolean {
  return run("xcodebuild", ["-version"], { stdio: "ignore" }).status === 0;
}

export function hasAndroidSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANDROID_HOME || env.ANDROID_SDK_ROOT);
}

export function assertMobileToolchain(
  platform: MobilePlatform,
  checks: { xcode?: () => boolean; android?: () => boolean } = {},
): void {
  if (platform === "ios" && !(checks.xcode ?? hasXcode)()) {
    throw new CapacitorCliError(
      "Xcode not found. iOS builds need the full Xcode: install it from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.",
    );
  }
  if (platform === "android" && !(checks.android ?? hasAndroidSdk)()) {
    throw new CapacitorCliError(
      "Android SDK not found. Set ANDROID_HOME to your SDK path (Android Studio installs it under ~/Library/Android/sdk on macOS).",
    );
  }
}
