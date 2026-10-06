export type NotificationPermission = "granted" | "denied" | "default";

export interface NotificationOptions {
  readonly body?: string | undefined;
  readonly tag?: string | undefined;
}

export interface NotificationHandle {
  close(): void;
}

export interface Notifications {
  permission(): NotificationPermission;
  request(): Promise<NotificationPermission>;
  show(title: string, options?: NotificationOptions): Promise<NotificationHandle>;
}
