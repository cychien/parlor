import { z } from "zod";

import { type ActionMap, type AnyAction, isAction, isMutating } from "../action.js";

export interface ActionDescriptor {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly inputSchema: Record<string, unknown>;
}

export interface ActionRegistry<T extends ActionMap = ActionMap> {
  readonly actions: Readonly<T>;
  get(name: string): AnyAction | undefined;
  names(): string[];
  describe(): ActionDescriptor[];
}

export type ActionsOf<R> = R extends ActionRegistry<infer T> ? T : never;

const ACTION_NAME = /^[a-z][a-zA-Z0-9]*$/;

export function createRegistry<T extends ActionMap>(actions: T): ActionRegistry<T> {
  for (const [name, action] of Object.entries(actions)) {
    if (!ACTION_NAME.test(name)) {
      throw new Error(
        `Invalid action name "${name}": use camelCase starting with a letter`,
      );
    }
    if (!isAction(action)) {
      throw new Error(`"${name}" is not an action: wrap it with defineAction()`);
    }
  }

  let descriptors: ActionDescriptor[] | undefined;

  return {
    actions,
    get: (name) => (Object.hasOwn(actions, name) ? actions[name] : undefined),
    names: () => Object.keys(actions),
    describe: () => {
      descriptors ??= Object.entries(actions).map(([name, action]) => ({
        name,
        description: action.description,
        mutating: isMutating(action),
        inputSchema: z.toJSONSchema(action.input, { io: "input" }),
      }));
      return descriptors;
    },
  };
}
