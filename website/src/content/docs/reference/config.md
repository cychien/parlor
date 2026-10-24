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

| Field                                                  | Default                      | Meaning                                                                      |
| ------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| `app.id`                                               | required                     | reverse DNS, such as `com.example.todos`; the bundle id of native builds     |
| `app.name`                                             | required                     | the window and tab title                                                     |
| `app.description`, `app.version`, `app.scheme`         | none, `0.1.0`, none          | metadata; `scheme` is the deep-link URL scheme                               |
| `server.entry`                                         | `server.ts`                  | the module that default-exports `createServer(...)`                          |
| `server.port`                                          | `3000`                       | the server's port in development, or the next free one                       |
| `server.url`                                           | none                         | the public server origin native shells call                                  |
| `server.sync.transport`                                | by preset                    | `sse` or `poll`                                                              |
| `web.port`                                             | `5173`                       | the web app's port in development, or the next free one                      |
| `web.pwa`, `web.themeColor`, `web.backgroundColor`     | `true`, `#ffffff`, `#ffffff` | the installable web app                                                      |
| `web.routeTree`, `web.csp`                             | `src/routeTree.gen.ts`, none | the generated route tree; extra CSP sources                                  |
| `desktop.width`, `desktop.height`, `desktop.agentHost` | `1024`, `768`, none          | the desktop window; bundle Parlor Host                                       |
| `database.schema`, `database.migrations`               | `schema`, `migrations`       | where tables and migrations live                                             |
| `deploy.preset`                                        | detected                     | the build preset; see [Deploy](/parlor/guides/deploy/)                       |
| `deploy.cloudflare.locationHint`                       | none                         | where `cloudflare-durable` starts the app's Durable Object, such as `weur`   |
| `deploy.cloudflare.wrangler`                           | none                         | merged into the generated wrangler config: bindings, worker name             |
| `vite`                                                 | none                         | Vite options merged into every build; see [Styling](/parlor/guides/styling/) |

## @parlor/config/tsconfig

The strict compiler options every Parlor app uses. A project's `tsconfig.json` extends it:

```json
{
  "extends": "@parlor/config/tsconfig",
  "compilerOptions": { "noEmit": true, "types": ["node", "vite/client"] },
  "include": ["*.ts", "actions", "schema", "src"]
}
```

`loadParlorConfig`, `parseConfig`, `parlorConfigSchema` and `ConfigError` are what the CLI uses to read the file.
