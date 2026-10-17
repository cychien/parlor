import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ViewSchema = StandardSchemaV1<unknown, Readonly<Record<string, unknown>>>;

export interface AgentViewConfig<
  N extends string,
  S extends ViewSchema,
  K extends boolean,
> {
  readonly name: N;
  readonly description: string;
  readonly schema: S;
  readonly keyed?: K | undefined;
}

const kView: unique symbol = Symbol.for("parlor.agentView");

export interface AgentViewDefinition<
  N extends string = string,
  S extends ViewSchema = ViewSchema,
  K extends boolean = boolean,
> {
  readonly [kView]: true;
  readonly name: N;
  readonly description: string;
  readonly schema: S;
  readonly keyed: K;
}

export type AnyAgentView = AgentViewDefinition<string, ViewSchema, boolean>;

export function defineAgentView<
  const N extends string,
  S extends ViewSchema,
  const K extends boolean = false,
>(config: AgentViewConfig<N, S, K>): AgentViewDefinition<N, S, K> {
  void config;
  void kView;
  throw new Error("not implemented");
}

export function isAgentView(value: unknown): value is AnyAgentView {
  void value;
  throw new Error("not implemented");
}

export type ViewValue<D extends AnyAgentView> = StandardSchemaV1.InferOutput<D["schema"]>;

type KeyBinding<D extends AnyAgentView> = D["keyed"] extends true
  ? { readonly key: string }
  : { readonly key?: undefined };

export type AgentViewBinding<D extends AnyAgentView> = {
  readonly get: () => ViewValue<D>;
} & KeyBinding<D>;

export interface ViewRef {
  readonly view: string;
  readonly key?: string | undefined;
}
