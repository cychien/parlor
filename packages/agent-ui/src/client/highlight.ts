import type { UiError, UiOpInput, UiOpResults } from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";
import type { ViewRegistryRuntime } from "./registry.js";

export const HIGHLIGHT_ATTRIBUTE = "data-parlor-highlight";
export const HIGHLIGHT_HOLD_MS = 2000;

export interface HighlightMarks {
  mark(element: Element): void;
  dispose(): void;
}

export function createHighlightMarks(
  _env: Pick<BrowserEnvironment, "setTimeout" | "clearTimeout">,
  _holdMs: number = HIGHLIGHT_HOLD_MS,
): HighlightMarks {
  return {
    mark() {
      throw new Error("not implemented");
    },
    dispose() {},
  };
}

export async function highlightView(
  _registry: ViewRegistryRuntime,
  _input: UiOpInput<"highlight">,
  _env: BrowserEnvironment,
  _marks: HighlightMarks,
): Promise<UiOpResults["highlight"] | UiError> {
  throw new Error("not implemented");
}
