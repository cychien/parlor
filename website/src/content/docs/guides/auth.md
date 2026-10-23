---
title: Auth
description: Add sign-in with parlor add auth, and what it changes.
---

```sh
pnpm parlor add auth
```

`parlor add auth` turns the default app into a multi-user app with email and password sign-in, built on [Better Auth](https://www.better-auth.com). It refuses to run on uncommitted changes, so its edits show up as one reviewable diff; pass `--no-git-check` to skip that.

## What it changes

| File | Change |
| --- | --- |
| `auth.ts` | New: `createAuth(database)`, the Better Auth instance behind `parlorAuth()` |
| `schema/auth.ts` | New: `export * from "@parlor/auth/schema"`, the user, session, account and verification tables |
| `src/auth/*`, `src/routes/sign-in.tsx` | New: the browser client, the sign-in gate, the sign-out button, the sign-in page |
| `server.ts` | `auth: createAuth(database)` passed to `createServer` |
| `src/main.tsx` | The action client sends the session; `FrameworkProvider` gets `auth` |
| `src/routes/__root.tsx` | The layout is wrapped in `withSignIn` |
| `migrations/0001_auth.sql` | The auth tables |
| `.env.example` | `PARLOR_ORIGIN` and `BETTER_AUTH_SECRET` |

It installs `@parlor/auth` at the framework's version and `better-auth` at the version `@parlor/auth` pins. If anything fails, it restores `package.json` and the lockfile and changes no file. A second run prints `auth is already added. Nothing changed.`

When it cannot edit a file safely, for example a `server.ts` that builds its options elsewhere, it changes nothing and prints the exact code to add by hand. Make that change and run the command again.

## After sign-in

- Each user has their own scope, so every action that filters by `ctx.scope` shows each user only their rows. Rows created before sign-in belong to the scope `"default"`, which no signed-in user sees.
- The sidebar connects each user's own computer: it shows `npx @parlor/agent-host connect <app url>`, which pairs that computer with the signed-in account.
- MCP clients sign in through OAuth. See [Agents](/guides/agents/).

## Production

Set two environment variables on the server:

- `PARLOR_ORIGIN`: the public origin the app is served from, such as `https://todos.example.com`.
- `BETTER_AUTH_SECRET`: a random secret that signs sessions. Generate one with `openssl rand -base64 32`.

## Sign-in in one step

`pnpm create parlor my-app --add auth` creates the app with sign-in already added.
