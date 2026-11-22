import { afterEach, expect, it } from "vitest";

import { holdUntilSettled, installRequestHold } from "./request-hold.js";

afterEach(() => installRequestHold(undefined));

it("hands shared work to the host's hold, which never sees it reject", async () => {
  const held: Promise<unknown>[] = [];
  installRequestHold((work) => void held.push(work));
  const failing = Promise.reject(new Error("down"));

  await expect(holdUntilSettled(failing)).rejects.toThrow("down");
  expect(held).toHaveLength(1);
  await expect(held[0]).resolves.toBeUndefined();
});

it("returns the work untouched without a host hold", async () => {
  const work = Promise.resolve(42);
  expect(holdUntilSettled(work)).toBe(work);
});
