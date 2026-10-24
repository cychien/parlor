import { tagsOverlap } from "@parlor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appOrigin } from "../action-client.js";
import type { AccountDevice } from "../session.js";
import { useFramework } from "./provider.js";

const DEVICES_TAG = "parlor_auth_devices";

/** What removing a device is doing: confirming, or showing the command a device without Face ID or Touch ID needs. */
export type RemoveDeviceState =
  | { readonly step: "idle" }
  | { readonly step: "removing"; readonly id: string }
  | { readonly step: "on-computer"; readonly id: string; readonly command: string }
  | { readonly step: "error"; readonly id: string; readonly message: string };

const IDLE: RemoveDeviceState = { step: "idle" };

/** Devices another device linked since `before` was read; this device's own links are not news here. */
export function newlyLinked(
  before: readonly AccountDevice[],
  after: readonly AccountDevice[],
): AccountDevice[] {
  const self = after.find((device) => device.current)?.id;
  const was = new Map(before.map((device) => [device.id, device.vouched]));
  return after.filter(
    (device) =>
      device.vouched &&
      was.get(device.id) !== true &&
      !device.current &&
      device.linkedBy !== self,
  );
}

/**
 * The account's devices, read again whenever one is added, linked or removed; the ones another
 * device linked while this page was open, to tell the user; and removing one with Face ID or
 * Touch ID.
 */
export function useDevices(): {
  readonly available: boolean;
  readonly devices: readonly AccountDevice[] | undefined;
  readonly linked: readonly AccountDevice[];
  readonly removal: RemoveDeviceState;
  /** Whether it was removed. */
  remove(id: string): Promise<boolean>;
  dismiss(id: string): void;
  reset(): void;
} {
  const { auth, sync } = useFramework();
  const [devices, setDevices] = useState<readonly AccountDevice[] | undefined>(undefined);
  const [linked, setLinked] = useState<readonly AccountDevice[]>([]);
  const [removal, setRemoval] = useState<RemoveDeviceState>(IDLE);
  const last = useRef<readonly AccountDevice[] | undefined>(undefined);
  const reload = useRef<() => Promise<void>>(async () => undefined);
  const available = Boolean(auth?.listDevices && auth.removeDevice);

  useEffect(() => {
    if (!auth?.listDevices) return;
    let live = true;
    const load = () =>
      auth.listDevices!().then(
        (listed) => {
          if (!live) return;
          const before = last.current;
          last.current = listed;
          setDevices(listed);
          const fresh = before ? newlyLinked(before, listed) : [];
          const present = new Set(listed.map((device) => device.id));
          setLinked((shown) => [
            ...shown.filter((device) => present.has(device.id)),
            ...fresh.filter((device) => !shown.some((entry) => entry.id === device.id)),
          ]);
        },
        () => undefined,
      );
    reload.current = load;
    void load();
    const off = sync.onEvents((events) => {
      if (
        events.some((event) => event.tags.some((tag) => tagsOverlap(tag, [DEVICES_TAG])))
      ) {
        void load();
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [auth, sync]);

  const remove = useCallback(
    async (id: string) => {
      if (!auth?.removeDevice) return false;
      setRemoval({ step: "removing", id });
      try {
        await auth.removeDevice(id);
        setRemoval(IDLE);
        await reload.current();
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "LinkOnComputer") {
          setRemoval({
            step: "on-computer",
            id,
            command: `npx @parlor/agent-host devices ${appOrigin()} --remove ${id}`,
          });
          return false;
        }
        setRemoval({
          step: "error",
          id,
          message:
            error instanceof Error && error.name === "NotAllowedError"
              ? "Face ID or Touch ID was cancelled, so nothing was removed."
              : error instanceof Error && error.message
                ? error.message
                : "That did not work. Try again.",
        });
        return false;
      }
    },
    [auth],
  );

  const reset = useCallback(() => setRemoval(IDLE), []);
  const dismiss = useCallback(
    (id: string) => setLinked((shown) => shown.filter((device) => device.id !== id)),
    [],
  );

  return useMemo(
    () => ({ available, devices, linked, removal, remove, dismiss, reset }),
    [available, devices, linked, removal, remove, dismiss, reset],
  );
}
