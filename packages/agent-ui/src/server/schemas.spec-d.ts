import { expectTypeOf, test } from "vitest";
import type { z } from "zod";

import type { ClientMessage, UiErrorCode, UiOp, UiOpInput } from "../protocol.js";
import type { clientMessageSchema, uiOpInputs } from "./schemas.js";
import type { UI_TOOLS, UiToolName } from "./tools.js";

type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;

type Parsed<O extends UiOp> = z.output<(typeof uiOpInputs)[O]>;

test("the server parses client messages into exactly the wire type", () => {
  expectTypeOf<Frozen<z.output<typeof clientMessageSchema>>>().toEqualTypeOf<
    Frozen<ClientMessage>
  >();
});

test("the phase 2 refusals are wire error codes", () => {
  expectTypeOf<
    "not_mounted" | "not_writable" | "invalid_value" | "user_editing"
  >().toExtend<UiErrorCode>();
});

test("every op is a ui_ tool and an activity kind", () => {
  expectTypeOf<UiToolName>().toEqualTypeOf<
    "ui_screen" | "ui_navigate" | "ui_set" | "ui_highlight"
  >();
  expectTypeOf<(typeof UI_TOOLS)[number]>().toEqualTypeOf<UiToolName>();
});

test("the server's op input schemas parse into exactly the wire types", () => {
  expectTypeOf<keyof typeof uiOpInputs>().toEqualTypeOf<UiOp>();
  expectTypeOf<Frozen<Parsed<"screen">>>().toEqualTypeOf<Frozen<UiOpInput<"screen">>>();
  expectTypeOf<Frozen<Parsed<"navigate">>>().toEqualTypeOf<
    Frozen<UiOpInput<"navigate">>
  >();
  expectTypeOf<Frozen<Parsed<"set">>>().toEqualTypeOf<Frozen<UiOpInput<"set">>>();
  expectTypeOf<Frozen<Parsed<"highlight">>>().toEqualTypeOf<
    Frozen<UiOpInput<"highlight">>
  >();
});
