import type { HostGrantResponse } from "@parlor/auth";
import type { HostPairing } from "@parlor/capabilities";

import type { AppGrant, HostKeys } from "./grants.js";
import type { LocalPrompter } from "./prompter.js";

export const PAIRING_TIMEOUT_MS = 10 * 60_000;

/**
 * `browser`: a one-shot 127.0.0.1 listener (RFC 8252) accepting exactly this attempt's
 * `state`. `ipc`: the desktop shell's signed-in webview gets the code from the backend
 * and hands it over Tauri IPC; no listener at all.
 */
export type PairingChannel =
  | { readonly kind: "browser"; open(url: string): Promise<void> }
  | { readonly kind: "ipc"; authorize(pairing: HostPairing): Promise<string> };

export interface PairInput {
  readonly appOrigin: string;
  readonly hostName: string;
  readonly platform: string;
  readonly channel: PairingChannel;
  readonly prompter: LocalPrompter;
  readonly keys: HostKeys;
  readonly workspaceRoot: string;
}

export type PairOutcome =
  | {
      readonly paired: true;
      readonly grant: AppGrant;
      readonly approvedBy: HostGrantResponse["approvedBy"];
    }
  | {
      readonly paired: false;
      readonly reason: "declined_locally" | "declined_in_app" | "timeout";
    };

/**
 * Only the host starts a pairing: it makes the PKCE verifier, `state`, the matching code
 * and the key pair, so nothing from the web side can complete one.
 */
export async function pair(input: PairInput): Promise<PairOutcome> {
  // TODO: GET /_parlor/manifest for the app name; key = keys.create(origin); verifier,
  //   S256 challenge, state, matching code; browser -> loopback listener and open
  //   /_parlor/auth/hosts/authorize?...; ipc -> channel.authorize(pairing); POST
  //   /_parlor/auth/hosts/token { code, codeVerifier, publicKey, proof: key.sign(code) };
  //   prompter.confirmPairing({ account, matchingCode }); yes -> key.keep(), pin approvedBy
  //   (via "pairing"); no -> POST /hosts/revoke signed by the key, then forget it; the
  //   whole attempt within PAIRING_TIMEOUT_MS.
  void input;
  throw new Error("not implemented");
}
