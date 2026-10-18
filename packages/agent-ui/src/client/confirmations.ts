import type { AgentOrigin, ConfirmationPrompt } from "../protocol.js";
import type { BrowserEnvironment } from "./environment.js";

/** A pending agent request the user must approve, as an app renders it. */
export interface AgentConfirmation {
  readonly id: string;
  readonly action: string;
  readonly description: string;
  /** The validated input the action will run with, as JSON. */
  readonly input: unknown;
  readonly origin: AgentOrigin;
  /** Local `Date.now()` time after which the server stops waiting. */
  readonly expiresAt: number;
  readonly approve: () => void;
  readonly decline: () => void;
}

export interface ConfirmationStore {
  subscribe(listener: () => void): () => void;
  get(): readonly AgentConfirmation[];
}

export interface ConfirmationStoreRuntime extends ConfirmationStore {
  replace(items: readonly ConfirmationPrompt[]): void;
  watched(): boolean;
  dispose(): void;
}

export interface ConfirmationStoreOptions {
  readonly env: Pick<BrowserEnvironment, "now" | "setTimeout" | "clearTimeout">;
  readonly answer: (id: string, approve: boolean) => void;
  readonly onWatchedChange: () => void;
  readonly onChange: () => void;
}

export function createConfirmationStore(
  _options: ConfirmationStoreOptions,
): ConfirmationStoreRuntime {
  const none: readonly AgentConfirmation[] = [];
  return {
    subscribe: () => () => {},
    get: () => none,
    replace() {},
    watched: () => false,
    dispose() {},
  };
}
