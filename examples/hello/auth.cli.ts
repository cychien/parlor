// Read by `pnpm auth:generate`: the Better Auth CLI takes the tables from this instance and never opens the database.
import { betterAuth } from "better-auth";

import { authOptions } from "./auth.js";

export const auth = betterAuth(authOptions);
