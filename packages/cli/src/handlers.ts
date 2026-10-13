import { desktopTarget } from "./desktop-target.js";
import { mobileTarget } from "./mobile-target.js";
import type { Target, TargetHandler } from "./targets.js";
import { webTarget } from "./web-target.js";

export const handlers: Partial<Record<Target, TargetHandler>> = {
  web: webTarget,
  ios: mobileTarget("ios"),
  android: mobileTarget("android"),
  mac: desktopTarget("mac"),
  windows: desktopTarget("windows"),
  linux: desktopTarget("linux"),
};
