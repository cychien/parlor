import { registerPlugin } from "@capacitor/core";

export interface ParlorDeviceKeyPlugin {
  publicKeys(options: { presence: boolean; challenge: string }): Promise<{
    signing: { keyId: string; publicKey: JsonWebKey };
    presence?: { keyId: string; publicKey: JsonWebKey };
    proof: { signature: string };
  }>;
  sign(options: { keyId: string; payload: string }): Promise<{ signature: string }>;
}

export interface ParlorSessionStorePlugin {
  get(): Promise<{ value?: string }>;
  set(options: { value?: string }): Promise<void>;
}

export interface ParlorAuthBrowserPlugin {
  open(options: { url: string; callbackScheme: string }): Promise<{ url?: string }>;
}

export const ParlorDeviceKey = registerPlugin<ParlorDeviceKeyPlugin>("ParlorDeviceKey");
export const ParlorSessionStore =
  registerPlugin<ParlorSessionStorePlugin>("ParlorSessionStore");
export const ParlorAuthBrowser =
  registerPlugin<ParlorAuthBrowserPlugin>("ParlorAuthBrowser");
