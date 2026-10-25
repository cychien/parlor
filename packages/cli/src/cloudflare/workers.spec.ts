import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform.js", () => ({ platformEnv: () => ({}) }));

const { waitUntil } = await import("./workers.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitUntil in parlor dev", () => {
  it("lets the work run and reports a failure instead of leaving it unhandled", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    let ran = false;
    waitUntil(Promise.resolve().then(() => void (ran = true)));
    waitUntil(Promise.reject(new Error("upstream down")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(true);
    expect(report).toHaveBeenCalledWith(
      "[parlor] work passed to waitUntil failed:",
      expect.objectContaining({ message: "upstream down" }),
    );
  });
});
