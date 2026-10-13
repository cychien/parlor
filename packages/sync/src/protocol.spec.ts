import { describe, expect, it } from "vitest";

import {
  compareCursors,
  decodeCursor,
  encodeCursor,
  INITIAL_CURSOR,
} from "./protocol.js";

describe("cursor", () => {
  it("round-trips and tolerates garbage", () => {
    expect(encodeCursor({ version: 1042, id: "abc" })).toBe("1042.abc");
    expect(decodeCursor("1042.abc")).toEqual({ version: 1042, id: "abc" });
    expect(decodeCursor("1042")).toEqual({ version: 1042, id: "" });
    expect(decodeCursor(undefined)).toEqual(INITIAL_CURSOR);
    expect(decodeCursor("nope")).toEqual(INITIAL_CURSOR);
    expect(decodeCursor("-1.x")).toEqual(INITIAL_CURSOR);
  });

  it("orders by version then id", () => {
    expect(compareCursors({ version: 1, id: "b" }, { version: 2, id: "a" })).toBeLessThan(
      0,
    );
    expect(compareCursors({ version: 2, id: "a" }, { version: 2, id: "b" })).toBeLessThan(
      0,
    );
    expect(compareCursors({ version: 2, id: "b" }, { version: 2, id: "b" })).toBe(0);
  });
});
