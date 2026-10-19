import type { TurnBinding } from "@parlor/core";
import { expectTypeOf, test } from "vitest";

import type { HostAssertionClaims, verifyHostAssertion } from "./hosts.js";
import type {
  agentPrincipalOf,
  HostAssertion,
  TurnToken,
  TurnTokenClaims,
  verifyTurnToken,
} from "./tokens.js";

test("the two audiences are fixed by their claims", () => {
  expectTypeOf<HostAssertionClaims["aud"]>().toEqualTypeOf<"parlor:host">();
  expectTypeOf<TurnTokenClaims["aud"]>().toEqualTypeOf<"parlor:mcp">();
});

test("a host assertion never stands in for a turn token, nor the other way round", () => {
  type TurnInput = Parameters<typeof verifyTurnToken>[1];
  type HostInput = Parameters<typeof verifyHostAssertion>[0];
  expectTypeOf<HostAssertion>().not.toExtend<TurnInput>();
  expectTypeOf<TurnToken>().not.toExtend<HostInput>();
  expectTypeOf<string>().not.toExtend<TurnInput>();
  expectTypeOf<string>().not.toExtend<HostInput>();
});

test("a turn token always yields an agent bound to its turn", () => {
  expectTypeOf<
    ReturnType<typeof agentPrincipalOf>["turn"]
  >().toEqualTypeOf<TurnBinding>();
  expectTypeOf<ReturnType<typeof agentPrincipalOf>["kind"]>().toEqualTypeOf<"agent">();
});
