import type { AgentOrigin, ConfirmationAnswer } from "../protocol.js";
import type { ClientDirectory } from "./directory.js";

/** The 60 s the user gets, less 1 s so a client on MCP's default 60 s timeout hears our code. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 59_000;

export const ORPHAN_GRACE_MS = 5_000;

export const MAX_PENDING_PER_SCOPE = 8;

export interface ConfirmationRequest {
  readonly scope: string;
  readonly clientId?: string | undefined;
  readonly action: string;
  readonly description: string;
  readonly input: unknown;
  readonly origin: AgentOrigin;
  readonly signal?: AbortSignal | undefined;
}

/**
 * How a confirmation ended. `unavailable`: nobody can show the card (now, or for the grace
 * period mid-wait). `cancelled`: the agent gave up, or the server is shutting down.
 */
export type ConfirmationOutcome =
  | "approved"
  | "declined"
  | "timeout"
  | "unavailable"
  | "cancelled";

export interface ConfirmationBoardOptions {
  readonly directory: ClientDirectory;
  readonly timeoutMs: number;
  readonly orphanGraceMs?: number | undefined;
  readonly maxPendingPerScope?: number | undefined;
  readonly newId?: (() => string) | undefined;
}

export class ConfirmationBoard {
  constructor(readonly options: ConfirmationBoardOptions) {}

  ask(_request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    return Promise.reject(new Error("not implemented"));
  }

  answer(_clientId: string, _scope: string, _answer: ConfirmationAnswer): boolean {
    return false;
  }

  close(): void {}
}
