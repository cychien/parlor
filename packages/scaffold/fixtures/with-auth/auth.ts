import { betterAuthProvider, parlorAuth } from "@parlor/auth";
import type { DatabaseHandle } from "@parlor/data";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import * as schema from "./schema/index.js";

export function createAuth(database: DatabaseHandle) {
  const options = parlorAuth({
    appName: process.env.PARLOR_APP_NAME ?? "Parlor App",
    signInPage: "/sign-in",
    emailAndPassword: { enabled: true },
  });
  return betterAuthProvider({
    options: {
      ...options,
      database: drizzleAdapter(database.db, { provider: "pg", schema }),
    },
  });
}
