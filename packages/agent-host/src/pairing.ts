import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { HostGrantResponse } from "@parlor/auth";
import type { HostPairing, PairingDevice } from "@parlor/capabilities";

import { hostAssertion } from "./assertion.js";
import type { AppGrant, HostKeyPair, HostKeys } from "./grants.js";
import { workspaceOf } from "./naming.js";
import { type LocalPrompter, printable } from "./prompter.js";
import { revokeGrant } from "./revoke.js";

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

export class UnrevokedGrant extends Error {
  override readonly name = "UnrevokedGrant";
  constructor(
    readonly grant: AppGrant,
    cause: Error,
  ) {
    super(cause.message, { cause });
  }
}

const MATCHING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

function matchingCode(): string {
  const part = () =>
    Array.from(
      { length: 3 },
      () => MATCHING_ALPHABET[randomInt(MATCHING_ALPHABET.length)],
    ).join("");
  return `${part()}-${part()}`;
}

async function appNameOf(origin: string): Promise<string> {
  const response = await fetch(`${origin}/_parlor/manifest`);
  if (!response.ok) {
    throw new Error(`${origin} answered HTTP ${response.status}; is it a Parlor app?`);
  }
  const manifest = (await response.json()) as {
    readonly app?: { readonly name?: unknown };
  };
  return typeof manifest.app?.name === "string"
    ? manifest.app.name
    : new URL(origin).host;
}

type Callback = { readonly code: string } | { readonly declined: true };

async function loopback(state: string): Promise<{
  readonly redirectUri: string;
  readonly callback: Promise<Callback>;
  readonly close: () => void;
}> {
  let deliver: (callback: Callback) => void = () => undefined;
  const callback = new Promise<Callback>((resolve) => (deliver = resolve));
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("Not this connection.");
      return;
    }
    const code = url.searchParams.get("code");
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>Parlor Host</title><p>Go back to your terminal to finish connecting this computer.</p>",
      );
    deliver(code ? { code } : { declined: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    callback,
    close: () => server.close(),
  };
}

