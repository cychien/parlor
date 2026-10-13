import type { ActionContext, DataProvider } from "../action.js";
import { isMutating } from "../action.js";
import { ActionError } from "../errors.js";
import type { ActionRegistry } from "./registry.js";

export type InvokeContext = Omit<ActionContext, "db">;

export interface InvokeOptions {
  readonly data?: DataProvider | undefined;
}

export async function invokeAction(
  registry: ActionRegistry,
  name: string,
  rawInput: unknown,
  ctx: InvokeContext,
  options: InvokeOptions = {},
): Promise<unknown> {
  const action = registry.get(name);
  if (!action) throw new ActionError("not_found", `Unknown action "${name}"`);

  const parsed = await action.input.safeParseAsync(rawInput ?? {});
  if (!parsed.success) {
    throw new ActionError("invalid_input", `Invalid input for "${name}"`, {
      issues: parsed.error.issues,
    });
  }

  const { data } = options;
  if (!data) return action.run(parsed.data, { ...ctx, db: undefined as never });
  if (isMutating(action)) {
    return data.transaction((tx) =>
      Promise.resolve(action.run(parsed.data, { ...ctx, db: tx as never })),
    );
  }
  return action.run(parsed.data, { ...ctx, db: data.read() as never });
}
