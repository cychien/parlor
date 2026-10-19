# Accounts

Hello has accounts. A signed-out visitor lands on a sign-in page; once signed in, each person sees only their own tasks, on every surface: the page, other windows, MCP, and plain HTTP. Settings lists where the account is signed in and which agents it connected, and either can be cut off from there. An MCP client such as Claude Code connects through OAuth: the person signs in, sees a consent page naming the agent, and allows or denies it.

## Sub-features

- `sign-in` sends a signed-out visitor to `/sign-in`, shows a wrong password as an error, and opens the task list after signing in.
- `isolation` keeps Bob from reading, changing, or hearing about Alice's tasks through actions, MCP, and sync.
- `sign-out-device` signs another place out from settings; its open connection closes within 5 s and its next request answers 401.
- `oauth-connect` lets Claude Code authorize through the consent page and act as the person who allowed it.
- `oauth-deny` returns `access_denied` to the agent when the person clicks Deny.
- `revoke-agent` revokes a connected agent from settings; its token stops working at once.
- `mac-sign-in` signs in inside the Mac app, which carries the session as a bearer token, and follows live updates.

## How to get to it (user POV)

- Open the app while signed out, or click `Sign out` in the top bar.
- Settings, section Account: "Where you're signed in" with a `Sign out` button per other place, "Connected agents" with a `Revoke` button per agent.
- An MCP client opens the consent page itself when it authorizes; it shows the agent's name, who publishes it, the account, and where the browser will be sent back.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean. Users `alice` and `bob`, password `parlor-verify-hello`.

- **Sign in.** `$H browser <id> open /` lands on `heading "Sign in to Hello"`. `fill textbox Email alice@example.com`, `fill textbox Password wrong`, `click button "Sign in"`: `Invalid email or password` appears. Then `$H browser <id> signin alice`; the list shows the three baseline tasks.
- **Isolation over MCP.** `$H mcp <id> call createTask '{"title":"Alice via MCP"}'` answers `scope: "alice"`; `$H mcp <id> call listTasks '{}' --as bob` answers `[]`; `getTask` and `toggleTask` on `seed-baseline-1` as Bob answer `not_found`. Alice's tab shows the new task without a reload.
- **Isolation over sync.** Open two streams with curl, `curl -sN -m 6 -H 'accept: text/event-stream' -H "authorization: Bearer $($H token <id> --as alice)" '<server>/_parlor/sync/stream?since='` and the same `--as bob`, then create a task as Alice over HTTP. Alice's stream has a `"tasks"` event, Bob's has none.
- **Sign another place out.** Sign Alice in over HTTP with an iPhone user agent (`curl -D - -X POST <web>/_parlor/auth/sign-in/email -H 'origin: <web>' -H 'user-agent: Mozilla/5.0 (iPhone; ...) Version/18.0 Mobile/15E148 Safari/604.1' ...`), keep its `set-auth-token`, and hold a stream open with it. On `/settings` click `button "Sign out Safari on iOS"`: the stream ends within 5 s and the token answers 401.
- **Claude Code connects.** Follow "MCP through Claude Code's own OAuth" in SKILL.md: the consent page reads `Allow Claude Code to use Hello?` and `Published by claude.ai`; Allow ends the login with `Authenticated with "hello"`, `claude -p` creates a task, and `$H sql` shows it with `scope = 'alice'`. Settings lists Claude Code under Connected agents.
- **Deny.** Start another login and click `button "Deny"`: the login ends with `access_denied - User denied access`.
- **Revoke.** On `/settings` click `button "Revoke Claude Code"`; the next `claude -p` reports the server as `needs-auth`.
- **Mac.** `$H up --target mac --seed baseline`, then type the credentials with System Events (SKILL.md, Signing in). The window shows the tasks, and a task created with `$H mcp <id> call createTask` appears in it.

## Gotchas

- `seed`, `sql`, `stop` and `start` restart the instance's Chrome with an empty profile, so the tab is signed out afterwards; that is the harness, not the app.
- The harness's own OAuth client `verify-hello` shows up under Connected agents for Alice once `mcp` or `agent` ran.
- Claude Code's CIMD client id makes the server fetch `https://claude.ai/oauth/claude-code-client-metadata`, so the Claude Code recipes need the internet.
