import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { NotificationPermission, Notifications } from "./interface.js";

type CapacitorPermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

export interface CapacitorNotificationModule {
  LocalNotifications: {
    checkPermissions(): Promise<{ display: CapacitorPermissionState }>;
    requestPermissions(): Promise<{ display: CapacitorPermissionState }>;
    schedule(options: {
      notifications: Array<{ id: number; title: string; body: string }>;
    }): Promise<unknown>;
    cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  };
}

function toPermission(state: CapacitorPermissionState): NotificationPermission {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "default";
}

export function capacitorNotifications(
  load: () => Promise<CapacitorNotificationModule> = () =>
    import("@capacitor/local-notifications"),
): CapabilityAdapter<Notifications> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor",
    create: async () => {
      const { LocalNotifications } = await load();
      let permission = toPermission(
        (await LocalNotifications.checkPermissions()).display,
      );
      let nextId = Date.now() % 2_000_000_000;
      return {
        permission: () => permission,
        request: async () => {
          permission = toPermission(
            (await LocalNotifications.requestPermissions()).display,
          );
          return permission;
        },
        show: async (title, options) => {
          if (permission !== "granted") {
            throw new Error("Notification permission has not been granted");
          }
          const id = nextId++;
          await LocalNotifications.schedule({
            notifications: [{ id, title, body: options?.body ?? "" }],
          });
          return {
            close: () => void LocalNotifications.cancel({ notifications: [{ id }] }),
          };
        },
      };
    },
  };
}
