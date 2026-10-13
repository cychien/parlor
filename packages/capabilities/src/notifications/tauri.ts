import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { NotificationPermission, Notifications } from "./interface.js";

export interface TauriNotificationModule {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermission>;
  sendNotification(options: { title: string; body?: string }): void;
}

export function tauriNotifications(
  load: () => Promise<TauriNotificationModule> = () =>
    import("@tauri-apps/plugin-notification"),
): CapabilityAdapter<Notifications> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: async () => {
      const plugin = await load();
      let permission: NotificationPermission = (await plugin.isPermissionGranted())
        ? "granted"
        : "default";
      return {
        permission: () => permission,
        request: async () => {
          permission = await plugin.requestPermission();
          return permission;
        },
        show: async (title, options) => {
          if (permission !== "granted") {
            throw new Error("Notification permission has not been granted");
          }
          plugin.sendNotification(
            options?.body === undefined ? { title } : { title, body: options.body },
          );
          return { close: () => {} };
        },
      };
    },
  };
}
