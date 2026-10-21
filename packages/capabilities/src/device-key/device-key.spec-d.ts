import { expectTypeOf, test } from "vitest";

import type { DeviceKey, DeviceSignature, PresenceSignature } from "./interface.js";

test("only a presence signing yields a presence signature", () => {
  const key = {} as DeviceKey;
  expectTypeOf(
    key.sign(new Uint8Array(), { presence: true }),
  ).resolves.toEqualTypeOf<PresenceSignature>();
  expectTypeOf(
    key.sign(new Uint8Array(), { presence: false }),
  ).resolves.toEqualTypeOf<DeviceSignature>();
});

test("an ordinary signature never passes for a presence one", () => {
  expectTypeOf<DeviceSignature>().not.toExtend<PresenceSignature>();
  expectTypeOf<
    DeviceSignature & { presence: "user" }
  >().not.toExtend<PresenceSignature>();
  expectTypeOf<PresenceSignature>().toExtend<DeviceSignature>();
  expectTypeOf<PresenceSignature["presence"]>().toEqualTypeOf<"user">();
});
