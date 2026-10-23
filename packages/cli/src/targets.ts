import type { LoadedConfig } from "@parlor/config";

import { CliError } from "./errors.js";

export const TARGETS = ["web", "ios", "android", "mac", "windows", "linux"] as const;
export type Target = (typeof TARGETS)[number];

export interface DevOptions {
  readonly device?: string | undefined;
  /** The web target's origin when this target runs next to it, so both pair once. */
  readonly appOrigin?: string | undefined;
}

export interface BuildOptions {
  readonly preset?: string | undefined;
}

export interface TargetHandler {
  /** Throws when this machine cannot run the target, before `parlor dev` starts anything. */
  assertHost?(): void;
  /** Starts this target's frontend; `parlor dev` already runs the server it talks to. */
  dev(loaded: LoadedConfig, options: DevOptions): Promise<void>;
  build(loaded: LoadedConfig, options: BuildOptions): Promise<void>;
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

/** `web,mac` runs both against one server; the first is the default `web`. */
export function parseTargets(value: unknown): readonly Target[] {
  const names = (value === undefined ? "web" : String(value))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const targets = [...new Set(names.map(parseTarget))];
  if (targets.length === 0) return ["web"];
  return targets;
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
