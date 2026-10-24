---
title: "@parlor/auth"
description: Better Auth for Parlor, its browser client and its tables.
---

```sh
pnpm parlor add auth
```

`parlor add auth` installs and wires this package; see [Auth](/parlor/guides/auth/). These are the entries it uses.

## @parlor/auth

```ts
import { parlorAuth } from "@parlor/auth";
//       ^?
```

Better Auth options with what Parlor needs added: the base path under `/_parlor/auth`, the shell origins, OAuth for MCP clients, and host pairing for the sidebar.

```ts
import { betterAuthProvider } from "@parlor/auth";
//       ^?
```

Turns Better Auth into the provider `createServer({ auth })` takes. Pass `options`, the options for `betterAuth()`, and the provider creates the instance on the first request: Better Auth queries the database as soon as it exists, which runtimes such as Cloudflare's forbid while the app loads. Passing a ready `instance` still works on `node-server` and `bun`.

## @parlor/auth/client

```ts
import { createAuthClient } from "@parlor/auth/client";
//       ^?
```

The browser client: `signIn`, `signUp`, `signOut`, `headers` for the action client, and the session `FrameworkProvider` reads. Errors are `AuthClientError`.

## @parlor/auth/schema

The Better Auth tables for `parlorAuth()`'s defaults, so an app's `schema/auth.ts` is `export * from "@parlor/auth/schema";`. Apps that change Better Auth's options generate their own with the Better Auth CLI instead.
