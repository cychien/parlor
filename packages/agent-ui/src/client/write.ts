import type { UiError, UiOpInput, UiOpResults } from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";
import type { AgentWrites, MountedView, ViewRegistryRuntime } from "./registry.js";

export function notMounted(_input: { view: string; key?: string | undefined }): UiError {
  throw new Error("not implemented");
}

export function userEditing(
  _registry: Pick<ViewRegistryRuntime, "owner">,
  _target: MountedView,
  _changed: readonly string[],
  _env: Pick<BrowserEnvironment, "document">,
): readonly string[] {
  throw new Error("not implemented");
}

export function jsonEqual(_a: unknown, _b: unknown): boolean {
  throw new Error("not implemented");
}

export function agentFieldsOf(
  _writes: AgentWrites,
  _current: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  throw new Error("not implemented");
}

export async function setView(
  _registry: ViewRegistryRuntime,
  _input: UiOpInput<"set">,
  _env: Pick<BrowserEnvironment, "document">,
): Promise<UiOpResults["set"] | UiError> {
  throw new Error("not implemented");
}
