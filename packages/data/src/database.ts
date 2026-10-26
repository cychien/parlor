import type { DataProvider, ListenOptions, Unlisten } from "@parlor/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";

import { migratesWhileLoading, pgliteHandle } from "#platform";

import {
  ConnectionOwner,
  currentOwner,
  type ScopedConnections,
} from "./connection-scope.js";
import { migrateDatabase } from "./migrations.js";
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

function openPgConnections(url: string, onClose?: () => void): PgConnections {
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", (error) => {
    console.warn("[parlor] an idle database connection dropped:", error.message);
  });
  const listeners = new Set<pg.Client>();
  return {
    pool,
    db: drizzle(pool),
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

function nodePostgresHandle(url: string, directUrl: string): DatabaseHandle {
  const key = {};
  const outside = new ConnectionOwner();
  const opened = new Set<PgConnections>();
  const connections = () =>
    (currentOwner() ?? outside).connectionsFor(key, () => {
      const created = openPgConnections(url, () => opened.delete(created));
      opened.add(created);
      return created;
    });
  return {
    db: scopedDatabase(() => connections().db),
    client: { query: (text, params) => connections().pool.query(text, params) },
    driver: "node-postgres",
    read: () => connections().db,
    transaction: (run) => connections().db.transaction((tx) => run(tx)),
    listen: async (channel, handler, options = {}) => {
      const { listeners } = connections();
      const client = new pg.Client({ connectionString: directUrl });
      let state: "listening" | "lost" | "closed" = "listening";
      const current = () => state;
      const lose = () => {
        if (state !== "listening") return;
        state = "lost";
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
        await client.end().catch(() => {});
        throw error;
      }
      if (current() === "lost")
        throw new Error(`LISTEN ${identifier} lost its connection`);
      listeners.add(client);
      return async () => {
        if (state !== "listening") return;
        state = "closed";
        listeners.delete(client);
        await client.query(`UNLISTEN ${identifier}`).catch(() => {});
        await client.end();
      };
    },
    migrate: async (folder) => {
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
    },
    close: once(async () => {
      outside.forget(key);
      await Promise.all([...opened].map((created) => created.close()));
    }),
  };
}

export async function createDatabase(
  options: DatabaseOptions = {},
): Promise<DatabaseHandle> {
  const url = options.url ?? resolveDatabaseUrl();
  const handle = url
    ? nodePostgresHandle(url, options.directUrl ?? resolveDirectUrl() ?? url)
    : await pgliteHandle(options.dataDir ?? resolvePgliteDir());
  const folder = options.migrationsFolder;
  if (!folder) return handle;
  if (migratesWhileLoading) {
    await handle.migrate(folder);
    return handle;
  }
  let migrated: Promise<void> | undefined;
  return { ...handle, prepare: () => (migrated ??= handle.migrate(folder)) };
}
