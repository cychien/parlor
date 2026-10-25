---
title: "@parlor/server"
description: createServer and the HTTP, MCP and sync surfaces it serves.
---

```sh
pnpm add @parlor/server
```

```ts
import { createServer } from "@parlor/server";
//       ^?
```

`createServer` returns a server with a web-standard `fetch(request)` and `close()`. `server.ts` default-exports it; `parlor dev` serves it with srvx and `parlor build` wraps it for every deploy preset.

| Option                           | Meaning                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions`                        | the registry from `createRegistry`                                                                                                                                                   |
| `database`                       | the handle from `createDatabase`; needed for sync and for plugins with tables                                                                                                        |
| `auth`                           | an auth provider, such as the one `parlor add auth` writes. Leave the key out to run without sign-in; a key whose value is `undefined` is a startup error when `chat()` is installed |
| `plugins`                        | framework features with their own routes and tables, such as `chat()` from `@parlor/chat/server`                                                                                     |
| `scope`                          | how a caller maps to a scope; the default is the user's id, or `"default"`                                                                                                           |
| `basePath`                       | where the framework routes live; `/_parlor`                                                                                                                                          |
| `cors`, `mcp`, `sync`, `agentUi` | options of those surfaces                                                                                                                                                            |

## Routes it serves

| Path                           | What                                          |
| ------------------------------ | --------------------------------------------- |
| `POST /_parlor/actions/<name>` | an action over HTTP                           |
| `/_parlor/mcp`                 | every action as an MCP tool (streamable HTTP) |
| `GET /_parlor/manifest`        | the actions and their schemas                 |
| `/_parlor/sync/*`              | the live-update channel                       |
| `/.well-known/oauth-*`         | OAuth discovery, with an auth provider        |
| `/_parlor/<plugin>/*`          | each plugin's routes                          |

## For plugin authors

`pluginRoute`, the `ServerPlugin` and `PluginHost` types, `AuthFailure`, `requireAccess` and `requireSurface` build a plugin like `chat()`. `devAuth()` is the provider `parlor dev` installs when the app has none.

A plugin route is served under `/_parlor/<plugin>/`. Set `absolute: true` on it to serve its `path` from the origin root instead, for a URL fixed outside the app, such as a payment provider's webhook or return URL. The path must be static. `createServer` refuses one under `basePath` and one that another route already serves, and the server refuses to start when a page route also matches an absolute `GET` route's path.

In `parlor dev` and in every build, a request is answered by the first of:

1. a static file of the web app
2. the app's document, for a browser's `GET` to a path a page route matches
3. the server
4. the app's document, for a browser's `GET` no server route matches, so the page shows its not-found view

The app's content security policy goes on its documents and static files. Responses from the server, absolute routes included, keep their own headers.

A plugin's `setup` runs while the app loads, where some runtimes, such as Cloudflare's, allow no I/O and no timers. Start background work, such as an interval, in the runtime's `start()`, which the server calls once when it is ready for its first request.

A plugin's runtime may return `allows(caller)`, sync or async, to decide who may use it from the caller's `principal` and `scope`. The server answers everyone it refuses with `forbidden` on the plugin's actions (audited as a refusal) and on its signed-in routes, and keeps them off its channel; public routes are not asked. A plugin that serves another one asks through `PluginHost.allows(name, caller)`, which is true when that plugin is not installed or sets no policy; `@parlor/auth` does so before pairing a computer for `chat()`.
