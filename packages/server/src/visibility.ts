import type { ActionMap, AnyAction } from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";

import type { Caller, CallerResolver } from "./caller.js";

/** Whether the caller a test was made for may see and call `name`. */
export type VisibleTest = (name: string, action: AnyAction) => boolean;

/**
 * Decides, once per request, which of the app's actions `caller` may see and call. It
 * returns a synchronous test so lookups, such as a membership role, run once per request.
 */
export type ActionVisibility = (
  caller: Caller,
  request: Request,
) => VisibleTest | Promise<VisibleTest>;

/** The registry a request sees: every surface reads actions through it, never around it. */
export type RegistryResolver = (request: Request | undefined) => Promise<ActionRegistry>;

export function visibleRegistry(
  registry: ActionRegistry,
  test: VisibleTest,
): ActionRegistry {
  const actions: ActionMap = {};
  for (const name of registry.names()) {
    const action = registry.get(name);
    if (action && test(name, action)) actions[name] = action;
  }
  const names = Object.keys(actions);
  return {
    actions,
    get: (name) => (Object.hasOwn(actions, name) ? actions[name] : undefined),
    names: () => [...names],
    describe: () =>
      registry.describe().filter(({ name }) => Object.hasOwn(actions, name)),
  };
}

/** Resolves `visible` at most once per request; without it every request sees `registry`. */
export function createRegistryResolver(
  registry: ActionRegistry,
  visible: ActionVisibility | undefined,
  callers: CallerResolver,
): RegistryResolver {
  if (!visible) return () => Promise.resolve(registry);
  const views = new WeakMap<Request, Promise<ActionRegistry>>();
  return (request) => {
    if (!request) return Promise.resolve(registry);
    let view = views.get(request);
    if (!view) {
      view = callers(request).then(async (caller) =>
        visibleRegistry(registry, await visible(caller, request)),
      );
      views.set(request, view);
    }
    return view;
  };
}
