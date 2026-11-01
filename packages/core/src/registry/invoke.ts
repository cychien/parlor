import type { ActionContext, AnyAction, DataProvider, Tag } from "../action.js";
import { isMutating, needsPrincipal } from "../action.js";
import { type ConfirmationPolicy, defaultConfirmationPolicy } from "../confirmation.js";
import { ActionError } from "../errors.js";
import { ANONYMOUS, type Principal } from "../principal.js";
import { readTagsFor, writeTagsFor } from "../tags.js";
import type { ActionRegistry } from "./registry.js";

/** A caller that names no principal is anonymous: missing identity never widens access. */
export type InvokeContext = Omit<ActionContext, "db" | "principal"> & {
  readonly principal?: Principal | undefined;
};

export interface WriteEvent {
  readonly action: AnyAction;
  readonly name: string;
  readonly tags: Tag[];
  readonly ctx: InvokeContext;
  readonly tx: unknown;
}

export interface PreparedCall {
  readonly action: AnyAction;
  readonly name: string;
  readonly input: unknown;
  readonly ctx: InvokeContext;
}

export interface InvokeOptions {
  readonly data?: DataProvider | undefined;
  readonly onWrite?: ((event: WriteEvent) => Promise<void>) | undefined;
  readonly confirm?: ((call: PreparedCall) => Promise<void>) | undefined;
  /** Whether a call is asked about, run or refused before `run`; `defaultConfirmationPolicy` when absent. */
  readonly confirmation?: ConfirmationPolicy | undefined;
  /** Called when the policy runs a call the default policy would have asked about or refused. */
  readonly onWaived?: (() => void) | undefined;
  /** An enforcing auth provider is installed: non-public actions refuse anonymous callers. */
  readonly enforcing?: boolean | undefined;
  /** Called once, right before `run`: every earlier refusal leaves it uncalled. */
  readonly onRun?: (() => void) | undefined;
}

export interface InvokeResult {
  readonly data: unknown;
  readonly reads: Tag[];
  readonly writes: Tag[];
}

export async function invokeAction(
  registry: ActionRegistry,
  name: string,
  rawInput: unknown,
  ctx: InvokeContext,
  options: InvokeOptions = {},
): Promise<InvokeResult> {
  const action = registry.get(name);
  if (!action) throw new ActionError("not_found", `Unknown action "${name}"`);
  const principal = ctx.principal ?? ANONYMOUS;
  if (
    principal.kind === "anonymous" &&
    needsPrincipal(action, options.enforcing === true)
  ) {
    throw new ActionError("unauthenticated", `Sign in to call "${name}".`);
  }

  const parsed = await action.input.safeParseAsync(rawInput ?? {});
  if (!parsed.success) {
    throw new ActionError("invalid_input", `Invalid input for "${name}"`, {
      issues: parsed.error.issues,
    });
  }
  const input = parsed.data;
  const { data, onWrite, confirm, confirmation = defaultConfirmationPolicy } = options;
  const call = { name, action, principal, source: ctx.source };
  switch (confirmation(call)) {
    case "proceed":
      if (defaultConfirmationPolicy(call) !== "proceed") options.onWaived?.();
      break;
    case "refuse":
      throw new ActionError(
        "confirmation_unavailable",
        `"${name}" needs a person's approval, and nobody can give it for this caller. Ask the user to do it in the app themselves.`,
      );
    case "ask":
      if (!confirm) {
        throw new ActionError(
          "confirmation_unavailable",
          `"${name}" needs the user's approval, but nothing here can ask for it.`,
        );
      }
      await confirm({ action, name, input, ctx: { ...ctx, principal } });
  }
  const reads = readTagsFor(action, input);

  if (!data) {
    options.onRun?.();
    const result = await action.run(input, { ...ctx, principal, db: undefined as never });
    return { data: result, reads, writes: writeTagsFor(action, result) };
  }

  if (!isMutating(action)) {
    options.onRun?.();
    const result = await action.run(input, {
      ...ctx,
      principal,
      db: data.read() as never,
    });
    return { data: result, reads, writes: [] };
  }

  return data.transaction(async (tx) => {
    options.onRun?.();
    const result = await action.run(input, { ...ctx, principal, db: tx as never });
    const writes = writeTagsFor(action, result);
    await onWrite?.({ action, name, tags: writes, ctx, tx });
    return { data: result, reads, writes };
  });
}
