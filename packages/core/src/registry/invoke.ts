import type { ActionContext } from "../action.js";
import { ActionError } from "../errors.js";
import type { ActionRegistry } from "./registry.js";

export async function invokeAction(
  registry: ActionRegistry,
  name: string,
  rawInput: unknown,
  ctx: ActionContext,
): Promise<unknown> {
  const action = registry.get(name);
  if (!action) throw new ActionError("not_found", `Unknown action "${name}"`);

  const parsed = await action.input.safeParseAsync(rawInput ?? {});
  if (!parsed.success) {
    throw new ActionError("invalid_input", `Invalid input for "${name}"`, {
      issues: parsed.error.issues,
    });
  }

  return action.run(parsed.data, ctx);
}
