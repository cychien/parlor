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

Better Auth options with what Parlor needs added: the base path under `/_parlor/auth`, the shell origins, OAuth for MCP clients, host pairing for the sidebar, and social sign-in for native shells. `scheme` is the app's URL scheme that sign-in in a native shell returns to; it defaults to `PARLOR_APP_SCHEME`, which `parlor dev` and `parlor build` set from `app.scheme`.

| Route                                     | What                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_parlor/auth/native/sign-in/social` | Opened in the system's sign-in browser with `provider`, `redirect_uri` (the app's scheme), an S256 `code_challenge` and `state`. Runs Better Auth's provider sign-in, then returns to the app with `code` and `state`, or `error`, and no session in the browser |
| `POST /_parlor/auth/native/token`         | `{ code, code_verifier }` to `{ token }`, the bearer session, also in `set-auth-token`. A code works once, for one minute, and only with the verifier                                                                                                            |

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

The browser client: `signIn`, `signUp`, `signOut`, `headers` for the action client, and the session `FrameworkProvider` reads. Errors are `AuthClientError`, with the server's `status` and `code`; a failure that never reached the server has status `0`.

| Method                                                         | What                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn({ email, password })`, `signUp(...)`                   | email and password                                                                                                                                                                                                   |
| `emailOtp.send({ email })`                                     | sends a sign-in code through the `emailOTP` plugin                                                                                                                                                                   |
| `emailOtp.signIn({ email, otp, name? })`                       | signs in with it, creating the account on first use unless the plugin disables sign-up                                                                                                                               |
| `social.available()`                                           | whether this platform can sign in with a provider: the `authBrowser` capability                                                                                                                                      |
| `social.signIn({ provider, callbackURL?, errorCallbackURL? })` | a `socialProviders` or `genericOAuth` provider; see [Email codes and Google](/parlor/guides/auth/#email-codes-and-google). Codes: `CANCELLED`, `UNSUPPORTED`, `NO_SCHEME`, `STATE_MISMATCH`, or the provider's error |

`createAuthClient` also takes `browser` (an `AuthBrowser`, in place of the capability) and `scheme` (in place of `app.scheme`), for tests.

## @parlor/auth/schema

The Better Auth tables for `parlorAuth()`'s defaults, so an app's `schema/auth.ts` is `export * from "@parlor/auth/schema";`. Apps that change Better Auth's options generate their own with the Better Auth CLI instead.
