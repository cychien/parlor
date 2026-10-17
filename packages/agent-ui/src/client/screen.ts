import type { QuerySnapshot, RouteSnapshot, ScreenSnapshot } from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";
import type { RegistryReader } from "./registry.js";

export interface ScreenLimits {
  readonly totalBytes: number;
  readonly valueBytes: number;
  readonly itemsPerView: number;
  readonly selectionChars: number;
}

export const DEFAULT_SCREEN_LIMITS: ScreenLimits = {
  totalBytes: 64 * 1024,
  valueBytes: 8 * 1024,
  itemsPerView: 50,
  selectionChars: 2000,
};

export interface PageSources {
  route(): RouteSnapshot | null;
  queries(): readonly QuerySnapshot[];
}

export function captureScreen(
  registry: RegistryReader,
  page: PageSources,
  env: BrowserEnvironment,
  limits: ScreenLimits,
): ScreenSnapshot {
  void registry;
  void page;
  void env;
  void limits;
  throw new Error("not implemented");
}
