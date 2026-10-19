import type { HostPrincipal, Principal, UserPrincipal } from "@parlor/core";
import { expectTypeOf, test } from "vitest";

import type { CallerOf, KindsOf } from "./access.js";
import { requireSurface } from "./access.js";
import type { Caller } from "./caller.js";
import type { ScopeResolver } from "./scope.js";

test("no agent and no host can reach the surface that answers confirmations", () => {
  expectTypeOf<KindsOf<"ui">>().toEqualTypeOf<"anonymous" | "user">();
  expectTypeOf<"agent">().not.toExtend<KindsOf<"channels">>();
  expectTypeOf<"host">().not.toExtend<KindsOf<"channels">>();
});

test("a host reaches only its wake-ups, never app actions or MCP", () => {
  expectTypeOf<"host">().not.toExtend<KindsOf<"actions">>();
  expectTypeOf<"host">().not.toExtend<KindsOf<"mcp">>();
  expectTypeOf<"host">().toExtend<KindsOf<"sync">>();
});

test("a browser session is not an MCP credential", () => {
  expectTypeOf<"user">().not.toExtend<KindsOf<"mcp">>();
});

test("a guarded surface hands its handler the narrowed caller", () => {
  expectTypeOf(requireSurface<"ui">)
    .returns.toHaveProperty("principal")
    .toEqualTypeOf<Extract<Principal, { kind: "anonymous" | "user" }>>();
  expectTypeOf<CallerOf<"host">["principal"]>().toEqualTypeOf<HostPrincipal>();
  expectTypeOf<CallerOf<"user">["principal"]>().toEqualTypeOf<UserPrincipal>();
  expectTypeOf<CallerOf<"user">>().toExtend<Caller>();
});

test("a scope resolver written before auth still fits", () => {
  expectTypeOf<(request: Request) => string>().toExtend<ScopeResolver>();
  expectTypeOf<Parameters<ScopeResolver>[1]>().toEqualTypeOf<Principal>();
});
