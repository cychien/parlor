import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ViewSchema = StandardSchemaV1<unknown, Readonly<Record<string, unknown>>>;

export type ViewField<S extends ViewSchema> = keyof StandardSchemaV1.InferOutput<S> &
  string;

export type ViewWritable<S extends ViewSchema> = boolean | readonly ViewField<S>[];

export interface AgentViewConfig<
  N extends string,
  S extends ViewSchema,
  K extends boolean,
  W extends ViewWritable<S>,
> {
  readonly name: N;
  readonly description: string;
  readonly schema: S;
  readonly keyed?: K | undefined;
  /** `true` opens every top-level field to `ui_set`, a list opens only those. Default `false`. */
  readonly writable?: W | undefined;
}

const kView: unique symbol = Symbol.for("parlor.agentView");

export interface AgentViewDefinition<
  N extends string = string,
  S extends ViewSchema = ViewSchema,
  K extends boolean = boolean,
  W extends boolean | readonly string[] = boolean | readonly string[],
> {
  readonly [kView]: true;
  readonly name: N;
  readonly description: string;
  readonly schema: S;
  readonly keyed: K;
  readonly writable: W;
}

export type AnyAgentView = AgentViewDefinition<
  string,
  ViewSchema,
  boolean,
  boolean | readonly string[]
>;

export function defineAgentView<
  const N extends string,
  S extends ViewSchema,
  const K extends boolean = false,
  const W extends ViewWritable<S> = false,
>(config: AgentViewConfig<N, S, K, W>): AgentViewDefinition<N, S, K, W> {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    keyed: (config.keyed ?? false) as K,
    writable: (config.writable ?? false) as W,
    [kView]: true,
  };
}

export function isAgentView(value: unknown): value is AnyAgentView {
  return typeof value === "object" && value !== null && kView in value;
}

export type ViewValue<D extends AnyAgentView> = StandardSchemaV1.InferOutput<D["schema"]>;

type FieldsOf<W, D extends AnyAgentView> = W extends true
  ? ViewField<D["schema"]>
  : W extends readonly (infer F)[]
    ? F
    : never;

export type WritableField<D extends AnyAgentView> = FieldsOf<D["writable"], D>;

export type IsWritable<D extends AnyAgentView> = [WritableField<D>] extends [never]
  ? false
  : true;

type KeyBinding<D extends AnyAgentView> = D["keyed"] extends true
  ? { readonly key: string }
  : { readonly key?: undefined };

/**
 * Applies an agent's write. `next` is the whole value, already validated by the view's
 * schema; `changed` lists the fields the agent sent. Contract: once `set` returns (or its
 * promise resolves), `get()` reflects the write. `useAgentView` keeps it for React state by
 * running `set` inside `flushSync`.
 */
export type ViewSetter<D extends AnyAgentView> = (
  next: ViewValue<D>,
  changed: readonly WritableField<D>[],
) => void | Promise<void>;

type SetBinding<D extends AnyAgentView> =
  IsWritable<D> extends true
    ? { readonly set: ViewSetter<D> }
    : { readonly set?: undefined };

export type AgentViewBinding<D extends AnyAgentView> = {
  readonly get: () => ViewValue<D>;
} & KeyBinding<D> &
  SetBinding<D>;

export interface ViewRef {
  readonly view: string;
  readonly key?: string | undefined;
}
