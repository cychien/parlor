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
- The sidebar connects each user's own computer: it shows `npx @parlor/agent-host connect <app url>`, which pairs that computer with the signed-in account after one approval in the browser, and trusts that browser: it lands on a page that says the computer is connected, and a sidebar already open in another tab of it can send right away. The same approval, unless the user unticks it, lets Claude Code and Codex on that computer use the app outside the sidebar; see [Agents](/parlor/guides/agents/#from-a-connected-computer-without-any-setup). Every other browser or phone links once: it shows a QR code and a short code. A linked phone scans the QR with its camera, which opens the app's `/link` page, or a linked device types the code under **Link a device**; either way it confirms with Face ID or Touch ID. The computer can also accept it with `npx @parlor/agent-host link`. Whenever another device links one, the linked devices show it with a **Remove** button and the computer posts a notification. **Devices** in the sidebar lists the account's devices; removing one takes Face ID or Touch ID on a linked device, and on the computer `npx @parlor/agent-host devices <app url>` lists them and `--remove <id>` unlinks one. The code is a hash of the new device's keys, so neither a stolen password nor the app's own server can link a device, and the computer never asks on its own.
- A linked device with Face ID or Touch ID confirms it is still the user's every 18 hours: once that long has passed since its last check, the composer says "Sending will ask for Face ID or Touch ID", and the next message asks for it. A phone left unlocked on a desk stops working for a thief by the next day. The computer enforces it, whatever the app says, and sets the interval with `npx @parlor/agent-host config --prompt-presence <hours>`, or turns it off with `--prompt-presence off`. A browser on the computer itself, which has no passkey, is never asked.
- A turn from the app runs in the agent's own safety review where it has one, Claude Code's Auto mode or Codex's Auto review: the agent acts on its own and asks only for what that review flags. An agent without one asks before every action. `npx @parlor/agent-host config --agent-mode ask` makes every agent ask before every action.
- The agent's own permission prompts, such as running a command or writing a file, are answered in the sidebar with Face ID or Touch ID. The browser that approved `connect` answers its own conversation's prompts in the sidebar without them, since it is on the computer; any other device without Face ID or Touch ID leaves them to a dialog on the computer. `npx @parlor/agent-host config --answers computer` sends every prompt to that dialog.
- The computer that runs the agents must be a Mac for now: `npx @parlor/agent-host connect` refuses on Windows and Linux before it pairs, because Parlor Host keeps its keys in the macOS Keychain. `parlor dev` works on every platform, and the app itself, with its sidebar, runs in any browser and on iPhone.
- MCP clients sign in through OAuth. See [Agents](/parlor/guides/agents/).

## Email codes and Google

`parlor add auth` signs in with a password. To sign in with a code sent by email, or with Google, add Better Auth's `emailOTP` plugin and `socialProviders` in `auth.ts` and turn passwords off:

```ts
import { parlorAuth } from "@parlor/auth";
import { emailOTP } from "better-auth/plugins";

declare function sendEmail(to: string, text: string): Promise<void>;

export const authOptions = parlorAuth({
  appName: "Courses",
  signInPage: "/sign-in",
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  plugins: [
    emailOTP({
      sendVerificationOTP: ({ email, otp }) => sendEmail(email, `Your code is ${otp}`),
    }),
  ],
});
```

The sign-in page calls the auth client:

```ts
import { createAuthClient } from "@parlor/auth/client";

const auth = createAuthClient();

await auth.emailOtp.send({ email: "ada@example.com" });
await auth.emailOtp.signIn({ email: "ada@example.com", otp: "123456" });

if (await auth.social.available()) {
  await auth.social.signIn({ provider: "google", callbackURL: "/" });
}
```

Both work the same in a browser and in the desktop and iPhone apps, where the session is a bearer token in the Keychain like a password sign-in's.

- **On the web**, `social.signIn` sends the page to Google, which returns to `callbackURL` signed in, so the promise never resolves. A failure returns to the sign-in page with `?error=`. A sign-in page opened by an MCP client's authorization (its URL carries `sig`) resumes that authorization after Google, as it does after a password.
- **In the desktop and iPhone apps**, Google refuses the app's own webview, so `social.signIn` opens it in the system's sign-in browser (ASWebAuthenticationSession), which returns to the app through `app.scheme`. The promise resolves once the app is signed in, on the page that called it; navigate from there. Closing the browser throws `AuthClientError` with code `CANCELLED`. The system browser never keeps the session: the server hands the app a single-use code that expires after a minute, which only the app that started the sign-in can redeem, because it holds the PKCE verifier. `app.scheme` must be set in `parlor.config.ts`.
- `social.available()` is false where the app has no sign-in browser, such as Android for now; hide the button there.

In the Google Cloud console, create an OAuth client of type Web application with the redirect URI `https://<your origin>/_parlor/auth/callback/google`. The same client serves the web and the apps. Other providers in `socialProviders`, and `genericOAuth` providers, work the same way.

## Production

Set two environment variables on the server:

- `PARLOR_ORIGIN`: the public origin the app is served from, such as `https://todos.example.com`.
- `BETTER_AUTH_SECRET`: a random secret that signs sessions. Generate one with `openssl rand -base64 32`.

## Sign-in in one step

`pnpm create parlor my-app --add auth` creates the app with sign-in already added.
