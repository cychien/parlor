import type {
  DataProvider,
  ListenOptions,
  NotificationReach,
  Unlisten,
} from "@parlor/core";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";

import { migratesWhileLoading, pgliteHandle } from "#platform";

import {
  ConnectionOwner,
  currentOwner,
  type ScopedConnections,
} from "./connection-scope.js";
import { corkWrites } from "./cork.js";
import { migrateDatabase } from "./migrations.js";
import {
  heldBy,
  holdNotifications,
  isTransaction,
  ProcessChannels,
} from "./notifications.js";
import { once } from "./once.js";

export type Database = PgDatabase<PgQueryResultHKT>;

declare module "@parlor/core" {
  interface DataRegister {
    database: Database;
  }
}

export interface DatabaseOptions {
  readonly url?: string | undefined;
  /**
   * A connection that bypasses any pooler, for LISTEN and migrations. Transaction poolers
   * such as PgBouncer, Neon's pooled endpoint or Hyperdrive cannot hold a LISTEN.
   * Defaults to `DATABASE_DIRECT_URL`, then to `url`.
   */
  readonly directUrl?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly migrationsFolder?: string | undefined;
  /**
   * How often a LISTEN connection is asked to answer, and how long it has to. One that does not
   * answer is reported lost, since a connection can die without closing, e.g. when the database
   * restarts behind a proxy. Defaults to 10 seconds.
   */
  readonly listenCheckMs?: number | undefined;
  /**
   * Where `listen` hears `notify` from. `process` keeps notifications inside this process:
   * no LISTEN connection is held, so an idle server leaves the database alone, but another
   * server on the same database hears nothing. Right for the app's only server. `database`
   * sends them through Postgres NOTIFY to every server, each holding a LISTEN connection.
   * Defaults to `process` when `PARLOR_INSTANCES` is `one`, which `parlor build` sets for a
   * preset that runs a single server, and to `database` otherwise. PGlite is always `process`.
   */
  readonly notifications?: NotificationReach | undefined;
  /**
   * How long a server that notifies in process also listens through the database after it
   * starts, to hear the server it replaces finish what it had begun: a deploy runs the two
   * side by side for a moment. Defaults to 2 minutes; 0 never listens.
   */
  readonly predecessorMs?: number | undefined;
}

const DEFAULT_PREDECESSOR_MS = 2 * 60_000;

const DEFAULT_LISTEN_CHECK_MS = 10_000;

/** One server serves the app, so what it holds in memory is all there is. */
export function resolveNotifications(
  instances: string | undefined = process.env.PARLOR_INSTANCES,
): NotificationReach {
  return instances === "one" ? "process" : "database";
}

/** Runs one parameterized statement (`$1`, `$2`, ...) and answers its rows, as `pg` does. */
export interface DatabaseClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface DatabaseHandle extends DataProvider<Database> {
  readonly db: Database;
  /**
   * The connection under `db`, for libraries that take a `pg`-style client. Each statement
   * runs on its own, outside any transaction, on the current connection scope's connections.
   */
  readonly client: DatabaseClient;
  readonly driver: "pglite" | "node-postgres";
  listen(
    channel: string,
    handler: (payload: string) => void,
    options?: ListenOptions,
  ): Promise<Unlisten>;
  notify(channel: string, payload: string, tx?: Database): Promise<void>;
  readonly notifications: NotificationReach;
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_PGLITE_DIR = ".parlor/pglite";

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.DATABASE_URL || undefined;
}

/** PGlite's directory when `dataDir` is not given: `pglite` in the run's generated directory. */
export function resolvePgliteDir(env: NodeJS.ProcessEnv = process.env): string {
  const generated = env.PARLOR_GENERATED_DIR?.replace(/\/+$/, "");
  return generated ? `${generated}/pglite` : DEFAULT_PGLITE_DIR;
}

export function resolveDirectUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.DATABASE_DIRECT_URL || undefined;
}

interface PgConnections extends ScopedConnections {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase;
  readonly listeners: Set<pg.Client>;
}

/**
 * The process's own notifications, which outlive every connection scope: a Durable Object
 * instance that replaces another in the same isolate keeps hearing what the server's
 * listeners, started in the one before, are waiting for.
 */
interface InProcess {
  readonly channels: ProcessChannels;
  readonly startedAt: number;
  readonly forMs: number;
  /** The connection that hears the server this one replaces, while it is still listened to. */
  predecessor?: { readonly listen: (channel: string) => void } | undefined;
}

