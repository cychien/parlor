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

Better Auth options with what Parlor needs added: the base path under `/_parlor/auth`, the app's origin as a trusted origin, sessions as a cookie or, for API clients, a bearer token, OAuth for MCP clients, and host pairing for the sidebar.

```ts
import { betterAuthProvider } from "@parlor/auth";
//       ^?
```

Turns Better Auth into the provider `createServer({ auth })` takes. Pass `options`, the options for `betterAuth()`, and the provider creates the instance on the first request: Better Auth queries the database as soon as it exists, which runtimes such as Cloudflare's forbid while the app loads. Passing a ready `instance` still works on `node-server` and `bun`.

### API keys

Pass `keys` to let programs call the app with keys it issues. A `Bearer` token that starts with `keys.prefix` goes to `keys.verify(secret, request)`, before any other credential, and becomes the `key` principal it answers; `undefined` answers 401. The prefix must hold a character other than a letter or digit, such as `tly_live_`, so no session token starts with it.

```ts
import { parlorAuth } from "@parlor/auth";
const options = parlorAuth({ signInPage: "/sign-in" });
declare function findKey(
  secret: string,
): Promise<{ id: string; orgId: string; name: string; role: string } | undefined>;
// ---cut---
import { betterAuthProvider } from "@parlor/auth";
import { asId } from "@parlor/core";

export const auth = betterAuthProvider({
  options,
  keys: {
    prefix: "tly_live_",
    verify: async (secret) => {
      const key = await findKey(secret);
      return (
        key && {
          kind: "key",
          keyId: asId("key", key.id),
          scope: key.orgId,
          name: `API key "${key.name}"`,
          claims: { role: key.role },
        }
      );
    },
  },
});
```

A key reaches actions, MCP and the manifest, never sync, `/ui` or plugins, and only in its own scope. Every call with one is audited with the key's id and name. A `confirm: true` action refuses it unless the server's [confirmation policy](/parlor/reference/server/#confirmation-policy) lets it through.

## @parlor/auth/client

```ts
import { createAuthClient } from "@parlor/auth/client";
//       ^?
```

The browser client: `signIn`, `signUp`, `signOut`, and the session `FrameworkProvider` reads. The browser sends the session cookie with every action call, so the action client needs nothing from it; `headers` is deprecated and returns no headers. Errors are `AuthClientError`, with the server's `status` and `code`; a failure that never reached the server has status `0`.

| Method                                                         | What                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signIn({ email, password })`, `signUp(...)`                   | email and password                                                                                                                                                       |
| `emailOtp.send({ email })`                                     | sends a sign-in code through the `emailOTP` plugin                                                                                                                       |
| `emailOtp.signIn({ email, otp, name? })`                       | signs in with it, creating the account on first use unless the plugin disables sign-up                                                                                   |
| `social.available()`                                           | whether this browser can sign in with a provider: the `authBrowser` capability                                                                                           |
| `social.signIn({ provider, callbackURL?, errorCallbackURL? })` | a `socialProviders` or `genericOAuth` provider; see [Email codes and Google](/parlor/guides/auth/#email-codes-and-google). Codes: `UNSUPPORTED`, or the provider's error |

`createAuthClient` also takes `browser` (an `AuthBrowser`, in place of the capability) and `deviceKey` (a `DeviceKey`, in place of the capability), for tests.

## @parlor/auth/schema

The Better Auth tables for `parlorAuth()`'s defaults, so an app's `schema/auth.ts` is `export * from "@parlor/auth/schema";`. Apps that change Better Auth's options generate their own with the Better Auth CLI instead.
