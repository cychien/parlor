import { type DatabaseHandle, unconfiguredHandle } from "./database.js";

/** workerd allows no I/O while the app's modules load, so migrations wait for `prepare`. */
export const migratesWhileLoading = false;

/** No PGlite on Cloudflare: without DATABASE_URL the app still loads, and says so on use. */
export function pgliteHandle(): Promise<DatabaseHandle> {
  return Promise.resolve(
    unconfiguredHandle(
      new Error(
        "DATABASE_URL is not set. PGlite only runs in development; on Cloudflare, set DATABASE_URL to a Postgres connection string.",
      ),
    ),
  );
}
