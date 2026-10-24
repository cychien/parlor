import { ActionError } from "@parlor/core";
import { isNotFound, isRedirect, redirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeActionErrors } from "./errors.js";

const thrown = (rethrow: (error: unknown) => never, error: unknown): unknown => {
  try {
    rethrow(error);
  } catch (caught) {
    return caught;
  }
};

describe("routeActionErrors", () => {
  it("throws notFound() for not_found", () => {
    expect(
      isNotFound(thrown(routeActionErrors(), new ActionError("not_found", "gone"))),
    ).toBe(true);
  });

  it("throws what the app names for a code, not_found included", () => {
    const rethrow = routeActionErrors({
      unauthenticated: () => redirect({ to: "/sign-in" }),
      not_found: () => redirect({ to: "/" }),
    });
    const signIn = thrown(rethrow, new ActionError("unauthenticated", "Sign in first."));
    expect(isRedirect(signIn) && signIn.options.to).toBe("/sign-in");
    const home = thrown(rethrow, new ActionError("not_found", "gone"));
    expect(isRedirect(home) && home.options.to).toBe("/");
  });

  it("passes the action's error to the handler", () => {
    const failure = new ActionError("forbidden", "Admins only");
    let seen: ActionError | undefined;
    thrown(
      routeActionErrors({
        forbidden: (error) => {
          seen = error;
          return redirect({ to: "/" });
        },
      }),
      failure,
    );
    expect(seen).toBe(failure);
  });

  it("rethrows other codes and other errors unchanged", () => {
    const rethrow = routeActionErrors({ unauthenticated: () => redirect({ to: "/" }) });
    const forbidden = new ActionError("forbidden", "no");
    const network = new TypeError("Failed to fetch");
    expect(thrown(rethrow, forbidden)).toBe(forbidden);
    expect(thrown(rethrow, network)).toBe(network);
  });
});