async function exchange(
  origin: string,
  key: HostKeyPair,
  code: string,
  codeVerifier: string,
): Promise<HostGrantResponse> {
  const response = await fetch(`${origin}/_parlor/auth/hosts/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier,
      publicKey: key.publicKey,
      proof: await key.sign(new TextEncoder().encode(code)),
    }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | (HostGrantResponse & { readonly error?: { readonly message?: string } })
    | undefined;
  if (!response.ok || !body?.grant) {
    throw new Error(body?.error?.message ?? `The app answered HTTP ${response.status}.`);
  }
  return body;
}

function timeout(ms: number): {
  readonly expired: Promise<"timeout">;
  readonly clear: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/**
 * Only the host starts a pairing: it makes the PKCE verifier, `state`, the matching code
 * and the key pair, so nothing from the web side can complete one.
 */
export async function pair(input: PairInput): Promise<PairOutcome> {
  const origin = new URL(input.appOrigin).origin;
  const appName = await appNameOf(origin);
  const key = await input.keys.create(origin);
  const codeVerifier = base64url(randomBytes(32));
  const pairing: HostPairing = {
    hostName: input.hostName,
    platform: input.platform,
    codeChallenge: base64url(createHash("sha256").update(codeVerifier).digest()),
    state: base64url(randomBytes(16)),
    matchingCode: matchingCode(),
    keyThumbprint: key.thumbprint,
  };
  const deadline = timeout(PAIRING_TIMEOUT_MS);
  try {
    let callback: Callback | "timeout";
    if (input.channel.kind === "ipc") {
      callback = await Promise.race([
        input.channel.authorize(pairing).then((code) => ({ code })),
        deadline.expired,
      ]);
    } else {
      const listener = await loopback(pairing.state);
      try {
        const query = new URLSearchParams({
          redirectUri: listener.redirectUri,
          ...pairing,
        });
        await input.channel.open(`${origin}/_parlor/auth/hosts/authorize?${query}`);
        callback = await Promise.race([listener.callback, deadline.expired]);
      } finally {
        listener.close();
      }
    }
    if (callback === "timeout") return { paired: false, reason: "timeout" };
    if (!("code" in callback)) return { paired: false, reason: "declined_in_app" };

    const granted = await exchange(origin, key, callback.code, codeVerifier);
    const grant: AppGrant = {
      appOrigin: origin,
      appName,
      grantId: granted.grant.id,
      hostId: granted.grant.hostId,
      account: granted.account,
      workspace: workspaceOf(input.workspaceRoot, origin),
      createdAt: Date.now(),
    };
    const confirmed = await Promise.race([
      input.prompter.confirmPairing({
        appName,
        appOrigin: origin,
        account: granted.account,
        matchingCode: pairing.matchingCode,
      }),
      deadline.expired,
    ]);
    if (confirmed !== true) {
      await revokeGrant({
        appOrigin: origin,
        appName,
        assert: (request) =>
          hostAssertion(
            (payload) => key.sign(payload),
            { kid: key.thumbprint, grantId: grant.grantId },
            request,
          ),
      }).catch(async (error: Error) => {
        await key.keep(grant.grantId);
        throw new UnrevokedGrant({ ...grant, declined: true }, error);
      });
      return {
        paired: false,
        reason: confirmed === "timeout" ? "timeout" : "declined_locally",
      };
    }
    await key.keep(grant.grantId);
    return { paired: true, grant, approvedBy: granted.approvedBy };
  } finally {
    deadline.clear();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface LocalPairingReview {
  readonly account: string;
  readonly appName: string;
  readonly matchingCode: string;
}

/**
 * A pairing driven over the control socket by the desktop shell: `pairing` once the host
 * made its key and code, `finish` with the code the signed-in page got from the backend,
 * `confirm` with the user's answer in the native dialog.
 */
export interface LocalPairing {
  readonly pairing: Promise<HostPairing>;
  finish(code: string): Promise<LocalPairingReview>;
  confirm(connect: boolean): Promise<PairOutcome>;
}

export function startLocalPairing(
  input: Omit<PairInput, "channel" | "prompter">,
): LocalPairing {
  const ready = deferred<HostPairing>();
  const code = deferred<string>();
  const review = deferred<LocalPairingReview>();
  const decision = deferred<boolean>();
  const prompter: LocalPrompter = {
    confirmPairing: (shown) => {
      review.resolve({
        account: printable(shown.account.email ?? shown.account.name),
        appName: printable(shown.appName),
        matchingCode: shown.matchingCode,
      });
      return decision.promise;
    },
    approveDevice: async () => false,
    answerHere: async () => undefined,
    turnStarted: () => undefined,
  };
  const outcome = pair({
    ...input,
    prompter,
    channel: {
      kind: "ipc",
      authorize: (pairing) => {
        ready.resolve(pairing);
        return code.promise;
      },
    },
  });
  outcome.then(
    (result) => {
      if (result.paired) return;
      const stopped = new Error(`The pairing ended: ${result.reason}.`);
      ready.reject(stopped);
      review.reject(stopped);
    },
    (error: unknown) => {
      ready.reject(error);
      review.reject(error);
    },
  );
  outcome.catch(() => undefined);
  return {
    pairing: ready.promise,
    finish: (value) => {
      code.resolve(value);
      return review.promise;
    },
    confirm: (connect) => {
      decision.resolve(connect);
      return outcome;
    },
  };
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

type Point = JsonWebKey & { readonly x: string; readonly y: string };

const isPoint = (value: unknown): value is Point => {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return key.kty === "EC" && key.crv === "P-256" && isText(key.x) && isText(key.y);
};

function presenceKeyOf(value: unknown): PairingDevice["presenceKey"] {
  if (typeof value !== "object" || value === null) return undefined;
  const key = value as Record<string, unknown>;
  if (!isPoint(key.publicKey)) return undefined;
  const publicKey = { kty: "EC", crv: "P-256", x: key.publicKey.x, y: key.publicKey.y };
  if (key.format === "webauthn" && isText(key.credentialId) && isText(key.rpId)) {
    return {
      format: "webauthn",
      credentialId: key.credentialId,
      rpId: key.rpId,
      publicKey,
    };
  }
  if (key.format === "es256-raw" && isText(key.keyId)) {
    return { format: "es256-raw", keyId: key.keyId, publicKey };
  }
  return undefined;
}

export function pairingDeviceOf(value: unknown): PairingDevice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const device = value as Record<string, unknown>;
  if (!isText(device.deviceId) || !isText(device.name) || !isText(device.platform)) {
    return undefined;
  }
  if (!isPoint(device.signingKey)) return undefined;
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    signingKey: {
      kty: "EC",
      crv: "P-256",
      x: device.signingKey.x,
      y: device.signingKey.y,
    },
    presenceKey: presenceKeyOf(device.presenceKey),
  };
}
