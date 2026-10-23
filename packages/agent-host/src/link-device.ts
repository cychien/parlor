import {
  deviceCommitment,
  linkCode,
  normalizeLinkCode,
  type PendingDevice,
} from "@parlor/auth";

import type { AssertionRequest } from "./assertion.js";
import { printable } from "./prompter.js";
import type { TrustedDevice, TrustStore } from "./trust.js";

export const LINK_PATH = "/_parlor/auth/hosts/devices/link";

export interface LinkDeviceInput {
  readonly appOrigin: string;
  readonly code: string;
  readonly assert: (request: AssertionRequest) => Promise<string>;
  readonly trust: TrustStore;
  /** Asked on this computer once the code checked out; only true links. */
  readonly confirm: (device: {
    readonly name: string;
    readonly platform: string;
  }) => Promise<boolean>;
  readonly now?: (() => number) | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export type LinkOutcome =
  | { readonly linked: true; readonly device: TrustedDevice }
  | { readonly linked: false };

/**
 * Links the device showing `code` from this computer: the app finds it, this computer checks
 * its keys hash to that code, so the app cannot slip in other keys, and the user confirms here.
 */
export async function linkDevice(input: LinkDeviceInput): Promise<LinkOutcome> {
  const origin = new URL(input.appOrigin).origin;
  const url = `${origin}${LINK_PATH}`;
  const authorization = `ParlorHost ${await input.assert({ method: "POST", url })}`;
  const response = await (input.fetch ?? fetch)(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ code: input.code }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | (PendingDevice & { readonly error?: { readonly message?: string } })
    | undefined;
  if (!response.ok || !body?.signingKey) {
    throw new Error(body?.error?.message ?? `The app answered HTTP ${response.status}.`);
  }
  const commitment = await deviceCommitment(
    origin,
    body.id,
    body.signingKey,
    body.presenceKey?.publicKey,
  );
  if (linkCode(commitment) !== normalizeLinkCode(input.code)) {
    throw new Error(
      "The app returned a device whose keys do not match this code, so nothing was linked. Show a new code on the device and try again.",
    );
  }
  const shown = { name: printable(body.name), platform: printable(body.platform) };
  if (!(await input.confirm(shown))) return { linked: false };
  const device: TrustedDevice = {
    deviceId: body.id,
    signingKey: body.signingKey,
    presenceKey: body.presenceKey,
    name: body.name,
    platform: body.platform,
    approvedAt: (input.now ?? Date.now)(),
    via: "local",
  };
  await input.trust.pin(origin, device);
  return { linked: true, device };
}
