# MCP tools

Every action is an MCP tool at `/_parlor/mcp` (streamable HTTP), so an external agent such as Claude Code can greet, list, create, and toggle tasks with the same rules as the UI. Read-only actions carry `readOnlyHint: true`.

## Sub-features

- `mcp-list` lists the actions `hello`, `listTasks`, `getTask`, `createTask`, `toggleTask` with descriptions and input schemas, plus the agent UI tools covered in [Agent UI](./agent-ui.md).
- `mcp-call` calls a tool and returns the action result as text and structured content.
- `mcp-resource` lists and reads the MCP resource `parlor://manifest`, the app's pages and views with their schemas.
- `mcp-invalid` returns a tool error naming the bad field for invalid input.
- `mcp-agent` lets Claude Code headless discover and use the tools from a plain-language request.

## How to get to it (user POV)

- Add `http://localhost:<server>/_parlor/mcp` as an HTTP MCP server in an agent and ask it to manage tasks.
- Connect any MCP client to the same URL.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean (`mcp: tools ...`).
- `claude` is on PATH and logged in, for the agent steps.

- **List tools.** Run `$H mcp <id> tools > $E/tools.json`. Five action tools plus `ui_screen` and `ui_navigate`; `listTasks`, `getTask` and `hello` have `annotations.readOnlyHint: true`, `createTask` and `toggleTask` false; `createTask` requires `title`.
- **Call.** Run `$H mcp <id> call listTasks '{}'`. The text content is the three baseline tasks in order. Run `$H mcp <id> call hello '{"name":"Amy"}'`; `structuredContent.message` is `Hello, Amy!`.
- **Resources.** Run `$H mcp <id> resources`: one entry, `parlor://manifest`, `application/json`. Run `$H mcp <id> resource parlor://manifest`: `contents[0].text` is JSON with `protocol`, `app`, `routes`, `views`. `$H mcp <id> resource parlor://nope` prints `Resource not found` and exits 1.
- **Slow call in the background.** Run `$H mcp <id> call TOOL '{...}' --out $E/call.json &`, drive something else, then read `$E/call.json`: `{tool, input, startedAt, endedAt, ms, isError, result}` with epoch-millisecond timestamps, written when the call ends. The request timeout is 180 s without progress and 300 s in total, not the SDK's 60 s.
- **Invalid input.** Run `$H mcp <id> call createTask '{"title":""}'`. `isError` is true, the text names `title`, and the command exits 1. `$H sql` shows no new row.
- **Agent.** Run `$H agent <id> --out $E/agent "Using the hello MCP tools, create a task titled 'Added by Claude', then list all tasks and reply with their titles in order."`. `agent-summary.json` shows server `hello` `connected`, tool calls `mcp__hello__createTask` with `{"title":"Added by Claude"}` then `mcp__hello__listTasks`, and `isError: false`.
- **Read back.** Run `$H browser <id> wait "Added by Claude"` on an open page, or `$H mcp <id> call listTasks '{}'`. The new task is last.

## Gotchas

- The agent runs with every built-in tool removed, so it can only reach the app through MCP; a passing run cannot have used curl.
- The agent still reads the user's global CLAUDE.md, so its final text may be in another language. Assert on `toolCalls` and the stored state, not on the wording.
- Claude Code calls tools `mcp__hello__<tool>`; the raw client uses the bare name.
- `--out` takes the file path after the call arguments and applies to `mcp ID call` only; a request that fails (unknown tool, timeout) still writes the file with `isError: true` and `result: {error}`.
- Right after `$H sync <id>` the server restarts and `mcp` answers `fetch failed` for a few seconds.
- MCP connects to the server port directly, not through Vite, so it works the same for web, mac, and iOS instances.
