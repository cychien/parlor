import type { ActionContext, AnyAction, DataProvider, Tag } from "../action.js";
import { isMutating, needsConfirmation } from "../action.js";
import { ActionError } from "../errors.js";
import { readTagsFor, writeTagsFor } from "../tags.js";
import type { ActionRegistry } from "./registry.js";

export type InvokeContext = Omit<ActionContext, "db">;

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

  const parsed = await action.input.safeParseAsync(rawInput ?? {});
  if (!parsed.success) {
    throw new ActionError("invalid_input", `Invalid input for "${name}"`, {
      issues: parsed.error.issues,
    });
  }
  const input = parsed.data;
  const { data, onWrite, confirm } = options;
  if (needsConfirmation(action, ctx.source)) {
    if (!confirm) {
      throw new ActionError(
        "confirmation_unavailable",
        `"${name}" needs the user's approval, but nothing here can ask for it.`,
      );
    }
    await confirm({ action, name, input, ctx });
  }
  const reads = readTagsFor(action, input);

  if (!data) {
    const result = await action.run(input, { ...ctx, db: undefined as never });
    return { data: result, reads, writes: writeTagsFor(action, result) };
  }

  if (!isMutating(action)) {
    const result = await action.run(input, { ...ctx, db: data.read() as never });
    return { data: result, reads, writes: [] };
  }

  return data.transaction(async (tx) => {
    const result = await action.run(input, { ...ctx, db: tx as never });
    const writes = writeTagsFor(action, result);
    await onWrite?.({ action, name, tags: writes, ctx, tx });
    return { data: result, reads, writes };
  });
}
