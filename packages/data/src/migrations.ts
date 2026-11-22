import { sql } from "drizzle-orm";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import type { PgDialect, PgSession } from "drizzle-orm/pg-core";

import type { Database } from "./database.js";

declare const __PARLOR_MIGRATIONS__:
  | Readonly<Record<string, MigrationMeta[]>>
  | undefined;

/** Builds without a filesystem, such as Cloudflare's, embed the migrations keyed by folder. */
function embedded(): Readonly<Record<string, MigrationMeta[]>> | undefined {
  return typeof __PARLOR_MIGRATIONS__ === "undefined" ? undefined : __PARLOR_MIGRATIONS__;
}

export function migrationsIn(folder: string): MigrationMeta[] {
  const bundled = embedded();
  if (!bundled) return readMigrationFiles({ migrationsFolder: folder });
  const migrations = bundled[folder];
  if (!migrations) {
    throw new Error(
      `The migrations in "${folder}" are not in this build. Parlor embeds the folder set as database.migrations in parlor.config.ts.`,
    );
  }
  return migrations;
}

interface Migratable {
  readonly dialect: PgDialect;
  readonly session: PgSession;
}

/** Drizzle's own migrator, fed from the build when there is no filesystem to read. */
export async function migrateDatabase(db: Database, folder: string): Promise<void> {
  const { dialect, session } = db as unknown as Migratable;
  await dialect.migrate(migrationsIn(folder), session, { migrationsFolder: folder });
}

/**
 * Whether `db` already holds every migration in `folder`, read the way Drizzle's migrator decides
 * what to run: one query on a connection the request has anyway, where a migration run opens a
 * direct connection of its own.
 */
export async function migrationsApplied(db: Database, folder: string): Promise<boolean> {
  try {
    const migrations = migrationsIn(folder);
    if (migrations.length === 0) return true;
    const newest = Math.max(...migrations.map((migration) => migration.folderMillis));
    const result = (await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    )) as { rows?: { created_at: unknown }[] } | { created_at: unknown }[];
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const last = rows[0]?.created_at;
    return last !== undefined && last !== null && Number(last) >= newest;
  } catch {
    return false;
  }
}
