import type { ClientChannel, SyncEvent } from "@parlor/sync";
import type { SyncClient } from "@parlor/sync/client";

export interface FrameworkSync {
  addChannel(channel: ClientChannel): () => void;
  onEvents(listener: (events: readonly SyncEvent[]) => void): () => void;
}

export class SyncBridge implements FrameworkSync {
  readonly #channels = new Set<ClientChannel>();
  readonly #listeners = new Set<(events: readonly SyncEvent[]) => void>();
  readonly #detachers = new Map<ClientChannel, () => void>();
  #client: SyncClient | undefined;

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

  emit(events: readonly SyncEvent[]): void {
    for (const listener of [...this.#listeners]) listener(events);
  }

  attach(client: SyncClient): () => void {
    this.#client = client;
    for (const channel of this.#channels) this.#join(channel);
    return () => {
      if (this.#client === client) this.#client = undefined;
      this.#detachers.clear();
    };
  }

  #join(channel: ClientChannel): void {
    if (!this.#client) return;
    this.#detachers.get(channel)?.();
    this.#detachers.set(channel, this.#client.addChannel(channel));
  }
}
