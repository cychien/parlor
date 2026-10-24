---
title: Deploy
description: Build the server and the web app for production.
---

```sh
pnpm build
```

`parlor build` writes the web app and a server that serves it, the actions and MCP, in one output. It runs on [Nitro](https://nitro.build). Deploy it as one long-lived server, `node-server` or `bun`; serverless platforms are [not supported yet](#serverless-is-not-supported-yet).

## Presets

| Preset                                                                | Where                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `node-server`                                                         | any machine with Node.js; the default                    |
| `bun`                                                                 | a Bun server                                             |
| `vercel`, `netlify`, `cloudflare-module`, `aws-lambda`, `deno-deploy` | not supported yet; `parlor build` warns when you use one |

Pick one with `parlor build --preset vercel`, or `deploy.preset` in `parlor.config.ts`. On Vercel, Netlify and Cloudflare Pages the preset is detected from the build environment. `parlor deploy` builds and runs the platform's deploy.

For `node-server`, `parlor build` prints where it wrote the server; start it with `node <that folder>/server/index.mjs`.

## Serverless is not supported yet

Parlor's agent features need a server that holds a connection to each open page. Serverless functions cannot, so on those presets the parts that make the app agent-operable stop working:

| Feature                                            | One `node-server` or `bun` | Serverless                     |
| -------------------------------------------------- | -------------------------- | ------------------------------ |
| Pages, actions, data, MCP tools for actions        | works                      | works                          |
| Pages refreshing when data changes                 | instantly, over a stream   | by polling every few seconds   |
| Agents reading and using the screen (`ui_*` tools) | works                      | always "the app is not open"   |
| `confirm: true` actions called by an agent         | ask the user in the app    | always fail, without running   |
| The agent sidebar's replies                        | stream as they are written | appear whole, up to ~17 s late |

Run one instance. Several `node-server` instances behind a load balancer share data and live updates, but the screen tools, approvals and reply streaming only reach pages connected to the same instance.

## Environment

| Variable             | When                                                 |
| -------------------- | ---------------------------------------------------- |
| `DATABASE_URL`       | always in production: a PostgreSQL connection string |
| `PARLOR_ORIGIN`      | with sign-in: the public origin                      |
| `BETTER_AUTH_SECRET` | with sign-in: the session signing secret             |

Migrations run when the server starts.

## The agent sidebar in production

The sidebar needs sign-in in production, because each user connects their own computer to their own account. Without `parlor add auth`, `parlor build` prints a warning and the sidebar shows that the agent is unavailable; the rest of the app works.
