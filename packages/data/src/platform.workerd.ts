import type { DatabaseHandle } from "./database.js";

/** workerd allows no I/O while the app's modules load, so migrations wait for `prepare`. */
export const migratesWhileLoading = false;

export function pgliteHandle(): Promise<DatabaseHandle> {
  return Promise.reject(
    new Error(
      "DATABASE_URL is not set. PGlite only runs in development; on Cloudflare, set DATABASE_URL to a Postgres connection string.",
    ),
  );
}
