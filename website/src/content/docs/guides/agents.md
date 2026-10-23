---
title: Agents
description: Let external agents such as Claude Code use the app over MCP.
---

Every action is also an MCP tool. The server speaks MCP over streamable HTTP at `/_parlor/mcp`, next to the actions, so any MCP client can use the app the way the UI does.

## Connect Claude Code

With `pnpm dev` running:

```sh
claude mcp add --transport http my-app http://localhost:5173/_parlor/mcp
```

Then ask Claude Code to "list my todos" or "add a todo called Ship it". Each tool is an action: its name, its `description` and its input schema come from `defineAction`.

Without sign-in, MCP calls run in the scope `"default"`, the same rows the UI shows. After `parlor add auth`, the server is an OAuth authorization server: an MCP client discovers it through `/.well-known/oauth-protected-resource`, opens the app's sign-in page, and every call then runs as that user, in that user's scope. Claude Code runs this flow itself (`claude mcp login my-app`).

## What agents can and cannot do

- An agent calls exactly the actions the app defines, with the same validation as the UI.
- An action marked `confirm: true` waits until a person approves the call in the app.
- `ctx.source` is `"mcp"` for an external agent and `"agent"` for the sidebar's agent, so an action can tell who is calling.

## Plain HTTP

The same actions answer `POST /_parlor/actions/<name>` with a JSON body:

```sh
curl -X POST http://localhost:5173/_parlor/actions/listTodos \
  -H 'content-type: application/json' -d '{}'
```

The response is `{ "data": ..., "tags": [...] }`, or `{ "error": { "code", "message" } }` with a matching HTTP status.
