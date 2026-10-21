import type { CapabilityAdapter } from "../capability.js";
import type { DeviceKey } from "./interface.js";
import { hasIosPlugin, nativeDeviceKey } from "./native.js";

/** The `ParlorDeviceKey` native plugin: the Secure Enclave, or a Keychain key, on iOS. */
export interface CapacitorDeviceKeyModule {
  ParlorDeviceKey: {
    publicKeys(options: { presence: boolean; challenge: string }): Promise<{
      signing: { keyId: string; publicKey: JsonWebKey };
      presence?: { keyId: string; publicKey: JsonWebKey };
      proof: { signature: string };
    }>;
    /** A presence key carries a biometry-or-passcode access control the hardware enforces. */
    sign(options: { keyId: string; payload: string }): Promise<{ signature: string }>;
  };
}

export function capacitorDeviceKey(
  load: () => Promise<CapacitorDeviceKeyModule> = () =>
    import("@parlor/capacitor-device-key"),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "capacitor",
    available: hasIosPlugin,
    create: async () => nativeDeviceKey((await load()).ParlorDeviceKey),
  };
}
