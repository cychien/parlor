import type { DataProvider, Unlisten } from "@parlor/core";

import { SYNC_CHANNEL, type SyncEvent } from "../protocol.js";
import { parseNotifyPayload } from "./store.js";

export type SyncSubscriber = (event: SyncEvent) => void;

export class SyncHub {
  readonly #subscribers = new Map<string, Set<SyncSubscriber>>();
  #unlisten: Unlisten | undefined;
  #starting: Promise<void> | undefined;

  constructor(private readonly data: DataProvider) {}

  get canPush(): boolean {
    return typeof this.data.listen === "function";
  }

  async start(): Promise<void> {
    if (!this.data.listen || this.#unlisten) return;
    this.#starting ??= this.data
      .listen(SYNC_CHANNEL, (payload) => {
        const parsed = parseNotifyPayload(payload);
        if (parsed) this.publish(parsed.scope, parsed.event);
      })
      .then((unlisten) => {
        this.#unlisten = unlisten;
      });
    await this.#starting;
  }

  publish(scope: string, event: SyncEvent): void {
    for (const subscriber of this.#subscribers.get(scope) ?? []) subscriber(event);
  }

  subscribe(scope: string, subscriber: SyncSubscriber): () => void {
    const set = this.#subscribers.get(scope) ?? new Set();
    set.add(subscriber);
    this.#subscribers.set(scope, set);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.#subscribers.delete(scope);
    };
  }

  subscriberCount(scope?: string): number {
    if (scope) return this.#subscribers.get(scope)?.size ?? 0;
    let total = 0;
    for (const set of this.#subscribers.values()) total += set.size;
    return total;
  }

  async stop(): Promise<void> {
    await this.#unlisten?.();
    this.#unlisten = undefined;
    this.#starting = undefined;
    this.#subscribers.clear();
  }
}
