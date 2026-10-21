import type { ClientChannel, SyncEvent } from "@parlor/sync";
import type { SyncClient } from "@parlor/sync/client";

export interface FrameworkSync {
  addChannel(channel: ClientChannel): () => void;
  onEvents(listener: (events: readonly SyncEvent[]) => void): () => void;
  /** The connection came back after a failure; reread what could have changed unseen. */
  onResume(listener: () => void): () => void;
  /** What the server negotiated; `undefined` until it has, and while no client is attached. */
  transport(): "sse" | "poll" | undefined;
}

export class SyncBridge implements FrameworkSync {
  readonly #channels = new Set<ClientChannel>();
  readonly #listeners = new Set<(events: readonly SyncEvent[]) => void>();
  readonly #detachers = new Map<ClientChannel, () => void>();
  readonly #resumers = new Set<() => void>();
  #client: SyncClient | undefined;
  #transport: "sse" | "poll" | undefined;

  addChannel(channel: ClientChannel): () => void {
    this.#channels.add(channel);
    this.#join(channel);
    return () => {
      this.#channels.delete(channel);
      this.#detachers.get(channel)?.();
      this.#detachers.delete(channel);
    };
  }

  onEvents(listener: (events: readonly SyncEvent[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onResume(listener: () => void): () => void {
    this.#resumers.add(listener);
    return () => this.#resumers.delete(listener);
  }

  transport(): "sse" | "poll" | undefined {
    return this.#transport;
  }

  negotiated(transport: "sse" | "poll"): void {
    this.#transport = transport;
  }

  emit(events: readonly SyncEvent[]): void {
    for (const listener of [...this.#listeners]) listener(events);
  }

  resumed(): void {
    for (const listener of [...this.#resumers]) listener();
  }

  attach(client: SyncClient): () => void {
    this.#client = client;
    for (const channel of this.#channels) this.#join(channel);
    return () => {
      if (this.#client === client) {
        this.#client = undefined;
        this.#transport = undefined;
      }
      this.#detachers.clear();
    };
  }

  #join(channel: ClientChannel): void {
    if (!this.#client) return;
    this.#detachers.get(channel)?.();
    this.#detachers.set(channel, this.#client.addChannel(channel));
  }
}
