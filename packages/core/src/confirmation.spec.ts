import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ActionSource, defineAction, needsConfirmation } from "./action.js";
import { defaultConfirmationPolicy } from "./confirmation.js";
import { asId } from "./ids.js";
import type { Principal } from "./principal.js";

const SOURCES: readonly ActionSource[] = ["ui", "agent", "http", "mcp"];
const actionWith = (confirm: boolean | undefined) =>
  defineAction({ description: "x", input: z.object({}), confirm, run: () => "ok" });

const userId = asId("user", "alice");
const grantId = asId("grant", "g");
const PEOPLE: readonly Principal[] = [
  { kind: "anonymous" },
  { kind: "user", userId, sessionId: "s" },
  { kind: "agent", userId, grantId, agent: { name: "Claude Code", verified: true } },
  { kind: "host", userId, grantId, hostId: asId("host", "mac") },
];
const KEY: Principal = {
  kind: "key",
  keyId: asId("key", "k1"),
  scope: "org-a",
  name: 'API key "CI"',
  claims: {},
};

describe("defaultConfirmationPolicy", () => {
  it("asks exactly when needsConfirmation does, for every principal backed by a person", () => {
    for (const principal of PEOPLE)
      for (const source of SOURCES)
        for (const confirm of [undefined, false, true]) {
          const action = actionWith(confirm);
          expect(
            defaultConfirmationPolicy({ name: "x", action, principal, source }),
          ).toBe(needsConfirmation(action, source) ? "ask" : "proceed");
        }
  });

  it("refuses a key a confirm action from every source, and lets it run the rest", () => {
    for (const source of SOURCES) {
      const call = { name: "x", principal: KEY, source };
      expect(defaultConfirmationPolicy({ ...call, action: actionWith(true) })).toBe(
        "refuse",
      );
      expect(defaultConfirmationPolicy({ ...call, action: actionWith(false) })).toBe(
        "proceed",
      );
      expect(defaultConfirmationPolicy({ ...call, action: actionWith(undefined) })).toBe(
        "proceed",
      );
    }
  });
});
