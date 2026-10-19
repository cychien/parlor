import type { DataProvider, Unlisten } from "@parlor/core";

import { SYNC_CHANNEL, type SyncEvent } from "../protocol.js";
import { parseNotifyPayload } from "./store.js";

export type SyncSubscriber = (event: SyncEvent) => void;

interface Subscription {
  readonly notify: SyncSubscriber;
  readonly onStop: (() => void) | undefined;
}

export class SyncHub {
  readonly #subscribers = new Map<string, Set<Subscription>>();
  #unlisten: Unlisten | undefined;
  #starting: Promise<void> | undefined;

  constructor(private readonly data: DataProvider) {}

  get canPush(): boolean {
    return typeof this.data.listen === "function";
  }

  async start(): Promise<void> {
    if (!this.data.listen || this.#unlisten) return;
    const starting = (this.#starting ??= this.data
      .listen(
        SYNC_CHANNEL,
        (payload) => {
          const parsed = parseNotifyPayload(payload);
          if (parsed) this.publish(parsed.scope, parsed.event);
        },
        { onLost: () => this.#reconnectEveryStream() },
      )
      .then(
        (unlisten) => {
          if (this.#starting === starting) this.#unlisten = unlisten;
          else void unlisten();
        },
        (error: unknown) => {
          if (this.#starting === starting) this.#starting = undefined;
          throw error;
        },
      ));
    await starting;
  }

  #reconnectEveryStream(): void {
    this.#unlisten = undefined;
    this.#starting = undefined;
    const subscriptions = [...this.#subscribers.values()].flatMap((set) => [...set]);
    for (const { onStop } of subscriptions) onStop?.();
  }

  publish(scope: string, event: SyncEvent): void {
    for (const { notify } of this.#subscribers.get(scope) ?? []) notify(event);
  }

  subscribe(scope: string, notify: SyncSubscriber, onStop?: () => void): () => void {
    const subscription: Subscription = { notify, onStop };
    const set = this.#subscribers.get(scope) ?? new Set();
    set.add(subscription);
    this.#subscribers.set(scope, set);
    return () => {
      set.delete(subscription);
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
    const subscriptions = [...this.#subscribers.values()].flatMap((set) => [...set]);
    for (const { onStop } of subscriptions) onStop?.();
    await this.#unlisten?.();
    this.#unlisten = undefined;
    this.#starting = undefined;
    this.#subscribers.clear();
  }
}
