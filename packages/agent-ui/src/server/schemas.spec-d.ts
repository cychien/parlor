import { expectTypeOf, test } from "vitest";
import type { z } from "zod";

import type { ClientMessage, UiOp, UiOpInput } from "../protocol.js";
import type { clientMessageSchema, uiOpInputs } from "./schemas.js";

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

test("the server's op input schemas parse into exactly the wire types", () => {
  expectTypeOf<keyof typeof uiOpInputs>().toEqualTypeOf<UiOp>();
  expectTypeOf<Frozen<Parsed<"screen">>>().toEqualTypeOf<Frozen<UiOpInput<"screen">>>();
  expectTypeOf<Frozen<Parsed<"navigate">>>().toEqualTypeOf<
    Frozen<UiOpInput<"navigate">>
  >();
});
