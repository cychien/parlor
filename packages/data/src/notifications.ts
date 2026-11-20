import { is } from "drizzle-orm";
import {
  type PgDatabase,
  type PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core";

type Database = PgDatabase<PgQueryResultHKT>;
type Transact = Database["transaction"];

export interface Notification {
  readonly channel: string;
  readonly payload: string;
  readonly topic?: string | undefined;
}

export type Deliver = (notified: readonly Notification[]) => void | Promise<void>;

type Source = "process" | "database";

/** The `listen` handlers of one process, reached without a database connection. */
export class ProcessChannels {
  readonly #handlers = new Map<string, Set<(payload: string) => void>>();
  /** While the database is heard too: what each source delivered that the other has yet to repeat. */
  #unmatched: Record<Source, Map<string, number>> | undefined;

  /**
   * From now until the returned function is called, what this process notifies also comes
   * back through the database (`heard`), and each notification is still delivered once.
   */
  hearDatabase(): () => void {
    this.#unmatched ??= { process: new Map(), database: new Map() };
    return () => {
      this.#unmatched = undefined;
    };
  }

  listen(channel: string, handler: (payload: string) => void): () => void {
    const handlers = this.#handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.#handlers.get(channel) === handlers) {
        this.#handlers.delete(channel);
      }
    };
  }

  /** What this process notified, once its transaction committed. */
  deliver: Deliver = (notified) => {
    for (const notification of notified) this.#arrive(notification, "process");
  };

  /** What the database notified: this process's own again, or another server's. */
  heard(notification: Notification): void {
    this.#arrive(notification, "database");
  }

  #arrive({ channel, payload }: Notification, from: Source): void {
    if (this.#unmatched) {
      const key = `${channel}\u0000${payload}`;
      const other = this.#unmatched[from === "process" ? "database" : "process"];
      const repeated = other.get(key) ?? 0;
      if (repeated > 0) {
        if (repeated === 1) other.delete(key);
        else other.set(key, repeated - 1);
        return;
      }
      const own = this.#unmatched[from];
      own.set(key, (own.get(key) ?? 0) + 1);
    }
    for (const handler of [...(this.#handlers.get(channel) ?? [])]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[parlor] a listener of "${channel}" failed:`, error);
      }
    }
  }
}

const held = new WeakMap<object, Notification[]>();

/** What `tx` has notified so far, when it is a transaction `holdNotifications` follows. */
export function heldBy(tx: object): Notification[] | undefined {
  return held.get(tx);
}

export function isTransaction(value: unknown): boolean {
  return is(value, PgTransaction);
}

/**
 * From now on a transaction of `db` holds what it notifies and delivers it once it has
 * committed. A savepoint's notifications join its parent's when it is released and are
 * dropped when it rolls back, as Postgres treats NOTIFY.
 */
export function holdNotifications(db: Database, deliver: Deliver): void {
  const begin = db.transaction.bind(db) as Transact;
  db.transaction = (async (run, config) => {
    const notified: Notification[] = [];
    const result = await begin((tx) => run(holding(tx, notified)), config);
    await deliver(notified);
    return result;
  }) as Transact;
}

function holding<Tx extends Database>(tx: Tx, notified: Notification[]): Tx {
  held.set(tx, notified);
  const savepoint = tx.transaction.bind(tx) as Transact;
  tx.transaction = (async (run, config) => {
    const inner: Notification[] = [];
    const result = await savepoint((nested) => run(holding(nested, inner)), config);
    notified.push(...inner);
    return result;
  }) as Transact;
  return tx;
}
