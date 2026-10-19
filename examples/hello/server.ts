import { betterAuthProvider } from "@parlor/auth";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { registry } from "./actions/index.js";
import { authOptions } from "./auth.js";
import * as schema from "./schema/index.js";

const database = await createDatabase({
  dataDir: ".parlor/pglite",
  migrationsFolder: "migrations",
});

const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter(database.db, { provider: "pg", schema }),
});

export default createServer({
  actions: registry,
  database,
  auth: betterAuthProvider({ instance: auth }),
});
