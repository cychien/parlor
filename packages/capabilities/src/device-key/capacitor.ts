import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { DeviceKey } from "./interface.js";

/** The `ParlorDeviceKey` native plugin: Secure Enclave on iOS, StrongBox or TEE on Android. */
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
    Promise.reject(new Error("not implemented")),
): CapabilityAdapter<DeviceKey> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor",
    create: async () => {
      void (await load());
      throw new Error("not implemented");
    },
  };
}
