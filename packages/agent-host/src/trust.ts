import type { PinnedDevice } from "@parlor/auth";

import { jsonFile } from "./json-file.js";

export interface TrustedDevice extends PinnedDevice {
  readonly name: string;
  readonly platform: string;
  readonly approvedAt: number;
  /** `pairing`: it approved `connect` here; `local`: linked on this computer; `vouched`: a linked device vouched for it. */
  readonly via: "pairing" | "local" | "vouched";
  /** The linked device whose vouch pinned it. */
  readonly voucher?: string | undefined;
  /** When it last signed here with Face ID or Touch ID; `approvedAt` until it does. */
  readonly presenceAt?: number | undefined;
}

export interface TrustStore {
  get(appOrigin: string, deviceId: string): Promise<TrustedDevice | undefined>;
  list(appOrigin: string): Promise<readonly TrustedDevice[]>;
  pin(appOrigin: string, device: TrustedDevice): Promise<void>;
  forget(appOrigin: string, deviceId?: string): Promise<void>;
}

type Pins = Record<string, Record<string, TrustedDevice>>;

export function fileTrustStore(file: string): TrustStore {
  const pins = jsonFile<Pins>(file);
  return {
    get: async (appOrigin, deviceId) => {
      const devices = (await pins.read())[appOrigin];
      return devices && Object.hasOwn(devices, deviceId) ? devices[deviceId] : undefined;
    },
    list: async (appOrigin) => Object.values((await pins.read())[appOrigin] ?? {}),
    pin: (appOrigin, device) =>
      pins.change((all) => {
        (all[appOrigin] ??= {})[device.deviceId] = device;
      }),
    forget: (appOrigin, deviceId) =>
      pins.change((all) => {
        if (deviceId === undefined) {
          delete all[appOrigin];
          return;
        }
        const origin = all[appOrigin];
        if (!origin) return;
        delete origin[deviceId];
        if (Object.keys(origin).length === 0) delete all[appOrigin];
      }),
  };
}
