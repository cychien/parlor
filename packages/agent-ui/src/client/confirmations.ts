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
  /** The chat thread an inline agent asked from; the chat shows the card inline there. */
  readonly threadId?: string | undefined;
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

interface Entry {
  readonly signature: string;
  readonly item: AgentConfirmation;
}

const signatureOf = (prompt: ConfirmationPrompt) =>
  JSON.stringify([
    prompt.action,
    prompt.description,
    prompt.input,
    prompt.origin.via,
    prompt.origin.name,
  ]);

const sameItems = (a: readonly AgentConfirmation[], b: readonly AgentConfirmation[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

export function createConfirmationStore(
  options: ConfirmationStoreOptions,
): ConfirmationStoreRuntime {
  const { env } = options;
  const listeners = new Set<() => void>();
  let entries = new Map<string, Entry>();
  const answered = new Set<string>();
  let visible: readonly AgentConfirmation[] = [];
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const scheduleExpiry = () => {
    env.clearTimeout(expiry);
    expiry = undefined;
    if (visible.length === 0) return;
    const next = Math.min(...visible.map((item) => item.expiresAt));
    expiry = env.setTimeout(expire, Math.max(0, next - env.now()));
  };

  const commit = () => {
    const next = [...entries.values()]
      .map((entry) => entry.item)
      .filter((item) => !answered.has(item.id));
    if (sameItems(next, visible)) return;
    visible = next;
    scheduleExpiry();
    for (const listener of listeners) listener();
    options.onChange();
  };

  function expire() {
    const now = env.now();
    entries = new Map([...entries].filter(([, entry]) => entry.item.expiresAt > now));
    commit();
    scheduleExpiry();
  }

  const respond = (id: string, approve: boolean) => {
    if (answered.has(id)) return;
    answered.add(id);
    options.answer(id, approve);
    commit();
  };

  const itemOf = (prompt: ConfirmationPrompt): AgentConfirmation => ({
    id: prompt.id,
    action: prompt.action,
    description: prompt.description,
    input: prompt.input,
    origin: prompt.origin,
    expiresAt: env.now() + prompt.expiresInMs,
    approve: () => respond(prompt.id, true),
    decline: () => respond(prompt.id, false),
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) options.onWatchedChange();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) options.onWatchedChange();
      };
    },
    get: () => visible,
    replace(prompts) {
      const next = new Map<string, Entry>();
      for (const prompt of prompts) {
        const signature = signatureOf(prompt);
        const known = entries.get(prompt.id);
        next.set(
          prompt.id,
          known?.signature === signature ? known : { signature, item: itemOf(prompt) },
        );
      }
      entries = next;
      for (const id of answered) if (!next.has(id)) answered.delete(id);
      commit();
    },
    watched: () => listeners.size > 0,
    dispose() {
      env.clearTimeout(expiry);
      expiry = undefined;
      listeners.clear();
    },
  };
}
