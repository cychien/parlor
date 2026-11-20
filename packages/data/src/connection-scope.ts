import { AsyncLocalStorage } from "node:async_hooks";

export interface ScopedConnections {
  close(): Promise<void>;
}

/**
 * How runtimes that share no process tell each other what they notify, such as Durable
 * Objects reached over RPC. A runtime hears a topic of a channel once it subscribed to it.
 */
export interface NotificationBus {
  /** Tells every other runtime subscribed to `topic` of `channel`. */
  publish(channel: string, topic: string, payload: string): Promise<void>;
  subscribe(channel: string, topic: string): Promise<void>;
  unsubscribe(channel: string, topic: string): Promise<void>;
}

/**
 * Who owns the database connections opened while `run` executes. Outside every scope a
 * handle keeps its own connections for the life of the process.
 */
export interface ConnectionScope {
  run<T>(fn: () => T): T;
  /**
   * Hands this scope's `listen` handlers what another runtime published on the bus; false when
   * none listens to `topic` of `channel` any more, and the scope then unsubscribes it itself.
   */
  deliver(channel: string, topic: string, payload: string): boolean;
  close(): Promise<void>;
}

export interface ConnectionScopeOptions {
  /** Where a handle with `notifications: "bus"` sends and hears notifications in this scope. */
  readonly bus?: NotificationBus | undefined;
}

type Handler = (payload: string) => void;

/** The `listen` handlers of one scope by channel and topic, subscribed on the bus while any listens. */
export class TopicChannels {
  readonly #handlers = new Map<string, Map<string, Set<Handler>>>();
  /** Per channel and topic: the last subscription the bus was told, and the call telling it. */
  readonly #told = new Map<string, { subscribed: boolean; telling: Promise<void> }>();

  constructor(private readonly bus: NotificationBus | undefined) {}

  async listen(
    channel: string,
    topic: string,
    handler: Handler,
  ): Promise<() => Promise<void>> {
    const topics = this.#handlers.get(channel) ?? new Map<string, Set<Handler>>();
    this.#handlers.set(channel, topics);
    const handlers = topics.get(topic) ?? new Set<Handler>();
    handlers.add(handler);
    topics.set(topic, handlers);
    const leave = () => {
      handlers.delete(handler);
      if (handlers.size === 0 && topics.get(topic) === handlers) topics.delete(topic);
      if (topics.size === 0 && this.#handlers.get(channel) === topics) {
        this.#handlers.delete(channel);
      }
    };
    try {
      await this.#tell(channel, topic);
    } catch (error) {
      leave();
      throw error;
    }
    return async () => {
      if (!handlers.delete(handler) || handlers.size > 0) return;
      if (topics.get(topic) === handlers) topics.delete(topic);
      if (topics.size === 0 && this.#handlers.get(channel) === topics) {
        this.#handlers.delete(channel);
      }
      await this.#tell(channel, topic);
    };
  }

  #listening(channel: string, topic: string): boolean {
    return (this.#handlers.get(channel)?.get(topic)?.size ?? 0) > 0;
  }

  /**
   * Brings the bus to whether anyone listens now, one call at a time per topic, so a quick
   * leave and return cannot reach it in the wrong order.
   */
  #tell(channel: string, topic: string, delivered = false): Promise<void> {
    const bus = this.bus;
    if (!bus) return Promise.resolve();
    const key = `${channel}\u0000${topic}`;
    const told = this.#told.get(key) ?? { subscribed: false, telling: Promise.resolve() };
    this.#told.set(key, told);
    const next = told.telling.then(async () => {
      // The bus sent it here, so it still lists this scope, whatever this scope remembers.
      if (delivered) told.subscribed = true;
      const wanted = this.#listening(channel, topic);
      if (wanted === told.subscribed) return;
      if (wanted) await bus.subscribe(channel, topic);
      else await bus.unsubscribe(channel, topic);
      told.subscribed = wanted;
    });
    told.telling = next.catch(() => {});
    return next;
  }

  /**
   * What this scope notified itself, or what the bus brought: false when nobody listens. For
   * the bus it also leaves the topic, in turn with this scope's other calls about it, so the
   * bus never has to drop a subscription on its own and race a new one.
   */
  deliver(channel: string, topic: string, payload: string, fromBus = false): boolean {
    const handlers = this.#handlers.get(channel)?.get(topic);
    if (!handlers || handlers.size === 0) {
      if (fromBus) {
        this.#tell(channel, topic, true).catch((error: unknown) => {
          console.error(`[parlor] could not leave "${channel}" on the bus:`, error);
        });
      }
      return false;
    }
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[parlor] a listener of "${channel}" failed:`, error);
      }
    }
    return true;
  }

  async publish(channel: string, topic: string, payload: string): Promise<void> {
    this.deliver(channel, topic, payload);
    await this.bus?.publish(channel, topic, payload);
  }
}

export class ConnectionOwner {
  readonly #connections = new Map<object, ScopedConnections>();
  #closed = false;
  readonly topics: TopicChannels;

  constructor(options: ConnectionScopeOptions = {}) {
    this.topics = new TopicChannels(options.bus);
  }

  connectionsFor<C extends ScopedConnections>(key: object, open: () => C): C {
    if (this.#closed) throw new Error("This connection scope is closed.");
    let connections = this.#connections.get(key);
    if (!connections) {
      connections = open();
      this.#connections.set(key, connections);
    }
    return connections as C;
  }

  forget(key: object): void {
    this.#connections.delete(key);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const open = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(open.map((connections) => connections.close()));
  }
}

const active = new AsyncLocalStorage<ConnectionOwner>();

export function currentOwner(): ConnectionOwner | undefined {
  return active.getStore();
}

/**
 * Connections opened inside `run` belong to this scope and close with it. Use one per
 * runtime context that must not share sockets: a Worker request, or a Durable Object
 * instance, since workerd cancels I/O started in one context and awaited from another.
 */
export function createConnectionScope(
  options: ConnectionScopeOptions = {},
): ConnectionScope {
  const owner = new ConnectionOwner(options);
  return {
    run: (fn) => active.run(owner, fn),
    deliver: (channel, topic, payload) =>
      active.run(owner, () => owner.topics.deliver(channel, topic, payload, true)),
    close: () => owner.close(),
  };
}
