import type { DeviceSignature, PresenceSignature } from "@parlor/capabilities";
import type { AnswerToSign, LoggedItem, PromptToSign } from "@parlor/chat";
import type { DeviceId } from "@parlor/core";
import type { PresenceKey } from "@parlor/server";

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

export interface VerifyOptions {
  readonly requirePresence: boolean;
  readonly now: number;
  readonly maxAgeMs: number;
}

export async function promptStatement(
  app: string,
  prompt: PromptToSign,
  at: number,
): Promise<PromptStatement> {
  void app;
  void prompt;
  void at;
  throw new Error("not implemented");
}

export async function answerStatement(
  app: string,
  answer: AnswerToSign,
  at: number,
): Promise<AnswerStatement> {
  void app;
  void answer;
  void at;
  throw new Error("not implemented");
}

/** The host rebuilds what the device signed from the logged prompt, never from the wire. */
export async function signedPrompt(
  app: string,
  item: LoggedItem<"prompt">,
): Promise<Signed<PromptStatement> | undefined> {
  void app;
  void item;
  throw new Error("not implemented");
}

/** Sorted-key JSON at every level, UTF-8; never re-encoded on the way. */
export function statementBytes(statement: Statement): Uint8Array {
  void statement;
  throw new Error("not implemented");
}

export async function verifyStatement(
  signed: Signed<Statement>,
  pinned: PinnedDevice,
  options: VerifyOptions,
): Promise<VerifyOutcome> {
  // TODO: deviceId matches; now - at within maxAgeMs else stale; requirePresence and no
  //   presence -> presence_required. es256-raw: subtle.verify over statementBytes with the
  //   pinned key. webauthn: clientDataJSON.challenge === b64url(sha256(statementBytes)),
  //   origin === statement.app, authenticatorData UP and UV set, then verify over
  //   authData || sha256(clientDataJSON) with pinned.presenceKey.
  void signed;
  void pinned;
  void options;
  throw new Error("not implemented");
}
