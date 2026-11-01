import type { AnyAction } from "@parlor/core";

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

/** An `ActionVisibility` resolved at most once per request. */
export type VisibilityResolver = (request: Request) => Promise<VisibleTest>;

export function createVisibilityResolver(
  visible: ActionVisibility,
  callers: CallerResolver,
): VisibilityResolver {
  const tests = new WeakMap<Request, Promise<VisibleTest>>();
  return (request) => {
    let test = tests.get(request);
    if (!test) {
      test = callers(request).then((caller) => visible(caller, request));
      tests.set(request, test);
    }
    return test;
  };
}
