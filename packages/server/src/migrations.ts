import type { DataProvider } from "@parlor/core";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { ServerPlugin } from "./plugin.js";

type Database = PgDatabase<PgQueryResultHKT>;

const MIGRATION_LOCK_KEY = 7_311_208;

export function checkMigrations(plugin: ServerPlugin): void {
  const seen = new Set<string>();
  for (const { id } of plugin.migrations ?? []) {
    if (!id.startsWith(`${plugin.name}/`)) {
      throw new Error(`Migration "${id}" must start with "${plugin.name}/".`);
    }
    if (seen.has(id)) throw new Error(`Migration "${id}" is listed twice.`);
    seen.add(id);
  }
}

export async function applyMigrations(
  database: DataProvider,
  plugins: readonly ServerPlugin[],
): Promise<void> {
  const migrations = plugins.flatMap((plugin) => plugin.migrations ?? []);
  if (migrations.length === 0) return;
  await database.transaction(async (handle) => {
    const tx = handle as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await tx.execute(sql`
      create table if not exists parlor_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )`);
    const result = (await tx.execute(sql`select id from parlor_migrations`)) as
      | { rows?: { id: string }[] }
      | { id: string }[];
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const applied = new Set(rows.map((row) => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await tx.execute(sql.raw(migration.sql));
      await tx.execute(sql`insert into parlor_migrations (id) values (${migration.id})`);
    }
  });
}