/** `channels`, when given, hear what `db`'s transactions notify, once each commits. */
function openPgConnections(
  url: string,
  channels?: ProcessChannels,
  onClose?: () => void,
): PgConnections {
  const pool = new pg.Pool({ connectionString: url });
  pool.on("connect", (client) => {
    const { connection } = client as unknown as { connection?: { stream?: unknown } };
    if (connection?.stream)
      corkWrites(connection.stream as Parameters<typeof corkWrites>[0]);
  });
  pool.on("error", (error) => {
    console.warn("[parlor] an idle database connection dropped:", error.message);
  });
  const listeners = new Set<pg.Client>();
  const db = drizzle(pool);
  if (channels) holdNotifications(db, channels.deliver);
  return {
    pool,
    db,
    listeners,
    close: once(async () => {
      onClose?.();
      await Promise.all([...listeners].map((client) => client.end()));
      await pool.end();
    }),
  };
}

/**
 * A deployment with no database yet: it loads, so a host that runs the app's modules before
 * its settings exist (Cloudflare checks a Worker as it uploads) accepts it, and every use
 * fails with `error`, which the first request reports.
 */
export function unconfiguredHandle(error: Error): DatabaseHandle {
  const fail = (): never => {
    throw error;
  };
  return {
    db: scopedDatabase(fail),
    client: { query: () => Promise.reject(error) },
    driver: "node-postgres",
    read: fail,
    transaction: () => Promise.reject(error),
    listen: () => Promise.reject(error),
    notify: () => Promise.reject(error),
    notifications: "database",
    migrate: () => Promise.reject(error),
    close: async () => undefined,
  };
}

