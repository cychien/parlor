---
title: Deploy
description: Build the server and the web app for production.
---

```sh
pnpm build
```

`parlor build` writes the web app and a server that serves it, the actions and MCP, in one output. It runs on [Nitro](https://nitro.build), so the same app deploys to a Node server or a serverless platform.

## Presets

| Preset | Where |
| --- | --- |
| `node-server` | any machine with Node.js; the default |
| `bun` | a Bun server |
| `vercel`, `netlify`, `cloudflare-module`, `aws-lambda`, `deno-deploy` | those platforms |

Pick one with `parlor build --preset vercel`, or `deploy.preset` in `parlor.config.ts`. On Vercel, Netlify and Cloudflare Pages the preset is detected from the build environment. `parlor deploy` builds and runs the platform's deploy.

For `node-server`, `parlor build` prints where it wrote the server; start it with `node <that folder>/server/index.mjs`.

## Live updates on serverless

Pages refresh when data changes through a sync channel. On long-lived servers (`node-server`, `bun`) it is a server-sent event stream. Serverless functions cannot hold a stream, so those presets poll instead. The choice is made at build time; the app code is the same.

## Environment

| Variable | When |
| --- | --- |
| `DATABASE_URL` | always in production: a PostgreSQL connection string |
| `PARLOR_ORIGIN` | with sign-in: the public origin |
| `BETTER_AUTH_SECRET` | with sign-in: the session signing secret |

Migrations run when the server starts.

## The agent sidebar in production

The sidebar needs sign-in in production, because each user connects their own computer to their own account. Without `parlor add auth`, `parlor build` prints a warning and the sidebar shows that the agent is unavailable; the rest of the app works.
