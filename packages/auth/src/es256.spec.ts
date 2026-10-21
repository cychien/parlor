import { describe, expect, it } from "vitest";

import { derToRaw } from "./es256.js";

const der = (r: number[], s: number[]) =>
  new Uint8Array([
    0x30,
    4 + r.length + s.length,
    0x02,
    r.length,
    ...r,
    0x02,
    s.length,
    ...s,
  ]);

describe("derToRaw", () => {
  it("left-pads short integers to 32 bytes each", () => {
    const raw = derToRaw(der([1], [2, 3]))!;
    expect(raw).toHaveLength(64);
    expect([...raw.slice(0, 31)].every((byte) => byte === 0)).toBe(true);
    expect(raw[31]).toBe(1);
    expect([...raw.slice(32, 62)].every((byte) => byte === 0)).toBe(true);
    expect([...raw.slice(62)]).toEqual([2, 3]);
  });

  it("drops the leading zero that keeps a high-bit integer positive", () => {
    const high = [0x00, ...Array.from({ length: 32 }, () => 0xff)];
    const raw = derToRaw(der(high, [5]))!;
    expect([...raw.slice(0, 32)].every((byte) => byte === 0xff)).toBe(true);
  });

  it("reads long-form lengths", () => {
    const r = Array.from({ length: 32 }, () => 0x7f);
    const s = Array.from({ length: 32 }, () => 0x7e);
    const body = [0x02, 32, ...r, 0x02, 32, ...s];
    expect(derToRaw(new Uint8Array([0x30, 0x81, body.length, ...body]))).toHaveLength(64);
  });

  it.each([
    ["trailing bytes", new Uint8Array([...der([1], [2]), 0])],
    ["a wrong total length", new Uint8Array([0x30, 9, 0x02, 1, 1, 0x02, 1, 2])],
    ["a sequence of one integer", new Uint8Array([0x30, 3, 0x02, 1, 1])],
    [
      "an integer wider than the curve",
      der(
        Array.from({ length: 33 }, () => 1),
        [2],
      ),
    ],
    ["not a sequence", new Uint8Array([0x31, 0])],
    ["nothing", new Uint8Array()],
  ])("refuses %s", (_name, bytes) => {
    expect(derToRaw(bytes)).toBeUndefined();
  });
});
