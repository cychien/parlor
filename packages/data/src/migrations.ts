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
