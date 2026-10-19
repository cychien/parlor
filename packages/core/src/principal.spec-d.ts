import { expectTypeOf, test } from "vitest";

import type { ActionContext, ActionSource } from "./action.js";
import type { sourceOfPrincipal } from "./action.js";
import type { ActionErrorCode } from "./errors.js";
import type { HostId, ThreadId, TurnId, UserId } from "./ids.js";
import type { Principal, PrincipalKind, TurnBinding } from "./principal.js";
import type { InvokeContext } from "./registry/invoke.js";

test("every action sees who is calling; an internal caller may omit it and is anonymous", () => {
  expectTypeOf<ActionContext["principal"]>().toEqualTypeOf<Principal>();
  expectTypeOf<InvokeContext["principal"]>().toEqualTypeOf<Principal | undefined>();
});

test("the four principals, and source is derived from them", () => {
  expectTypeOf<PrincipalKind>().toEqualTypeOf<"anonymous" | "user" | "agent" | "host">();
  expectTypeOf<ReturnType<typeof sourceOfPrincipal>>().toEqualTypeOf<ActionSource>();
});

test("an inline agent's calls carry the chat turn, and the tab it came from", () => {
  type Agent = Extract<Principal, { kind: "agent" }>;
  expectTypeOf<Agent["turn"]>().toEqualTypeOf<TurnBinding | undefined>();
  expectTypeOf<TurnBinding>().toEqualTypeOf<{
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly hostId: HostId;
    readonly clientId: string;
  }>();
});

test("auth failures are action errors that every surface must map", () => {
  expectTypeOf<"unauthenticated" | "forbidden">().toExtend<ActionErrorCode>();
});

test("ids of different kinds never stand in for each other, nor a scope for a user", () => {
  expectTypeOf<ThreadId>().not.toExtend<TurnId>();
  expectTypeOf<string>().not.toExtend<UserId>();
  expectTypeOf<UserId>().toExtend<string>();
  expectTypeOf<Extract<Principal, { kind: "user" }>["userId"]>().toEqualTypeOf<UserId>();
});
