import type { LoadedConfig } from "@parlor/config";

import { CliError } from "./errors.js";

export const TARGETS = ["web", "ios", "android", "mac", "windows", "linux"] as const;
export type Target = (typeof TARGETS)[number];

export interface TargetHandler {
  dev(loaded: LoadedConfig): Promise<void>;
  build(loaded: LoadedConfig): Promise<void>;
}

export class TargetError extends CliError {
  override readonly name = "TargetError";
}

export function parseTarget(value: unknown): Target {
  const target = value === undefined ? "web" : String(value);
  if (!TARGETS.includes(target as Target)) {
    throw new TargetError(
      `Unknown target "${target}". Expected one of: ${TARGETS.join(", ")}`,
    );
  }
  return target as Target;
}

export function resolveHandler(
  handlers: Partial<Record<Target, TargetHandler>>,
  target: Target,
): TargetHandler {
  const handler = handlers[target];
  if (!handler) {
    throw new TargetError(`Target "${target}" is not supported yet`);
  }
  return handler;
}
