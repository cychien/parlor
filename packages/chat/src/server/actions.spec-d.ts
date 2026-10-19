import type {
  ActionInput,
  ActionOutput,
  HostPrincipal,
  ThreadId,
  UserId,
} from "@parlor/core";
import type { KindsOf } from "@parlor/server";
import { expectTypeOf, test } from "vitest";

import type { ChatSnapshot, ClaimedTurn } from "../model.js";
import type { ChatActionMap, ChatHostActionMap, ChatUserActionMap } from "./actions.js";
import type { ChatActionConfig, ChatHost, ChatUser, PartyOf } from "./party.js";

test("host actions and user actions are two disjoint sets, together the whole surface", () => {
  expectTypeOf<keyof ChatHostActionMap>().toEqualTypeOf<
    "hostHello" | "hostReport" | "hostClaim" | "hostSignals" | "hostAppend" | "hostFinish"
  >();
  expectTypeOf<keyof ChatUserActionMap>().toEqualTypeOf<
    "open" | "items" | "hosts" | "send" | "answer" | "cancel"
  >();
  expectTypeOf<keyof ChatActionMap>().toEqualTypeOf<
    keyof ChatHostActionMap | keyof ChatUserActionMap
  >();
});

test("a host action body receives a host, already checked", () => {
  type HostRun = Parameters<ChatActionConfig<"host", never, unknown>["run"]>[1];
  expectTypeOf<HostRun>().toEqualTypeOf<ChatHost>();
  expectTypeOf<PartyOf<"host">["host"]>().toEqualTypeOf<HostPrincipal>();
});

test("a user action never accepts an agent", () => {
  type UserRun = Parameters<ChatActionConfig<"user", never, unknown>["run"]>[1];
  expectTypeOf<UserRun>().toEqualTypeOf<ChatUser>();
  expectTypeOf<ChatUser>().not.toHaveProperty("host");
  expectTypeOf<"agent">().not.toExtend<KindsOf<"pluginActions">>();
});

test("both parties carry the owner's user id, so every query filters by person", () => {
  expectTypeOf<ChatUser["userId"]>().toEqualTypeOf<UserId>();
  expectTypeOf<ChatHost["userId"]>().toEqualTypeOf<UserId>();
});

test("the sidebar's first paint is one action", () => {
  expectTypeOf<ActionOutput<ChatActionMap["open"]>>().toEqualTypeOf<ChatSnapshot>();
});

test("ids arrive as strings and reach the body branded", () => {
  expectTypeOf<ActionInput<ChatActionMap["items"]>["threadId"]>().toEqualTypeOf<string>();
  expectTypeOf<ClaimedTurn["id"]>().toEqualTypeOf<ThreadId>();
});

test("every chat write returns its thread or host id as `id`, its sync tag", () => {
  type Writes =
    | "send"
    | "answer"
    | "cancel"
    | "hostHello"
    | "hostReport"
    | "hostClaim"
    | "hostAppend"
    | "hostFinish";
  expectTypeOf<ActionOutput<ChatActionMap[Writes]>>().toExtend<{ readonly id: string }>();
});

test("a claim hands over everything a turn needs in one response", () => {
  expectTypeOf<ActionOutput<ChatActionMap["hostClaim"]>>().toEqualTypeOf<ClaimedTurn>();
});