/** Stays valid across scopes, so code that captured `handle.db` at startup still works. */
function scopedDatabase(current: () => Database): Database {
  return new Proxy({} as Database, {
    get(_target, property) {
      const db = current();
      const value: unknown = Reflect.get(db, property, db);
      return typeof value === "function" ? value.bind(db) : value;
    },
    has: (_target, property) => Reflect.has(current(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(current()),
  });
}

function nodePostgresHandle(
  url: string,
  directUrl: string,
  listenCheckMs: number,
  reach: NotificationReach,
  predecessorMs: number,
): DatabaseHandle {
  const key = {};
  const outside = new ConnectionOwner();
  const opened = new Set<PgConnections>();
  const inProcess: InProcess | undefined =
    reach === "process"
      ? { channels: new ProcessChannels(), startedAt: Date.now(), forMs: predecessorMs }
      : undefined;
  const connections = () =>
    (currentOwner() ?? outside).connectionsFor(key, () => {
      const created = openPgConnections(url, inProcess?.channels, () =>
        opened.delete(created),
      );
      opened.add(created);
      return created;
    });
  const notify: DatabaseHandle["notify"] = async (channel, payload, tx) => {
    // Said through the database in either case: a server that notifies in process is heard
    // there by the one replacing it, which listens as it starts.
    await (tx ?? connections().db).execute(sql`select pg_notify(${channel}, ${payload})`);
    if (!inProcess) return;
    const waiting = tx === undefined ? undefined : heldBy(tx);
    if (waiting) {
      waiting.push({ channel, payload });
      return;
    }
    if (isTransaction(tx)) warnUnheldTransaction();
    inProcess.channels.deliver([{ channel, payload }]);
  };
  const listenInProcess =
    (state: InProcess): DatabaseHandle["listen"] =>
    async (channel, handler) => {
      const unlisten = state.channels.listen(channel, handler);
      hearPredecessor(state, connections(), directUrl, channel);
      return async () => unlisten();
    };
  const listenOnDatabase: DatabaseHandle["listen"] = async (
    channel,
    handler,
    options = {},
  ) => {
    const { listeners } = connections();
    const client = new pg.Client({
      connectionString: directUrl,
      keepAlive: true,
      query_timeout: listenCheckMs,
    });
    let state: "listening" | "lost" | "closed" = "listening";
    const current = () => state;
    let checking = false;
    const check = setInterval(() => {
      if (checking) return;
      checking = true;
      client.query("select 1").then(() => (checking = false), lose);
    }, listenCheckMs);
    const lose = () => {
      if (state !== "listening") return;
      state = "lost";
      clearInterval(check);
      listeners.delete(client);
      client.end().catch(() => {});
      options.onLost?.();
    };
    client.on("error", lose);
    client.on("end", lose);
    client.on("notification", (message) => {
      if (message.channel === channel) handler(message.payload ?? "");
    });
    const identifier = pg.escapeIdentifier(channel);
    try {
      await client.connect();
      await client.query(`LISTEN ${identifier}`);
    } catch (error) {
      state = "closed";
      clearInterval(check);
      await client.end().catch(() => {});
      throw error;
    }
    if (current() === "lost") throw new Error(`LISTEN ${identifier} lost its connection`);
    listeners.add(client);
    return async () => {
      if (state !== "listening") return;
      state = "closed";
      clearInterval(check);
      listeners.delete(client);
      await client.query(`UNLISTEN ${identifier}`).catch(() => {});
      await client.end();
    };
  };
  return {
    db: scopedDatabase(() => connections().db),
    client: { query: (text, params) => connections().pool.query(text, params) },
    driver: "node-postgres",
    read: () => connections().db,
    transaction: (run) => connections().db.transaction((tx) => run(tx)),
    listen: inProcess ? listenInProcess(inProcess) : listenOnDatabase,
    notify,
    notifications: reach,
    migrate: (folder) => migrateDirect(connections, url, directUrl, folder),
    close: once(async () => {
      outside.forget(key);
      await Promise.all([...opened].map((created) => created.close()));
    }),
  };
}

/**
 * For the first `forMs` after the server started, hears `channel` through the database as
 * well, where the server it replaces still notifies while it finishes. One connection, owned
 * by `own`'s scope and closed when the time is up; a failure only loses what that server
 * said, which nothing else would have heard.
 */
function hearPredecessor(
  state: InProcess,
  own: PgConnections,
  directUrl: string,
  channel: string,
): void {
  const remaining = state.startedAt + state.forMs - Date.now();
  if (remaining <= 0) return;
  if (!state.predecessor) {
    const client = new pg.Client({ connectionString: directUrl, keepAlive: true });
    const forget = state.channels.hearDatabase();
    const heard = new Set<string>();
    const end = once(async () => {
      clearTimeout(timer);
      forget();
      own.listeners.delete(client);
      await client.end().catch(() => {});
    });
    const timer = setTimeout(() => void end(), remaining);
    timer.unref?.();
    client.on("error", () => void end());
    client.on("end", () => void end());
    client.on("notification", (message) => {
      state.channels.heard({ channel: message.channel, payload: message.payload ?? "" });
    });
    own.listeners.add(client);
    const connected = client.connect();
    connected.catch((error: unknown) => {
      console.warn(
        "[parlor] could not listen for a server this one replaces:",
        error instanceof Error ? error.message : error,
      );
      void end();
    });
    state.predecessor = {
      listen(name) {
        if (heard.has(name)) return;
        heard.add(name);
        connected
          .then(() => client.query(`LISTEN ${pg.escapeIdentifier(name)}`))
          .catch(() => {});
      },
    };
  }
  state.predecessor.listen(channel);
}

async function migrateDirect(
  connections: () => PgConnections,
  url: string,
  directUrl: string,
  folder: string,
): Promise<void> {
  if (directUrl === url) {
    await migrateDatabase(connections().db, folder);
    return;
  }
  const direct = openPgConnections(directUrl);
  try {
    await migrateDatabase(direct.db, folder);
  } finally {
    await direct.close();
  }
}

let warnedUnheld = false;
function warnUnheldTransaction(): void {
  if (warnedUnheld) return;
  warnedUnheld = true;
  console.warn(
    "[parlor] notify() got a transaction this database handle did not open, so its notification went out before the commit. Open it with handle.transaction() or handle.db.transaction().",
  );
}

/**
 * `handle`, migrating `folder` on its first `prepare`. A failed run is not kept: the next
 * request tries again, rather than every request failing until the server restarts.
 */
export function migrateOnPrepare(handle: DatabaseHandle, folder: string): DatabaseHandle {
  let migrated: Promise<void> | undefined;
  const migrate = () =>
    handle.migrate(folder).catch((error: unknown) => {
      migrated = undefined;
      throw error;
    });
  return { ...handle, prepare: () => (migrated ??= migrate()) };
}

export async function createDatabase(
  options: DatabaseOptions = {},
): Promise<DatabaseHandle> {
  const url = options.url ?? resolveDatabaseUrl();
  const handle = url
    ? nodePostgresHandle(
        url,
        options.directUrl ?? resolveDirectUrl() ?? url,
        options.listenCheckMs ?? DEFAULT_LISTEN_CHECK_MS,
        options.notifications ?? resolveNotifications(),
        options.predecessorMs ?? DEFAULT_PREDECESSOR_MS,
      )
    : await pgliteHandle(options.dataDir ?? resolvePgliteDir());
  const folder = options.migrationsFolder;
  if (!folder) return handle;
  if (migratesWhileLoading) {
    await handle.migrate(folder);
    return handle;
  }
  return migrateOnPrepare(handle, folder);
}
