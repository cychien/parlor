import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type Database = PgDatabase<PgQueryResultHKT>;

/** node-postgres and PGlite both answer `execute` with `{ rows }`; drizzle's proxy with an array. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** A jsonb column arrives parsed from node-postgres and PGlite, as text from other drivers. */
export function jwkOf(value: JsonWebKey | string): JsonWebKey {
  return typeof value === "string" ? (JSON.parse(value) as JsonWebKey) : value;
}
