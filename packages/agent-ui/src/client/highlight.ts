import type { UiError, UiOpInput, UiOpResults } from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";
import type { ViewRegistryRuntime } from "./registry.js";
import { measure } from "./screen.js";
import { notMounted } from "./write.js";

export const HIGHLIGHT_ATTRIBUTE = "data-parlor-highlight";
export const HIGHLIGHT_HOLD_MS = 2000;

export interface HighlightMarks {
  mark(element: Element): void;
  dispose(): void;
}

export function createHighlightMarks(
  env: Pick<BrowserEnvironment, "setTimeout" | "clearTimeout">,
  holdMs: number = HIGHLIGHT_HOLD_MS,
): HighlightMarks {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const clear = (element: Element) => {
    env.clearTimeout(timers.get(element));
    timers.delete(element);
    element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
  };
  return {
    mark(element) {
      env.clearTimeout(timers.get(element));
      element.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
      timers.set(
        element,
        env.setTimeout(() => clear(element), holdMs),
      );
    },
    dispose() {
      for (const element of [...timers.keys()]) clear(element);
    },
  };
}

const quote = (name: string) => name.replace(/["\\]/g, "\\$&");

const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const CONTENT_EDITABLE =
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

function takesTyping(element: Element): boolean {
  switch (element.tagName) {
    case "TEXTAREA":
    case "SELECT":
      return true;
    case "INPUT":
      return !NON_TEXT_INPUTS.has((element as HTMLInputElement).type);
    default:
      return element.closest(CONTENT_EDITABLE) !== null;
  }
}

function typingElsewhere(
  registry: Pick<ViewRegistryRuntime, "agentFocus">,
  env: Pick<BrowserEnvironment, "document">,
  target: Element,
): Element | undefined {
  const document = env.document;
  if (!document?.hasFocus()) return undefined;
  const active = document.activeElement;
  return active &&
    active !== target &&
    active !== registry.agentFocus() &&
    takesTyping(active)
    ? active
    : undefined;
}

async function untilIntersectionsReported(env: Pick<BrowserEnvironment, "nextTask">) {
  // The observer's notification is queued after our first task, so wait for a second.
  await env.nextTask();
  await env.nextTask();
}

export async function highlightView(
  registry: ViewRegistryRuntime,
  input: UiOpInput<"highlight">,
  env: BrowserEnvironment,
  marks: HighlightMarks,
): Promise<UiOpResults["highlight"] | UiError> {
  const root = registry.find(input)?.element;
  if (!root) return notMounted(input);
  const element =
    input.field === undefined
      ? root
      : root.querySelector<HTMLElement>(`[name="${quote(input.field)}"]`);
  if (!element) {
    return {
      code: "not_mounted",
      message: `${input.view} has no field ${input.field} on screen.`,
      issues: [{ path: "field", message: input.field! }],
    };
  }
  const typing = typingElsewhere(registry, env, element);
  if (typing) {
    const name = typing.getAttribute("name") ?? typing.tagName.toLowerCase();
    return {
      code: "user_editing",
      message: `The user is typing in ${name}. Wait, or ask them.`,
      issues: [{ path: name, message: "The user is typing here." }],
    };
  }
  await registry.quietly(async () => {
    if (input.field !== undefined && env.hasFinePointer()) {
      registry.placeFocus(element as HTMLElement);
    }
    await env.scrollIntoView(element);
    await untilIntersectionsReported(env);
  });
  marks.mark(element);
  return { shown: measure(element, env).shown };
}
