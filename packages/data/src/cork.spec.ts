import { describe, expect, it, vi } from "vitest";

import { corkWrites } from "./cork.js";

function socket() {
  const sent: string[] = [];
  const done: ((error?: Error) => void)[] = [];
  const raw = {
    write(data: Uint8Array | string, ...rest: unknown[]): boolean {
      sent.push(Buffer.from(data).toString());
      const callback = rest.find((arg) => typeof arg === "function");
      if (callback) done.push(callback as (error?: Error) => void);
      return true;
    },
  } as {
    cork?: () => void;
    uncork?: () => void;
    write(data: Uint8Array | string, ...rest: unknown[]): boolean;
  };
  return { raw, sent, done };
}

describe("corkWrites", () => {
  it("sends what was written while corked as one write on the last uncork", () => {
    const { raw, sent } = socket();
    corkWrites(raw);
    raw.cork!();
    raw.write(Buffer.from("P"));
    raw.cork!();
    raw.write(Buffer.from("B"));
    raw.uncork!();
    raw.write("E");
    expect(sent).toEqual([]);
    raw.uncork!();
    expect(sent).toEqual(["PBE"]);
  });

  it("writes at once while not corked, and ignores an uncork without a cork", () => {
    const { raw, sent } = socket();
    corkWrites(raw);
    raw.uncork!();
    raw.write(Buffer.from("Q"));
    expect(sent).toEqual(["Q"]);
  });

  it("answers every held write's callback with the outcome of the one write", () => {
    const { raw, done } = socket();
    corkWrites(raw);
    const first = vi.fn();
    const second = vi.fn();
    raw.cork!();
    raw.write(Buffer.from("P"), first);
    raw.write("S", "utf8", second);
    raw.uncork!();
    const failure = new Error("closed");
    done[0]!(failure);
    expect(first).toHaveBeenCalledWith(failure);
    expect(second).toHaveBeenCalledWith(failure);
  });

  it("leaves a socket that corks on its own alone", () => {
    const own = { cork: vi.fn(), uncork: vi.fn(), write: vi.fn(() => true) };
    const { write } = own;
    corkWrites(own);
    expect(own.write).toBe(write);
    own.cork();
    expect(own.cork).toHaveBeenCalledOnce();
  });
});
