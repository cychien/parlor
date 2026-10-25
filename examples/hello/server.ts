import { betterAuthProvider } from "@parlor/auth";
import { chat } from "@parlor/chat/server";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { registry } from "./actions/index.js";
import { authOptions } from "./auth.js";
import * as schema from "./schema/index.js";

const database = await createDatabase({
  dataDir: ".parlor/pglite",
  migrationsFolder: "migrations",
});

export default createServer({
  actions: registry,
  database,
  auth: betterAuthProvider({
    options: {
      ...authOptions,
      database: drizzleAdapter(database.db, { provider: "pg", schema }),
    },
  }),
  plugins: [chat()],
});
