---
title: Auth
description: Add sign-in with parlor add auth, and what it changes.
---

```sh
pnpm parlor add auth
```

`parlor add auth` turns the default app into a multi-user app with email and password sign-in, built on [Better Auth](https://www.better-auth.com). It refuses to run on uncommitted changes, so its edits show up as one reviewable diff; pass `--no-git-check` to skip that.

## What it changes

| File                                   | Change                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `auth.ts`                              | New: `createAuth(database)`, the Better Auth instance behind `parlorAuth()`                    |
| `schema/auth.ts`                       | New: `export * from "@parlor/auth/schema"`, the user, session, account and verification tables |
| `src/auth/*`, `src/routes/sign-in.tsx` | New: the browser client, the sign-in gate, the sign-out button, the sign-in page               |
| `server.ts`                            | `auth: createAuth(database)` passed to `createServer`                                          |
| `src/main.tsx`                         | The action client sends the session; `FrameworkProvider` gets `auth`                           |
| `src/routes/__root.tsx`                | The layout is wrapped in `withSignIn`                                                          |
| `migrations/0001_auth.sql`             | The auth tables                                                                                |
| `.env.example`                         | `PARLOR_ORIGIN` and `BETTER_AUTH_SECRET`                                                       |

It installs `@parlor/auth` at the framework's version and `better-auth` at the version `@parlor/auth` pins. If anything fails, it restores `package.json` and the lockfile and changes no file. A second run prints `auth is already added. Nothing changed.`

When it cannot edit a file safely, for example a `server.ts` that builds its options elsewhere, it changes nothing and prints the exact code to add by hand. Make that change and run the command again.

## After sign-in

- Each user has their own scope, so every action that filters by `ctx.scope` shows each user only their rows. Rows created before sign-in belong to the scope `"default"`, which no signed-in user sees.
- The sidebar connects each user's own computer: it shows `npx @parlor/agent-host connect <app url>`, which pairs that computer with the signed-in account after one approval in the browser, and trusts that browser. Every other browser or phone links once: it shows a QR code and a short code. A linked phone scans the QR with its camera, which opens the app's `/link` page, or a linked device types the code under **Link a device**; either way it confirms with Face ID or Touch ID. The computer can also accept it with `npx @parlor/agent-host link`. Whenever another device links one, the linked devices show it with a **Remove** button and the computer posts a notification. **Devices** in the sidebar lists the account's devices; removing one takes Face ID or Touch ID on a linked device, and on the computer `npx @parlor/agent-host devices <app url>` lists them and `--remove <id>` unlinks one. The code is a hash of the new device's keys, so neither a stolen password nor the app's own server can link a device, and the computer never asks on its own.
- A linked device with Face ID or Touch ID confirms it is still the user's every 18 hours: once that long has passed since its last check, the composer says "Sending will ask for Face ID or Touch ID", and the next message asks for it. A phone left unlocked on a desk stops working for a thief by the next day. The computer enforces it, whatever the app says, and sets the interval with `npx @parlor/agent-host config --prompt-presence <hours>`, or turns it off with `--prompt-presence off`. A browser on the computer itself, which has no passkey, is never asked.
- MCP clients sign in through OAuth. See [Agents](/parlor/guides/agents/).

## Production

Set two environment variables on the server:

- `PARLOR_ORIGIN`: the public origin the app is served from, such as `https://todos.example.com`.
- `BETTER_AUTH_SECRET`: a random secret that signs sessions. Generate one with `openssl rand -base64 32`.

## Sign-in in one step

`pnpm create parlor my-app --add auth` creates the app with sign-in already added.
