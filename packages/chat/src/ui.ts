import type { StandardSchemaV1 } from "@standard-schema/spec";

export const UI_LIMITS = {
  elements: 64,
  depth: 8,
  key: 64,
  json: 32_000,
} as const;

export interface UiElement {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children?: readonly string[] | undefined;
}

/**
 * A tree of the app's chat components, flat as json-render keeps it: every element under its
 * key, `root` naming the top one, `children` naming keys.
 */
export interface UiSpec {
  readonly root: string;
  readonly elements: Readonly<Record<string, UiElement>>;
}

export type ChatUiProps = StandardSchemaV1<unknown, Readonly<Record<string, unknown>>>;

export interface ChatUiComponent<P extends ChatUiProps = ChatUiProps> {
  /** What it shows and when to use it, written for the agent. */
  readonly description: string;
  /** Checked when the agent shows it and again when it renders; a zod object does. */
  readonly props: P;
  /** Whether it lays out other elements, given as `children`. */
  readonly children?: boolean | undefined;
}

export type ChatUiCatalog = Readonly<Record<string, ChatUiComponent>>;

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The components an agent may show in the chat, shared by the server and the app's renderer. */
export function defineChatUi<const C extends ChatUiCatalog>(catalog: C): C {
  for (const name of Object.keys(catalog)) {
    if (!NAME.test(name) || name.length > UI_LIMITS.key) {
      throw new Error(`defineChatUi(): "${name}" is not a component name.`);
    }
  }
  return catalog;
}

export interface UiIssue {
  readonly element?: string | undefined;
  readonly message: string;
}

export type UiCheck =
  | { readonly ok: true; readonly spec: UiSpec }
  | { readonly ok: false; readonly issues: readonly UiIssue[] };

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= UI_LIMITS.key;

/** The shape of a spec, whatever the catalog: keys, element fields and the size limits. */
export function parseUiSpec(input: unknown): {
  readonly spec?: UiSpec;
  readonly issue?: string;
} {
  if (!isFields(input) || !isFields(input.elements)) {
    return { issue: "A spec is { root, elements }." };
  }
  if (!isKey(input.root)) {
    return { issue: `root must be a key of 1 to ${UI_LIMITS.key} characters.` };
  }
  const entries = Object.entries(input.elements);
  if (entries.length > UI_LIMITS.elements) {
    return { issue: `At most ${UI_LIMITS.elements} elements.` };
  }
  const elements: Record<string, UiElement> = {};
  for (const [key, element] of entries) {
    if (!isKey(key))
      return { issue: `"${key}" is not a key of 1 to ${UI_LIMITS.key} characters.` };
    if (!isFields(element) || !isKey(element.type)) {
      return { issue: `${key}: an element is { type, props?, children? }.` };
    }
    if (element.props !== undefined && !isFields(element.props)) {
      return { issue: `${key}: props must be an object.` };
    }
    const children = element.children;
    if (
      children !== undefined &&
      (!Array.isArray(children) ||
        children.length > UI_LIMITS.elements ||
        !children.every(isKey))
    ) {
      return { issue: `${key}: children must list element keys.` };
    }
    elements[key] = {
      type: element.type,
      props: (element.props as Fields | undefined) ?? {},
      ...(children !== undefined ? { children: children as string[] } : {}),
    };
  }
  const spec: UiSpec = { root: input.root, elements };
  if (JSON.stringify(spec).length > UI_LIMITS.json) {
    return { issue: `At most ${UI_LIMITS.json} characters of JSON.` };
  }
  return { spec };
}

/** An element's props through its component's schema; `undefined` when they fail it or it is async. */
export function parseUiProps(
  component: ChatUiComponent,
  props: unknown,
):
  | { readonly value: Readonly<Record<string, unknown>> }
  | { readonly issues: readonly StandardSchemaV1.Issue[] } {
  const result = component.props["~standard"].validate(props);
  if (result instanceof Promise) {
    return { issues: [{ message: "Its props schema must check synchronously." }] };
  }
  return result.issues ? { issues: result.issues } : { value: result.value };
}

const pathOf = (issue: StandardSchemaV1.Issue) =>
  (issue.path ?? [])
    .map((part) => (typeof part === "object" ? part.key : part))
    .join(".");

/**
 * Checks a spec against the catalog: one tree from `root`, known types, valid props, children
 * only where a component takes them. A passing spec comes back with its props parsed.
 */
export function checkUiSpec(catalog: ChatUiCatalog, input: unknown): UiCheck {
  const parsed = parseUiSpec(input);
  if (!parsed.spec)
    return { ok: false, issues: [{ message: parsed.issue ?? "Not a spec." }] };
  const spec = parsed.spec;
  const issues: UiIssue[] = [];
  const elements: Record<string, UiElement> = {};
  const parents = new Map<string, string>();
  const visit = (name: string, depth: number) => {
    const element = spec.elements[name];
    if (!element) {
      issues.push({ element: name, message: `No element "${name}".` });
      return;
    }
    if (depth > UI_LIMITS.depth) {
      issues.push({ element: name, message: `Nested deeper than ${UI_LIMITS.depth}.` });
      return;
    }
    const component = Object.hasOwn(catalog, element.type)
      ? catalog[element.type]
      : undefined;
    if (!component) {
      issues.push({
        element: name,
        message: `Unknown type "${element.type}". Use one of: ${Object.keys(catalog).join(", ")}.`,
      });
      return;
    }
    const props = parseUiProps(component, element.props);
    if ("issues" in props) {
      for (const issue of props.issues) {
        issues.push({
          element: name,
          message: `props.${pathOf(issue)}: ${issue.message}`,
        });
      }
    }
    const children = element.children ?? [];
    if (children.length > 0 && !component.children) {
      issues.push({ element: name, message: `${element.type} takes no children.` });
    }
    elements[name] = {
      type: element.type,
      props: "value" in props ? props.value : element.props,
      ...(element.children ? { children: element.children } : {}),
    };
    for (const child of children) {
      if (parents.has(child) || child === spec.root) {
        issues.push({
          element: child,
          message: `"${child}" appears more than once in the tree.`,
        });
        continue;
      }
      parents.set(child, name);
      visit(child, depth + 1);
    }
  };
  visit(spec.root, 1);
  for (const name of Object.keys(spec.elements)) {
    if (name !== spec.root && !parents.has(name)) {
      issues.push({ element: name, message: `"${name}" is not reachable from root.` });
    }
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, spec: { root: spec.root, elements } };
}
