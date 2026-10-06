import type { Target, TargetHandler } from "./targets.js";
import { webTarget } from "./web-target.js";

export const handlers: Partial<Record<Target, TargetHandler>> = {
  web: webTarget,
};
