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

| Option | Meaning |
| --- | --- |
| `actions` | the registry from `createRegistry` |
| `database` | the handle from `createDatabase`; needed for sync and for plugins with tables |
| `auth` | an auth provider, such as the one `parlor add auth` writes. Leave the key out to run without sign-in; a key whose value is `undefined` is a startup error when `chat()` is installed |
| `plugins` | framework features with their own routes and tables, such as `chat()` from `@parlor/chat/server` |
| `scope` | how a caller maps to a scope; the default is the user's id, or `"default"` |
| `basePath` | where the framework routes live; `/_parlor` |
| `cors`, `mcp`, `sync`, `agentUi` | options of those surfaces |

## Routes it serves

| Path | What |
| --- | --- |
| `POST /_parlor/actions/<name>` | an action over HTTP |
| `/_parlor/mcp` | every action as an MCP tool (streamable HTTP) |
| `GET /_parlor/manifest` | the actions and their schemas |
| `/_parlor/sync/*` | the live-update channel |
| `/.well-known/oauth-*` | OAuth discovery, with an auth provider |

## For plugin authors

`pluginRoute`, the `ServerPlugin` and `PluginHost` types, `AuthFailure`, `requireAccess` and `requireSurface` build a plugin like `chat()`. `devAuth()` is the provider `parlor dev` installs when the app has none.
