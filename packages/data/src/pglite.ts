import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { DatabaseHandle } from "./database.js";
import { migrateDatabase } from "./migrations.js";
import { once } from "./once.js";

async function prepareDataDir(dataDir: string): Promise<void> {
  if (/^[a-z]+:\/\//i.test(dataDir)) return;
  await mkdir(dirname(dataDir), { recursive: true });
}

export async function pgliteHandle(dataDir: string): Promise<DatabaseHandle> {
  await prepareDataDir(dataDir);
  const client = new PGlite(dataDir);
  const db = drizzle(client);
  return {
    db,
    client: { query: (text, params) => client.query(text, params) },
    driver: "pglite",
    read: () => db,
    transaction: (run) => db.transaction((tx) => run(tx)),
    listen: async (channel, handler) => {
      const unlisten = await client.listen(channel, handler);
      return () => unlisten();
    },
    migrate: (folder) => migrateDatabase(db, folder),
    close: once(() => client.close()),
  };
}
