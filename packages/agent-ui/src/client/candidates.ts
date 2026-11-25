import type { UiError } from "../protocol.js";
import type { AnyAgentView } from "../view.js";
import type { MountedView, RegistryReader } from "./registry.js";

const MAX_LISTED = 20;

type Wanted = { readonly view: string; readonly key?: string | undefined };

type Namer = (mounted: MountedView) => string | undefined;

function writableFields(view: AnyAgentView): readonly string[] | "all" | undefined {
  const { writable } = view;
  if (writable === true) return "all";
  if (writable === false || writable.length === 0) return undefined;
  return writable;
}

/** How ui_set names a view it can write: `newTask (title, notes)` or `task t1 (done)`. */
export const writableTarget: Namer = (mounted) => {
  const fields = mounted.binding.set ? writableFields(mounted.view) : undefined;
  if (!fields) return undefined;
  const name =
    mounted.key === undefined ? mounted.view.name : `${mounted.view.name} ${mounted.key}`;
  return `${name} (${fields === "all" ? "any field" : fields.join(", ")})`;
};

/** How ui_highlight names a view it can point at: `newTask` or `task t1`. */
export const anyTarget: Namer = (mounted) =>
  mounted.key === undefined ? mounted.view.name : `${mounted.view.name} ${mounted.key}`;

function onScreen(registry: RegistryReader, pick: Namer): string[] {
  const names: string[] = [];
  for (const mounted of registry.singles()) {
    const name = pick(mounted);
    if (name) names.push(name);
  }
  for (const mounted of registry.onScreenCandidates()) {
    if (!registry.isCurrent(mounted)) continue;
    const name = pick(mounted);
    if (name) names.push(name);
  }
  return names;
}

function listed(names: readonly string[]): string {
  if (names.length === 0) return "none";
  const shown = names.slice(0, MAX_LISTED).join(", ");
  return names.length > MAX_LISTED
    ? `${shown} and ${names.length - MAX_LISTED} more`
    : shown;
}

function issuesOf(path: string, names: readonly string[]): Pick<UiError, "issues"> {
  return names.length === 0
    ? {}
    : { issues: names.slice(0, MAX_LISTED).map((message) => ({ path, message })) };
}

/**
 * A miss that says what is there, so a wrong guess costs no more than looking first.
 * `pick` names each candidate, or skips one the op cannot use.
 */
export function notMounted(
  registry: RegistryReader,
  wanted: Wanted,
  pick: Namer,
): UiError {
  const target = wanted.key === undefined ? wanted.view : `${wanted.view} ${wanted.key}`;
  const names = onScreen(registry, pick);
  return {
    code: "not_mounted",
    message: `${target} is not on screen. On screen now: ${listed(names)}.`,
    ...issuesOf("view", names),
  };
}

/** A field ui_highlight cannot find, with the fields the view does show. */
export function noSuchField(view: string, field: string, root: Element): UiError {
  const fields = [
    ...new Set(
      Array.from(root.querySelectorAll("[name]"), (element) =>
        element.getAttribute("name")!,
      ),
    ),
  ];
  return {
    code: "not_mounted",
    message: `${view} has no field ${field} on screen. Its fields: ${listed(fields)}.`,
    ...issuesOf("field", fields),
  };
}
