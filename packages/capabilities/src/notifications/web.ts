import type { CapabilityAdapter } from "../capability.js";
import type { NotificationPermission, Notifications } from "./interface.js";

interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (
    title: string,
    options?: { body?: string | undefined; tag?: string | undefined },
  ): { close(): void };
}

export function webNotifications(
  getApi: () => NotificationApi | undefined = () =>
    (globalThis as { Notification?: NotificationApi }).Notification,
): CapabilityAdapter<Notifications> {
  return {
    platform: "web",
    available: () => getApi() !== undefined,
    create: () => {
      const api = getApi();
      if (!api) throw new Error("Notification API is not available");
      return {
        permission: () => api.permission,
        request: () => api.requestPermission(),
        show: async (title, options) => {
          if (api.permission !== "granted") {
            throw new Error("Notification permission has not been granted");
          }
          const notification = new api(title, options);
          return { close: () => notification.close() };
        },
      };
    },
  };
}
