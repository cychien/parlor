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

const DOLLAR_TAG = /^\$[A-Za-z_]*\$/;

/**
 * PGlite refuses several commands in one prepared statement, so a migration is run one
 * statement at a time. Quotes, comments and dollar-quoted bodies may hold semicolons.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let at = 0;
  const skipTo = (end: string) => {
    const close = script.indexOf(end, at);
    at = close === -1 ? script.length : close + end.length;
  };
  while (at < script.length) {
    const char = script[at]!;
    if (char === "'" || char === '"') {
      at += 1;
      skipTo(char);
    } else if (script.startsWith("--", at)) {
      skipTo("\n");
    } else if (script.startsWith("/*", at)) {
      skipTo("*/");
    } else if (char === "$" && DOLLAR_TAG.test(script.slice(at))) {
      const tag = DOLLAR_TAG.exec(script.slice(at))![0];
      at += tag.length;
      skipTo(tag);
    } else if (char === ";") {
      statements.push(script.slice(start, at));
      at += 1;
      start = at;
    } else {
      at += 1;
    }
  }
  statements.push(script.slice(start));
  return statements.map((statement) => statement.trim()).filter(Boolean);
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
      for (const statement of splitStatements(migration.sql)) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`insert into parlor_migrations (id) values (${migration.id})`);
    }
  });
}
