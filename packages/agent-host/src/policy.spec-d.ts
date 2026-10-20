import type { ChatItemBody, HostItemKind } from "@parlor/chat";
import { expectTypeOf, test } from "vitest";

import type { FoldStep } from "./fold.js";
import type { approvalFor, DEFAULT_POLICY, RemotePolicy } from "./policy.js";

test("the policy has only the computer's own switches: no app setting, no vouching", () => {
  expectTypeOf<keyof RemotePolicy>().toEqualTypeOf<"deviceApproval" | "answers">();
  expectTypeOf<RemotePolicy["deviceApproval"]>().toEqualTypeOf<"local" | "off">();
  expectTypeOf<RemotePolicy["answers"]>().toEqualTypeOf<
    "presence" | "computer" | "off"
  >();
});

test("the default asks for local device approval and presence on every answer", () => {
  expectTypeOf<typeof DEFAULT_POLICY>().toEqualTypeOf<RemotePolicy>();
});

test("an ask says where its answer counts, in the log's own terms", () => {
  expectTypeOf<ReturnType<typeof approvalFor>>().toEqualTypeOf<
    ChatItemBody<"ask">["approval"] | undefined
  >();
});

test("the fold only produces what a host may append", () => {
  expectTypeOf<FoldStep["closed"][number]["kind"]>().toEqualTypeOf<HostItemKind>();
});
