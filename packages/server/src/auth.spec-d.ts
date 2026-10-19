import type { AuthenticatedPrincipal, Principal } from "@parlor/core";
import { expectTypeOf, test } from "vitest";

import type { AuthProvider, Delegation } from "./auth.js";
import type { PluginHost, PluginRuntime } from "./plugin.js";

interface PhaseTwoProvider {
  readonly name: string;
  readonly enforcing: boolean;
  setup(host: PluginHost): PluginRuntime;
  authenticate(request: Request): Promise<Principal>;
  challenge(request: Request): Response;
  revoked(principal: AuthenticatedPrincipal): AbortSignal;
}

test("a provider written before chat still is an auth provider", () => {
  expectTypeOf<PhaseTwoProvider>().toExtend<AuthProvider>();
});

test("a provider that can delegate mints a turn token per turn", () => {
  type Delegate = NonNullable<AuthProvider["delegate"]>;
  expectTypeOf<Awaited<ReturnType<Delegate>>>().toEqualTypeOf<Delegation>();
  expectTypeOf<Parameters<Delegate>[0]["kind"]>().toEqualTypeOf<"host">();
});
