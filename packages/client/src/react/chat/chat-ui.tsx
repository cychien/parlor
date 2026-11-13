import { type ChatUiCatalog, parseUiProps, UI_LIMITS, type UiSpec } from "@parlor/chat";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type ComponentType, Fragment, type ReactNode } from "react";

type PropsOf<C extends ChatUiCatalog, K extends keyof C> = StandardSchemaV1.InferOutput<
  C[K]["props"]
> &
  (C[K]["children"] extends true ? { readonly children: ReactNode } : unknown);

/** The app's React component for each catalog entry, taking that entry's parsed props. */
export type ChatUiComponents<C extends ChatUiCatalog> = {
  readonly [K in keyof C]: ComponentType<PropsOf<C, K>>;
};

export interface ChatUiProps<C extends ChatUiCatalog> {
  readonly spec: UiSpec;
  readonly catalog: C;
  readonly components: ChatUiComponents<C>;
  /**
   * In place of an element the catalog no longer describes, as an old message can hold one
   * after the catalog changed. Nothing by default.
   */
  readonly fallback?: ReactNode;
}

/**
 * Renders a `ui` item's tree with the app's components, each element's props parsed by its
 * catalog entry again. Adds no DOM and no style of its own.
 */
export function Ui<C extends ChatUiCatalog>({
  spec,
  catalog,
  components,
  fallback = null,
}: ChatUiProps<C>) {
  const seen = new Set<string>();
  const render = (key: string, depth: number): ReactNode => {
    const element = spec.elements[key];
    if (!element || seen.has(key) || depth > UI_LIMITS.depth) return fallback;
    seen.add(key);
    const entry = Object.hasOwn(catalog, element.type)
      ? catalog[element.type]
      : undefined;
    const Component = entry
      ? (components[element.type] as ComponentType<object>)
      : undefined;
    const props = entry ? parseUiProps(entry, element.props) : undefined;
    if (!entry || !Component || !props || !("value" in props)) return fallback;
    const children = entry.children
      ? (element.children ?? []).map((child) => (
          <Fragment key={child}>{render(child, depth + 1)}</Fragment>
        ))
      : undefined;
    return <Component {...props.value} {...(entry.children ? { children } : {})} />;
  };
  return <>{render(spec.root, 1)}</>;
}
