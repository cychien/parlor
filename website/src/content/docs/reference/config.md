---
title: "@parlor/config"
description: parlor.config.ts, its fields, and @parlor/config/tsconfig.
---

```sh
pnpm add -D @parlor/config
```

```ts
import { defineConfig } from "@parlor/config";
//       ^?
```

`parlor.config.ts` default-exports `defineConfig({...})`. Every field but `app.id` and `app.name` has a default.

| Field                                              | Default                      | Meaning                                                                                                        |
| -------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `app.id`                                           | required                     | reverse DNS, such as `com.example.todos`; the installed app's manifest id and the Cloudflare Worker's name     |
| `app.name`                                         | required                     | the tab title and the installed app's name                                                                     |
| `app.description`, `app.version`                   | none, `0.1.0`                | metadata                                                                                                       |
| `server.entry`                                     | `server.ts`                  | the module that default-exports `createServer(...)`                                                            |
| `server.port`                                      | `3000`                       | the server's port in development, or the next free one                                                         |
| `server.sync.transport`                            | by preset                    | `sse` or `poll`                                                                                                |
| `server.instances`                                 | by preset                    | `one` when a single server serves the app, `many` when several may; see [Deploy](/parlor/guides/deploy/)       |
| `web.port`                                         | `5173`                       | the web app's port in development, or the next free one                                                        |
| `web.pwa`, `web.themeColor`, `web.backgroundColor` | `true`, `#ffffff`, `#ffffff` | the installable web app; its manifest takes its language from `<html lang>` in `index.html`                    |
| `web.icons`                                        | none                         | the installed app's icons: `{ src, sizes, type?, purpose? }`, files in `public/`; Android needs 192 and 512 px |
| `web.routeTree`, `web.csp`                         | `src/routeTree.gen.ts`, none | the generated route tree; extra CSP sources                                                                    |
| `web.ssr.app`                                      | none                         | the module that builds the app; renders `ssr: true` routes on the server                                       |
| `database.schema`, `database.migrations`           | `schema`, `migrations`       | where tables and migrations live                                                                               |
| `deploy.preset`                                    | detected                     | the build preset; see [Deploy](/parlor/guides/deploy/)                                                         |
| `deploy.cloudflare.locationHint`                   | from `DATABASE_URL`          | where `cloudflare-durable` starts the app's Durable Object, such as `weur`                                     |
| `deploy.cloudflare.wrangler`                       | none                         | merged into the generated wrangler config: bindings, worker name                                               |
| `deploy.cloudflare.exports`                        | none                         | a module whose named exports the Worker exports, such as Durable Objects                                       |
| `vite`                                             | none                         | Vite options merged into every build; see [Styling](/parlor/guides/styling/)                                   |

## @parlor/config/tsconfig

The strict compiler options every Parlor app uses. A project's `tsconfig.json` extends it:

```json
{
  "extends": "@parlor/config/tsconfig",
  "compilerOptions": { "noEmit": true, "types": ["node", "vite/client"] },
  "include": ["*.ts", "actions", "schema", "src"]
}
```

`loadParlorConfig`, `parseConfig`, `parlorConfigSchema` and `ConfigError` are what the CLI uses to read the file. `generatedDir(rootDir, env)` is where a run keeps its generated files: `.parlor`, or the directory `PARLOR_GENERATED_DIR` names.
