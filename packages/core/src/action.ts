import type { z } from "zod";

import type { Principal, PrincipalKind } from "./principal.js";

export type ActionSource = "ui" | "agent" | "http" | "mcp";

export interface DataRegister {}

export type ParlorDatabase = DataRegister extends { database: infer D } ? D : unknown;

export type Unlisten = () => Promise<void>;

export interface ListenOptions {
  /**
   * The connection behind this listener dropped. It is gone for good, and notifications
   * sent until a new `listen` call succeeds are lost, so a listener must listen again and
   * reload whatever it derived from them.
   */
  readonly onLost?: (() => void) | undefined;
}

export interface DataProvider<TDb = unknown> {
  read(): TDb;
  transaction<T>(run: (tx: TDb) => Promise<T>): Promise<T>;
  listen?(
    channel: string,
    handler: (payload: string) => void,
    options?: ListenOptions,
  ): Promise<Unlisten>;
  close?(): Promise<void>;
}

export interface ActionContext {
  readonly scope: string;
  readonly source: ActionSource;
  readonly principal: Principal;
  readonly db: ParlorDatabase;
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
  /**
   * Whose clients its `writes` wake: everyone in the scope (the default), or only the
   * caller's own user, with their tabs and computers, when the scope is shared.
   */
  readonly notifies?: "scope" | "user" | undefined;
  /**
   * Ask the user to approve each call from an agent (source `mcp` or `agent`) in the app
   * before it runs. Calls from the app's own UI and plain HTTP never ask. With an enforcing
   * auth provider the source comes from the caller's credential, so this is a boundary;
   * without one it stays a UX guard over a self-declared header.
   */
  readonly confirm?: boolean | undefined;
  /**
   * Callable without signing in. Only read when the server has an enforcing auth provider,
   * which otherwise answers an anonymous caller with `unauthenticated`.
   */
  readonly public?: boolean | undefined;
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

const CONFIRMED_SOURCES: ReadonlySet<ActionSource> = new Set(["mcp", "agent"]);

export function needsConfirmation(action: AnyAction, source: ActionSource): boolean {
  return action.confirm === true && CONFIRMED_SOURCES.has(source);
}

const SOURCE_BY_KIND = {
  anonymous: "http",
  user: "ui",
  agent: "mcp",
  host: "http",
} as const satisfies Record<PrincipalKind, ActionSource>;

export function sourceOfPrincipal(principal: Principal): ActionSource {
  if (principal.kind === "agent" && principal.turn) return "agent";
  return SOURCE_BY_KIND[principal.kind];
}

export function needsPrincipal(action: AnyAction, enforcing: boolean): boolean {
  return enforcing && action.public !== true;
}

export type ActionInput<A> =
  A extends ActionDefinition<infer I, unknown> ? z.input<I> : never;
export type ActionOutput<A> = A extends ActionDefinition<z.ZodType, infer O> ? O : never;
