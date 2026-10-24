# Agents

Every action is also an MCP tool. The server speaks MCP over streamable HTTP at `/_parlor/mcp`, next to the actions, so any MCP client can use the app the way the UI does.

## Connect Claude Code

With `pnpm dev` running:

```sh
claude mcp add --transport http my-app http://localhost:5173/_parlor/mcp
```

Then ask Claude Code to "list my todos" or "add a todo called Ship it". Each tool is an action: its name, its `description` and its input schema come from `defineAction`.

Without sign-in, MCP calls run in the scope `"default"`, the same rows the UI shows. After `parlor add auth`, the server is an OAuth authorization server: an MCP client discovers it through `/.well-known/oauth-protected-resource`, opens the app's sign-in page, and every call then runs as that user, in that user's scope. Claude Code runs this flow itself (`claude mcp login my-app`).

## Several apps in one agent

A user may connect one agent to many Parlor apps, and to the same app twice, in production and on `localhost`. Each server introduces itself: its MCP server name and title are the app's `app.name`, and its instructions begin with which app the tools belong to, at which origin, with `app.description` when the config has one:

> These tools belong to Course Admin at https://courses.example.com. Courses, lessons and their copy. They act only on Course Admin, as the signed-in user; any other app's tools are a separate server.

The origin is `PARLOR_ORIGIN` in production, the web origin under `parlor dev`. Give the connection a clear name too (`claude mcp add --transport http course-admin …`), so "put this copy into Course Admin's React course" leaves the agent no doubt.

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
