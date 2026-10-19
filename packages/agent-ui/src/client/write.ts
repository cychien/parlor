import type { UiError, UiOpInput, UiOpResults } from "../protocol.js";
import type { AnyAgentView } from "../view.js";
import type { BrowserEnvironment } from "./environment.js";
import { jsonEqual } from "./json-equal.js";
import type { AgentWrites, MountedView, ViewRegistryRuntime } from "./registry.js";

export { jsonEqual };

export function notMounted(input: { view: string; key?: string | undefined }): UiError {
  const target = input.key === undefined ? input.view : `${input.view} ${input.key}`;
  return {
    code: "not_mounted",
    message: `${target} is not on screen. Call ui_screen to see what is.`,
  };
}

/**
 * The fields of `changed` the user is typing in right now: the document has focus and the
 * active element, a named input inside `target`, is one of them. A window the user left
 * (terminal focused) never blocks, even with the caret still in a field.
 */
export function userEditing(
  registry: Pick<ViewRegistryRuntime, "owner">,
  target: MountedView,
  changed: readonly string[],
  env: Pick<BrowserEnvironment, "document">,
): readonly string[] {
  const document = env.document;
  if (!document?.hasFocus()) return [];
  const active = document.activeElement;
  if (!active || registry.owner(active) !== target) return [];
  const name = active.getAttribute("name");
  return name !== null && changed.includes(name) ? [name] : [];
}

const NO_FIELDS: ReadonlySet<string> = new Set();

export function agentFieldsOf(
  writes: AgentWrites,
  current: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  if (writes.size === 0) return NO_FIELDS;
  return new Set(
    [...writes.keys()].filter((field) => jsonEqual(current[field], writes.get(field))),
  );
}

function refused(view: AnyAgentView, fields: readonly string[], detail: string): UiError {
  return {
    code: "not_writable",
    message: `${view.name}: ${detail}`,
    issues: fields.map((path) => ({ path, message: "Not writable" })),
  };
}

function unlistedFields(view: AnyAgentView, changed: readonly string[]): string[] {
  const { writable } = view;
  if (writable === true) return [];
  return changed.filter((field) => writable === false || !writable.includes(field));
}

function writableDetail(view: AnyAgentView): string {
  const { writable } = view;
  return writable === false || writable === true || writable.length === 0
    ? "this view is read-only."
    : `only ${writable.join(", ")} can be written.`;
}

const pick = (source: Readonly<Record<string, unknown>>, fields: readonly string[]) =>
  Object.fromEntries(
    fields.filter((f) => Object.hasOwn(source, f)).map((f) => [f, source[f]]),
  );

const segmentOf = (segment: PropertyKey | { readonly key: PropertyKey }) =>
  String(typeof segment === "object" ? segment.key : segment);

export async function setView(
  registry: ViewRegistryRuntime,
  input: UiOpInput<"set">,
  env: Pick<BrowserEnvironment, "document">,
): Promise<UiOpResults["set"] | UiError> {
  const target = registry.find(input);
  if (!target) return notMounted(input);
  const { view, binding } = target;
  const changed = Object.keys(input.value);

  const unlisted = unlistedFields(view, changed);
  if (unlisted.length > 0 || !binding.set) {
    return refused(view, unlisted.length > 0 ? unlisted : changed, writableDetail(view));
  }
  const editing = userEditing(registry, target, changed, env);
  if (editing.length > 0) {
    return {
      code: "user_editing",
      message: `The user is typing in ${editing.join(", ")}. Wait, or ask them.`,
      issues: editing.map((path) => ({ path, message: "The user is typing here." })),
    };
  }

  const checked = await view.schema["~standard"].validate({
    ...binding.get(),
    ...input.value,
  });
  if (checked.issues) {
    return {
      code: "invalid_value",
      message: `${view.name} would be invalid with this value.`,
      issues: checked.issues.map(({ path, message }) => ({
        path: path?.map(segmentOf).join(".") ?? "",
        message,
      })),
    };
  }
  const parsed = checked.value;
  const dropped = changed.filter((field) => !Object.hasOwn(parsed, field));
  if (dropped.length > 0) {
    return refused(view, dropped, `${dropped.join(", ")} is not a field of this view.`);
  }

  const accepted = pick(parsed, changed);
  const previous = target.writes;
  registry.remember(target, accepted);
  try {
    await binding.set(parsed, changed);
  } catch (error) {
    registry.restore(target, previous);
    throw error;
  }

  const value = registry.find(input)?.binding.get() ?? parsed;
  const normalised = changed.filter((field) => !jsonEqual(value[field], accepted[field]));
  if (normalised.length > 0) registry.remember(target, pick(value, normalised));
  return { value, agentFields: [...agentFieldsOf(target.writes, value)] };
}
