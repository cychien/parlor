import type { DeviceSignature, PresenceSignature } from "@parlor/capabilities";
import {
  canonicalBytes,
  decodeBase64url,
  encodeBase64url,
} from "@parlor/capabilities/encoding";
import type { AnswerToSign, LoggedItem, PromptToSign } from "@parlor/chat";
import type { DeviceId } from "@parlor/core";
import type { PresenceKey } from "@parlor/server";

import { derToRaw, verifyEs256 } from "./es256.js";

export interface PromptStatement {
  readonly v: 1;
  readonly kind: "prompt";
  /** The app's origin: a statement for one app is worthless to another. */
  readonly app: string;
  readonly threadId: string;
  readonly turnId: string;
  /** `<hostId>/<agentId>`: a prompt cannot be replayed to another agent. */
  readonly agent: string;
  /** base64url SHA-256 of the prompt text */
  readonly digest: string;
  readonly at: number;
}

export interface AnswerStatement {
  readonly v: 1;
  readonly kind: "answer";
  readonly app: string;
  readonly threadId: string;
  readonly askId: string;
  /** An option id, `"declined"`, or the digest of a form's values. */
  readonly choice: string;
  readonly at: number;
}

export type Statement = PromptStatement | AnswerStatement;

export interface Signed<S extends Statement> {
  readonly statement: S;
  readonly deviceId: DeviceId;
  readonly signature: S extends AnswerStatement
    ? DeviceSignature | PresenceSignature
    : DeviceSignature;
}

/** A device key the verifier pinned itself, never one that travelled with the statement. */
export interface PinnedDevice {
  readonly deviceId: DeviceId;
  readonly signingKey: JsonWebKey;
  readonly presenceKey?: PresenceKey | undefined;
}

export type VerifyOutcome = "valid" | "invalid" | "stale" | "presence_required";

const FUTURE_SKEW_MS = 5 * 60_000;
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const AUTH_DATA_MIN_BYTES = 37;

export interface VerifyOptions {
  readonly requirePresence: boolean;
  readonly now: number;
  readonly maxAgeMs: number;
}

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

const digestOf = async (bytes: Uint8Array) => encodeBase64url(await sha256(bytes));

export async function promptStatement(
  app: string,
  prompt: PromptToSign,
  at: number,
): Promise<PromptStatement> {
  return {
    v: 1,
    kind: "prompt",
    app,
    threadId: prompt.threadId,
    turnId: prompt.turnId,
    agent: `${prompt.agent.hostId}/${prompt.agent.agentId}`,
    digest: await digestOf(new TextEncoder().encode(prompt.text)),
    at,
  };
}

export async function answerStatement(
  app: string,
  answer: AnswerToSign,
  at: number,
): Promise<AnswerStatement> {
  return {
    v: 1,
    kind: "answer",
    app,
    threadId: answer.threadId,
    askId: answer.askId,
    choice:
      answer.values === undefined
        ? answer.choice
        : await digestOf(
            canonicalBytes({ choice: answer.choice, values: answer.values }),
          ),
    at,
  };
}

export async function signedPrompt(
  app: string,
  item: LoggedItem<"prompt">,
): Promise<Signed<PromptStatement> | undefined> {
  const { signed, agent, text } = item.body;
  if (!signed) return undefined;
  return {
    statement: await promptStatement(
      app,
      { threadId: item.threadId, turnId: item.turnId, agent, text },
      signed.at,
    ),
    deviceId: signed.deviceId,
    signature: signed.signature,
  };
}

export function statementBytes(statement: Statement): Uint8Array {
  return canonicalBytes(statement);
}

interface ClientData {
  readonly type?: unknown;
  readonly challenge?: unknown;
  readonly origin?: unknown;
  readonly crossOrigin?: unknown;
}

async function assertionHolds(
  statement: Statement,
  signature: DeviceSignature,
  presenceKey: PinnedDevice["presenceKey"],
): Promise<boolean> {
  if (presenceKey?.format !== "webauthn" || signature.presence !== "user") return false;
  if (
    signature.authenticatorData === undefined ||
    signature.clientDataJSON === undefined
  ) {
    return false;
  }
  if (signature.keyId !== presenceKey.credentialId) return false;
  if (new URL(statement.app).hostname !== presenceKey.rpId) return false;
  const clientDataBytes = decodeBase64url(signature.clientDataJSON);
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as ClientData;
  const challenge = await digestOf(statementBytes(statement));
  if (
    clientData.type !== "webauthn.get" ||
    clientData.challenge !== challenge ||
    clientData.origin !== statement.app ||
    clientData.crossOrigin === true
  ) {
    return false;
  }
  const authData = decodeBase64url(signature.authenticatorData);
  const flags = authData[32];
  if (authData.length < AUTH_DATA_MIN_BYTES || flags === undefined) return false;
  if ((flags & USER_PRESENT) === 0 || (flags & USER_VERIFIED) === 0) return false;
  const rpIdHash = await sha256(new TextEncoder().encode(presenceKey.rpId));
  if (encodeBase64url(authData.slice(0, 32)) !== encodeBase64url(rpIdHash)) return false;
  const raw = derToRaw(decodeBase64url(signature.signature));
  if (!raw) return false;
  const signed = new Uint8Array([...authData, ...(await sha256(clientDataBytes))]);
  return verifyEs256(presenceKey.publicKey, raw, signed);
}

async function signatureHolds(
  statement: Statement,
  signature: DeviceSignature,
  pinned: PinnedDevice,
): Promise<boolean> {
  if (signature.format === "webauthn") {
    return assertionHolds(statement, signature, pinned.presenceKey);
  }
  const bytes = statementBytes(statement);
  const raw = decodeBase64url(signature.signature);
  if (signature.presence === "none") return verifyEs256(pinned.signingKey, raw, bytes);
  const { presenceKey } = pinned;
  return presenceKey?.format === "es256-raw"
    ? verifyEs256(presenceKey.publicKey, raw, bytes)
    : false;
}

export async function verifyStatement(
  signed: Signed<Statement>,
  pinned: PinnedDevice,
  options: VerifyOptions,
): Promise<VerifyOutcome> {
  const { statement, signature } = signed;
  if (signed.deviceId !== pinned.deviceId) return "invalid";
  if (options.now - statement.at > options.maxAgeMs) return "stale";
  if (statement.at - options.now > FUTURE_SKEW_MS) return "invalid";
  if (options.requirePresence && signature.presence !== "user") {
    return "presence_required";
  }
  try {
    return (await signatureHolds(statement, signature, pinned)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}
