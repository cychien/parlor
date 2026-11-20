---
title: Deploy
description: Build the server and the web app for production.
---

```sh
pnpm build
```

`parlor build` writes the web app and a server that serves it, the actions and MCP, in one output. It runs on [Nitro](https://nitro.build). Deploy it as one long-lived server: `node-server`, `bun`, or [Cloudflare](#cloudflare) with `cloudflare-durable`. For an app many unrelated accounts use at once, [`cloudflare-scaled`](#cloudflare-at-scale) spreads it over Cloudflare. Other serverless platforms are [not supported yet](#serverless-is-not-supported-yet).

## Presets

| Preset                                                                | Where                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `node-server`                                                         | any machine with Node.js; the default                    |
| `bun`                                                                 | a Bun server                                             |
| `cloudflare-durable`                                                  | Cloudflare Workers, with the server in a Durable Object  |
| `cloudflare-scaled`                                                   | Cloudflare Workers, with a Durable Object per account    |
| `vercel`, `netlify`, `cloudflare-module`, `aws-lambda`, `deno-deploy` | not supported yet; `parlor build` warns when you use one |

Pick one with `parlor build --preset vercel`, or `deploy.preset` in `parlor.config.ts`. On Vercel, Netlify and Cloudflare Pages the preset is detected from the build environment. `parlor deploy` builds and runs the platform's deploy.

For `node-server`, `parlor build` prints where it wrote the server; start it with `node <that folder>/server/index.mjs`.

With [`web.ssr`](/parlor/guides/server-rendering/), `parlor build` also builds the server render, and the server renders opted-in pages: in process on `node-server` and `bun`, and in the Worker on `cloudflare-durable`.

## Cloudflare

`cloudflare-durable` builds a Worker that serves the web app's files and its pages' documents and hands every other request to one Durable Object, which runs the server exactly as `node-server` does: one instance, holding each open page's stream, the agent's screen tools, approvals and streamed replies.

Set `deploy.preset` to `cloudflare-durable` in `parlor.config.ts`, then build and deploy with Wrangler:

```sh
pnpm parlor deploy
```

- Set `DATABASE_URL` as a secret: any PostgreSQL that accepts connections from Cloudflare, such as Neon. If it is a pooled endpoint, also set `DATABASE_DIRECT_URL` to the direct one, which migrations use.
- The Durable Object is the app's one server, so it holds no database connection open while nothing happens. Live updates travel inside it, and an open page or a connected computer sends the database nothing until someone does something, so a serverless PostgreSQL can scale to zero in between.
- Pages and computers keep their live connection as a WebSocket the Durable Object holds while it hibernates. Their pings are answered without waking it, so an idle app is not billed for the object's time either. A computer is online while its socket is; one that goes silent is let go about two minutes later. An older client or Parlor Host, or a page where WebSocket is unavailable, falls back to a server-sent stream, which keeps the object awake while it is open; keep Parlor Host updated on the computers you connect.
- The migrations are embedded in the build and run before the server's first request.
- The Durable Object starts beside the database: Parlor reads the region from `DATABASE_URL`'s host (Neon, Supabase, RDS and other cloud hosts name it). For a host that names none, set `deploy.cloudflare.locationHint` in `parlor.config.ts`. Add the app's own bindings, such as R2, under `deploy.cloudflare.wrangler`.
- Wrangler applies Durable Object migrations in order, after the last one a deployment applied. Without migrations of its own, the app gets Parlor's `{ tag: "parlor-server-v1", new_sqlite_classes: ["ParlorServer"] }` at the end of the list; once it lists its own, include that entry where it was first deployed.
- Nothing may do I/O, set a timer or draw random values while `server.ts` loads: workerd forbids it. `createDatabase` and `betterAuthProvider({ options })` wait for the first request; a plugin starts its timers in `start()`.
- With [server rendering](/parlor/guides/server-rendering/), the Worker renders pages itself. Their loaders reach the actions in the Durable Object, so the Worker holds no database connection. The same rule holds for the app's modules a page imports.

### Bindings

Declare the app's bindings under `deploy.cloudflare.wrangler` and read them from `cloudflare:workers` in server code. Text vars and secrets are in `process.env` as well, so config read from `process.env` works unchanged.

```ts
import { defineConfig } from "@parlor/config";

export default defineConfig({
  app: { id: "com.example.media", name: "Media" },
  deploy: {
    preset: "cloudflare-durable",
    cloudflare: {
      wrangler: {
        r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
        vars: { REGION: "eu" },
      },
    },
  },
});
```

```ts
// @filename: cloudflare.d.ts
declare module "cloudflare:workers" {
  export const env: { MEDIA: { put(key: string, value: string): Promise<unknown> } };
}
// @filename: actions/save-note.ts
// ---cut---
import { defineAction } from "@parlor/core";
import { env } from "cloudflare:workers";
import { z } from "zod";

export const saveNote = defineAction({
  description: "Save a note to the media bucket.",
  input: z.object({ key: z.string(), text: z.string() }),
  run: async ({ key, text }) => {
    await env.MEDIA.put(key, text);
    return { key, region: process.env.REGION };
  },
});
```

For the app's own Durable Object classes, point `deploy.cloudflare.exports` at a module, such as `"worker.ts"`, whose named exports the Worker exports too, and bind them by `class_name` with a migration under `deploy.cloudflare.wrangler`. The Worker evaluates that module at startup, so it may not do I/O, set a timer or draw random values while it loads.

### In development

With `cloudflare-durable`, `parlor dev` runs the server on Node with the same bindings: `env` from `cloudflare:workers` comes from Wrangler's `getPlatformProxy()`, which emulates R2, KV, D1, `send_email` and the other bindings it supports locally and keeps their data in `.parlor/cloudflare/state`. Add `wrangler` to the app's devDependencies.

- Vars and secrets come from `deploy.cloudflare.wrangler.vars` and `.dev.vars` in the project root, or `.env` and `.env.local` when there is no `.dev.vars`, as Wrangler reads them. Their text values are in `process.env` too, where a variable already set in the shell wins. Restart `parlor dev` after changing them.
- `cloudflare:workers` exports `env` and `DurableObject` in development, so a module that defines a Durable Object class still loads.
- A Durable Object class the app's own Worker defines is not available: `getPlatformProxy()` runs no Worker code, so reading its binding from `env` throws an error that says so. Run the build on `wrangler dev` to use it.
- In Vitest, mock the module: `vi.mock("cloudflare:workers", () => ({ env: { ... } }))`.

## Cloudflare at scale

`cloudflare-durable` runs the whole app in one Durable Object, which is simplest and fast for one organization's app, and is also a ceiling: every request of every account goes through one object. `cloudflare-scaled` splits the app:

- **The Worker** serves the web app, documents, actions, plugin routes and sign-in, statelessly, so it runs wherever Cloudflare has capacity. Each request opens its own database connection: through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) when the Worker has a binding named `HYPERDRIVE`, directly otherwise, with [Smart Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/) running the Worker near the database.
- **A Durable Object per account** (`ParlorAccount`) holds that account's live connections, as WebSockets it keeps while it hibernates, the agent's view of its screens, MCP sessions, approvals and the chat with its computers. Plugins that keep state in memory, `realtime: true` such as chat, run there too.
- **A Durable Object per topic** (`ParlorTopic`) carries a write to the accounts that need it: an account's object listens to the scopes its open pages read, and a write in a scope reaches only the accounts listening to it. An idle page still costs the database nothing.

