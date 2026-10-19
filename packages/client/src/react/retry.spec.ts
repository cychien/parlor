import { ACTION_ERROR_CODES, ActionError } from "@parlor/core";
import { describe, expect, it } from "vitest";

import { actionRetry } from "./retry.js";

const attempts = (retry: (count: number, error: Error) => boolean, error: Error) =>
  [0, 1, 2, 3, 4].map((count) => retry(count, error));

const retriedThrice = [true, true, true, false, false];
const neverRetried = [false, false, false, false, false];

describe("actionRetry", () => {
  it.each(["not_found", "invalid_input", "declined"] as const)(
    "never retries %s, which a retry cannot change",
    (code) => {
      expect(attempts(actionRetry(), new ActionError(code, "no"))).toEqual(neverRetried);
      expect(actionRetry(true)(0, new ActionError(code, "no"))).toBe(false);
    },
  );

  it("retries three times by default what a retry can change: internal errors, confirmation outcomes and network failures", () => {
    const retry = actionRetry();
    for (const code of [
      "internal",
      "confirmation_timeout",
      "confirmation_unavailable",
    ] as const) {
      expect(attempts(retry, new ActionError(code, "later"))).toEqual(retriedThrice);
    }
    expect(attempts(retry, new TypeError("Failed to fetch"))).toEqual(retriedThrice);
    expect(attempts(retry, new ActionError("not_found", "gone"))).toEqual(neverRetried);
  });

  it("decides every code the core knows", () => {
    const retried = ACTION_ERROR_CODES.filter((code) =>
      actionRetry()(0, new ActionError(code, "x")),
    );
    expect(retried).toEqual([
      "confirmation_timeout",
      "confirmation_unavailable",
      "internal",
    ]);
  });

  it("follows the retry setting it wraps for the errors a retry can change", () => {
    const internal = new ActionError("internal", "later");
    const gone = new ActionError("not_found", "gone");
    expect(attempts(actionRetry(1), internal)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(attempts(actionRetry(false), internal)).toEqual(neverRetried);
    expect(attempts(actionRetry(true), internal)).toEqual([true, true, true, true, true]);
    expect(attempts(actionRetry(true), gone)).toEqual(neverRetried);
    const second = (count: number) => count === 2;
    expect(attempts(actionRetry(second), internal)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(attempts(actionRetry(second), gone)).toEqual(neverRetried);
  });
});
