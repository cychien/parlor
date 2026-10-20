import { expectTypeOf, test } from "vitest";
import type { z } from "zod";

import type { ChatEvent } from "./events.js";
import type {
  ChatItemBody,
  ChatItemKind,
  chatItemBodies,
  HostItemDraft,
  HostItemKind,
  hostItemDraft,
  UserItemKind,
} from "./items.js";
import type { HostFrame } from "./protocol.js";
import type { ChatItem, FoldedKind, ItemFolders } from "./view.js";

type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;

test("who writes what is read off the one table", () => {
  expectTypeOf<ChatItemKind>().toEqualTypeOf<keyof typeof chatItemBodies>();
  expectTypeOf<UserItemKind>().toEqualTypeOf<"prompt" | "answer" | "cancel">();
  expectTypeOf<HostItemKind>().toEqualTypeOf<
    "reply" | "reasoning" | "tool" | "plan" | "ask" | "event"
  >();
});

test("user and host kinds are disjoint and cover every kind", () => {
  expectTypeOf<Extract<UserItemKind, HostItemKind>>().toBeNever();
  expectTypeOf<UserItemKind | HostItemKind>().toEqualTypeOf<ChatItemKind>();
});

test("a kind the fold does not handle fails to compile", () => {
  expectTypeOf<keyof ItemFolders>().toEqualTypeOf<ChatItemKind>();
  expectTypeOf<Omit<ItemFolders, "event">>().not.toExtend<ItemFolders>();
});

test("the host append parser accepts exactly the host's drafts, never a user kind", () => {
  expectTypeOf<Frozen<z.output<typeof hostItemDraft>>>().toEqualTypeOf<
    Frozen<HostItemDraft>
  >();
  expectTypeOf<HostItemDraft["kind"]>().toEqualTypeOf<HostItemKind>();
});

test("events have one list", () => {
  expectTypeOf<
    z.output<(typeof chatItemBodies)["event"]["body"]>["event"]
  >().toEqualTypeOf<ChatEvent>();
});

test("every log kind renders, except the ones that settle another item", () => {
  expectTypeOf<ChatItem["kind"]>().toEqualTypeOf<
    Exclude<ChatItemKind, FoldedKind> | "confirm"
  >();
});

test("a host streams text and open items; only the server settles a turn", () => {
  expectTypeOf<HostFrame["type"]>().toEqualTypeOf<"delta" | "item">();
  expectTypeOf<HostFrame>().not.toHaveProperty("threadId");
});

test("an ask's approval is the host policy's to set, or absent for any device", () => {
  expectTypeOf<ChatItemBody<"ask">["approval"]>().toEqualTypeOf<
    "presence" | "computer" | undefined
  >();
  expectTypeOf<Extract<ChatItem, { kind: "ask" }>["approval"]>().toEqualTypeOf<
    "presence" | "computer" | undefined
  >();
});
