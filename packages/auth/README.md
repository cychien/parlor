# @parlor/auth

Sign-in for Parlor apps on Better Auth: sessions, per-user scopes, OAuth for MCP clients, and pairing a computer's agents with an account.

```sh
pnpm parlor add auth
```

`parlor add auth` installs this package and writes the wiring. The server side it writes:

```ts
import { betterAuthProvider, parlorAuth } from "@parlor/auth";
import { betterAuth } from "better-auth";

export const auth = betterAuthProvider({
  instance: betterAuth(
    parlorAuth({
      appName: "Todos",
      signInPage: "/sign-in",
      emailAndPassword: { enabled: true },
    }),
  ),
});
```

Docs: https://cychien.github.io/parlor/guides/auth/