To use it:

- Build the server from a function, so each account's object builds its own auth and plugins: `export default createServer(() => ({ actions, database, auth, plugins }))`. Keep `createDatabase` and options such as `parlorAuth(...)` outside the function, as before.
- Set `deploy.preset` to `cloudflare-scaled`. Wrangler gets `{ tag: "parlor-scaled-v1", new_sqlite_classes: ["ParlorAccount", "ParlorTopic"] }` at the end of the app's migrations, as with `cloudflare-durable`. Without migrations of its own, the app keeps `parlor-server-v1` first, so a deployment that ran `cloudflare-durable` finds the tag it applied.
- A plugin's `start()` runs only in the accounts' objects; the Worker calls a plugin's `settle()` after each request, so work held for later, such as a batch of audit records, is written before the request ends.
- Moving an app from `cloudflare-durable` adds the new classes and deletes `ParlorServer` in the same migration; it kept nothing in its storage. Open pages reconnect on the deploy, as on any deploy.

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

When one instance is all you run, say so: `server.instances: "one"` in `parlor.config.ts`, or `PARLOR_INSTANCES=one` in its environment. The server then keeps live updates and each computer's liveness in its own memory instead of holding a LISTEN connection and renewing leases, and sends an idle database nothing. `cloudflare-durable` is always one. Leave it unset when several instances share the database: they hear each other only through it.

## Environment

| Variable              | When                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | always in production: a PostgreSQL connection string                                        |
| `DATABASE_DIRECT_URL` | when `DATABASE_URL` goes through a pooler: the direct connection, for LISTEN and migrations |
| `PARLOR_ORIGIN`       | with sign-in: the public origin                                                             |
| `PARLOR_INSTANCES`    | `one` when this server is the app's only one, unless `server.instances` or the preset said  |
| `BETTER_AUTH_SECRET`  | with sign-in: the session signing secret                                                    |

Migrations run when the server starts.

## The agent sidebar in production

The sidebar needs sign-in in production, because each user connects their own computer to their own account. Without `parlor add auth`, `parlor build` prints a warning and the sidebar shows that the agent is unavailable; the rest of the app works.
