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

export interface DatabaseHandle extends DataProvider<Database> {
  readonly db: Database;
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

export function resolveDirectUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.DATABASE_DIRECT_URL || undefined;
}

interface PgConnections extends ScopedConnections {
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
    db: drizzle(pool),
    listeners,
    close: once(async () => {
      onClose?.();
      await Promise.all([...listeners].map((client) => client.end()));
      await pool.end();
    }),
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
    : await pgliteHandle(options.dataDir ?? DEFAULT_PGLITE_DIR);
  const folder = options.migrationsFolder;
  if (!folder) return handle;
  if (migratesWhileLoading) {
    await handle.migrate(folder);
    return handle;
  }
  let migrated: Promise<void> | undefined;
  return { ...handle, prepare: () => (migrated ??= handle.migrate(folder)) };
}
