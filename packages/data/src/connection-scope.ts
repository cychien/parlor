import { AsyncLocalStorage } from "node:async_hooks";

export interface ScopedConnections {
  close(): Promise<void>;
}

/**
 * Who owns the database connections opened while `run` executes. Outside every scope a
 * handle keeps its own connections for the life of the process.
 */
export interface ConnectionScope {
  run<T>(fn: () => T): T;
  close(): Promise<void>;
}

export class ConnectionOwner {
  readonly #connections = new Map<object, ScopedConnections>();
  #closed = false;

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
export function createConnectionScope(): ConnectionScope {
  const owner = new ConnectionOwner();
  return {
    run: (fn) => active.run(owner, fn),
    close: () => owner.close(),
  };
}
