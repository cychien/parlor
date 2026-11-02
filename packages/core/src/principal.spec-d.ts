import { expectTypeOf, test } from "vitest";

import type { ActionContext, ActionSource } from "./action.js";
import type { sourceOfPrincipal } from "./action.js";
import type { ActionErrorCode } from "./errors.js";
import type { HostId, KeyId, ThreadId, TurnId, UserId } from "./ids.js";
import type {
  AuthenticatedPrincipal,
  isAuthenticated,
  KeyPrincipal,
  Principal,
  PrincipalKind,
  TurnBinding,
  userOf,
} from "./principal.js";
import type { InvokeContext } from "./registry/invoke.js";

test("every action sees who is calling; an internal caller may omit it and is anonymous", () => {
  expectTypeOf<ActionContext["principal"]>().toEqualTypeOf<Principal>();
  expectTypeOf<InvokeContext["principal"]>().toEqualTypeOf<Principal | undefined>();
});

test("the five principals, and source is derived from them", () => {
  expectTypeOf<PrincipalKind>().toEqualTypeOf<
    "anonymous" | "user" | "agent" | "host" | "key"
  >();
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

test("a key is signed in but has no user, so the user-backed types stay as they were", () => {
  expectTypeOf<AuthenticatedPrincipal["kind"]>().toEqualTypeOf<
    "user" | "agent" | "host"
  >();
  expectTypeOf<AuthenticatedPrincipal["userId"]>().toEqualTypeOf<UserId>();
  expectTypeOf<typeof isAuthenticated>().guards.toEqualTypeOf<AuthenticatedPrincipal>();
  expectTypeOf<ReturnType<typeof userOf>>().toEqualTypeOf<UserId | undefined>();
  expectTypeOf<KeyPrincipal["keyId"]>().toEqualTypeOf<KeyId>();
  expectTypeOf<KeyId>().not.toExtend<UserId>();
});
