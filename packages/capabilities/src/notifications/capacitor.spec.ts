import { describe, expect, it, vi } from "vitest";

import { capacitorNotifications } from "./capacitor.js";

function fakeModule(display: "prompt" | "granted" | "denied") {
  const scheduled: unknown[] = [];
  const cancelled: unknown[] = [];
  return {
    scheduled,
    cancelled,
    module: {
      LocalNotifications: {
        checkPermissions: vi.fn(async () => ({ display })),
        requestPermissions: vi.fn(async () => ({ display: "granted" as const })),
        schedule: vi.fn(async (options: unknown) => {
          scheduled.push(options);
        }),
        cancel: vi.fn(async (options: unknown) => {
          cancelled.push(options);
        }),
      },
    },
  };
}

describe("capacitorNotifications", () => {
  it("maps permission states, requests, schedules, and cancels", async () => {
    const { module, scheduled, cancelled } = fakeModule("prompt");
    const api = await capacitorNotifications(async () => module).create();
    expect(api.permission()).toBe("default");
    await expect(api.show("x")).rejects.toThrow(/not been granted/);
    await expect(api.request()).resolves.toBe("granted");
    const handle = await api.show("hi", { body: "there" });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      notifications: [{ title: "hi", body: "there" }],
    });
    handle.close();
    await Promise.resolve();
    expect(cancelled).toHaveLength(1);
  });

  it("reports denied permissions", async () => {
    const { module } = fakeModule("denied");
    const api = await capacitorNotifications(async () => module).create();
    expect(api.permission()).toBe("denied");
  });
});
