import { describe, expect, it, vi } from "vitest";

import { webNotifications } from "./web.js";

function fakeNotificationApi(permission: "granted" | "denied" | "default") {
  const shown: unknown[] = [];
  const api = class {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      api.permission = "granted";
      return "granted" as const;
    });
    constructor(title: string, options?: unknown) {
      shown.push({ title, options });
    }
    close = vi.fn();
  };
  return { api, shown };
}

describe("webNotifications", () => {
  it("is unavailable without the Notification API", () => {
    expect(webNotifications(() => undefined).available()).toBe(false);
  });

  it("reports permission, requests it, and shows notifications once granted", async () => {
    const { api, shown } = fakeNotificationApi("default");
    const notifications = webNotifications(() => api).create();

    expect(notifications.permission()).toBe("default");
    await expect(notifications.show("hi")).rejects.toThrow(/not been granted/);

    await expect(notifications.request()).resolves.toBe("granted");
    const handle = await notifications.show("hi", { body: "there" });
    expect(shown).toEqual([{ title: "hi", options: { body: "there" } }]);
    handle.close();
  });
});
