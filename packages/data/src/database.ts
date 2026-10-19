import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type { DataProvider, Unlisten } from "@parlor/core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";

export type Database = PgDatabase<PgQueryResultHKT>;

declare module "@parlor/core" {
  interface DataRegister {
    database: Database;
  }
}

export interface DatabaseOptions {
  readonly url?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly migrationsFolder?: string | undefined;
}

export interface DatabaseHandle extends DataProvider<Database> {
  readonly db: Database;
  readonly driver: "pglite" | "node-postgres";
  listen(channel: string, handler: (payload: string) => void): Promise<Unlisten>;
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_PGLITE_DIR = ".parlor/pglite";

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.DATABASE_URL || undefined;
}

function once(run: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => (result ??= run());
}

function pgliteHandle(dataDir: string): DatabaseHandle {
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client);
  return {
    db,
    driver: "pglite",
    read: () => db,
    transaction: (run) => db.transaction((tx) => run(tx)),
    listen: async (channel, handler) => {
      const unlisten = await client.listen(channel, handler);
      return () => unlisten();
    },
    migrate: (folder) => migratePglite(db, { migrationsFolder: folder }),
    close: once(() => client.close()),
  };
}

function nodePostgresHandle(url: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzlePg(pool);
  const listeners = new Set<pg.Client>();
  return {
    db,
    driver: "node-postgres",
    read: () => db,
    transaction: (run) => db.transaction((tx) => run(tx)),
    listen: async (channel, handler) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      listeners.add(client);
      client.on("notification", (message) => {
        if (message.channel === channel) handler(message.payload ?? "");
      });
      const identifier = pg.escapeIdentifier(channel);
      await client.query(`LISTEN ${identifier}`);
      return async () => {
        await client.query(`UNLISTEN ${identifier}`).catch(() => {});
        await client.end();
        listeners.delete(client);
      };
    },
    migrate: (folder) => migratePg(db, { migrationsFolder: folder }),
    close: once(async () => {
      await Promise.all([...listeners].map((client) => client.end()));
      await pool.end();
    }),
  };
}

async function preparePgliteDir(dataDir: string): Promise<void> {
  if (/^[a-z]+:\/\//i.test(dataDir)) return;
  await mkdir(dirname(dataDir), { recursive: true });
}

export async function createDatabase(
  options: DatabaseOptions = {},
): Promise<DatabaseHandle> {
  const url = options.url ?? resolveDatabaseUrl();
  const dataDir = options.dataDir ?? DEFAULT_PGLITE_DIR;
  if (!url) await preparePgliteDir(dataDir);
  const handle = url ? nodePostgresHandle(url) : pgliteHandle(dataDir);
  if (options.migrationsFolder) await handle.migrate(options.migrationsFolder);
  return handle;
}
