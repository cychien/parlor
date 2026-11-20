import type { DataProvider, Unlisten } from "@parlor/core";

import { cursorOf, SYNC_CHANNEL, type SyncCursor, type SyncEvent } from "../protocol.js";
import {
  MAX_BATCH,
  parseNotifyPayload,
  readSyncHead,
  readSyncTail,
  type SyncDatabase,
} from "./store.js";

export type SyncSubscriber = (event: SyncEvent) => void;

interface Subscription {
  readonly notify: SyncSubscriber;
  readonly onStop: (() => void) | undefined;
}

/** A stream this hub hears on the bus, from its first subscriber to its last. */
interface Heard {
  readonly listening: Promise<Unlisten | undefined>;
}

const TAIL_RETRY_MS = 1000;

export class SyncHub {
  readonly #subscribers = new Map<string, Set<Subscription>>();
  readonly #heard = new Map<string, Heard>();
  #unlisten: Unlisten | undefined;
  #starting: Promise<void> | undefined;
  /** The last event read from the log; forgotten when a write finds nobody subscribed. */
  #head: SyncCursor | undefined;
  #heading: Promise<void> | undefined;
  #reading = false;
  #woken = false;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly data: DataProvider) {}

  get canPush(): boolean {
    return typeof this.data.listen === "function";
  }

  /**
   * No event can miss it. It hears "something was written" in its own process, over no
   * connection that could drop, and reads what from the log in the order it committed, so a
   * notification that never came or came out of turn costs no event.
   */
  get lossless(): boolean {
    return this.canPush && (this.data.notifications === "process" || this.#onBus);
  }

  /** Hears each stream it serves on its own topic, from runtimes that share no process with it. */
  get #onBus(): boolean {
    return this.data.notifications === "bus";
  }

  async start(): Promise<void> {
    if (!this.data.listen) return;
    if (this.#onBus) {
      await this.#follow();
      return;
    }
    if (!this.#unlisten) {
      const starting = (this.#starting ??= this.data
        .listen(
          SYNC_CHANNEL,
          (payload) => {
            if (this.lossless) {
              this.#wake();
              return;
            }
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
    if (this.lossless) await this.#follow();
  }

  /** Reads on from where the log stands now; a stream catches up on what came before. */
  async #follow(): Promise<void> {
    if (this.#head) return;
    this.#heading ??= readSyncHead(this.#db())
      .then((head) => {
        this.#head ??= head;
      })
      .finally(() => {
        this.#heading = undefined;
      });
    await this.#heading;
  }

  /** Something was written. With nobody subscribed it only forgets its place, so the next subscriber starts from where the log is then. */
  #wake(): void {
    if (this.#subscribers.size === 0) {
      this.#head = undefined;
      return;
    }
    if (this.#reading) {
      this.#woken = true;
      return;
    }
    void this.#tail();
  }

  async #tail(): Promise<void> {
    this.#reading = true;
    try {
      do {
        this.#woken = false;
        const head = this.#head;
        if (!head || this.#subscribers.size === 0) return;
        const found = await readSyncTail(
          this.#db(),
          head,
          undefined,
          this.#onBus ? [...this.#subscribers.keys()] : undefined,
        );
        if (this.#head !== head) return;
        for (const { scope, event } of found) this.publish(scope, event);
        const last = found.at(-1);
        if (last) this.#head = cursorOf(last.event);
        if (found.length >= MAX_BATCH) this.#woken = true;
      } while (this.#woken);
    } catch (error) {
      console.error("[parlor] sync: reading new events failed, trying again:", error);
      this.#retry ??= setTimeout(() => {
        this.#retry = undefined;
        this.#wake();
      }, TAIL_RETRY_MS);
      (this.#retry as { unref?: () => void }).unref?.();
    } finally {
      this.#reading = false;
    }
  }

  #db(): SyncDatabase {
    return this.data.read() as SyncDatabase;
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
    if (this.#onBus && !this.#heard.has(scope)) this.#hear(scope);
    return () => {
      set.delete(subscription);
      if (set.size === 0 && this.#subscribers.get(scope) === set) {
        this.#subscribers.delete(scope);
        this.#stopHearing(scope);
      }
    };
  }

  #hear(stream: string): void {
    const listening = this.data.listen!(SYNC_CHANNEL, () => this.#wake(), {
      topic: stream,
    }).catch((error: unknown) => {
      console.error(`[parlor] sync: could not hear stream "${stream}":`, error);
      if (this.#heard.get(stream) === heard) this.#heard.delete(stream);
      for (const { onStop } of this.#subscribers.get(stream) ?? []) onStop?.();
      return undefined;
    });
    const heard: Heard = { listening };
    this.#heard.set(stream, heard);
  }

  #stopHearing(stream: string): void {
    const heard = this.#heard.get(stream);
    if (!heard) return;
    this.#heard.delete(stream);
    void heard.listening.then((unlisten) => unlisten?.()).catch(() => {});
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
    for (const stream of [...this.#heard.keys()]) this.#stopHearing(stream);
    await this.#unlisten?.();
    this.#unlisten = undefined;
    this.#starting = undefined;
    this.#subscribers.clear();
    this.#head = undefined;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
  }
}
