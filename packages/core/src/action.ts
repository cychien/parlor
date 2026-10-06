import type { z } from "zod";

export type ActionSource = "ui" | "agent" | "http" | "mcp";

export interface ActionContext {
  readonly scope: string;
  readonly source: ActionSource;
  readonly signal?: AbortSignal | undefined;
}

export interface TableLike {
  readonly _: { readonly name: string };
}

export type TagSource = string | TableLike;
export type Tag = readonly (string | number)[];
export type ReadTags<TInput> = readonly TagSource[] | ((input: TInput) => readonly Tag[]);

export interface ActionConfig<TInput extends z.ZodType, TOutput> {
  readonly description: string;
  readonly input: TInput;
  readonly reads?: ReadTags<z.output<TInput>> | undefined;
  readonly writes?: readonly TagSource[] | undefined;
  readonly run: (
    input: z.output<TInput>,
    ctx: ActionContext,
  ) => Promise<TOutput> | TOutput;
}

const kAction: unique symbol = Symbol.for("fw.action");

export interface ActionDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> extends ActionConfig<TInput, TOutput> {
  readonly [kAction]: true;
}

export type AnyAction = ActionDefinition<z.ZodType, unknown>;
export type ActionMap = Record<string, AnyAction>;

export function defineAction<TInput extends z.ZodType, TOutput>(
  config: ActionConfig<TInput, TOutput>,
): ActionDefinition<TInput, TOutput> {
  return { ...config, [kAction]: true };
}

export function isAction(value: unknown): value is AnyAction {
  return typeof value === "object" && value !== null && kAction in value;
}

export function isMutating(action: AnyAction): boolean {
  return (action.writes?.length ?? 0) > 0;
}

export type ActionInput<A> =
  A extends ActionDefinition<infer I, unknown> ? z.input<I> : never;
export type ActionOutput<A> = A extends ActionDefinition<z.ZodType, infer O> ? O : never;
