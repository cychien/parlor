# Agent UI: ui_screen and ui_navigate

An external agent can see what the user has on screen and move the app to another page. `ui_screen` returns the current route, the action queries feeding it, the tasks rendered in the viewport with which one is in the middle, and the connected clients. `ui_navigate` moves a connected client to one of the app's routes, or returns a link when no app is open. The route catalog, with each route's description, is in `ui_navigate`'s tool description, so the agent knows the pages before it calls anything.

## Sub-features

- `ui-screen` reports route `/`, a `listTasks` query, and the `task` items in screen order with title and done state.
- `ui-this` lets a plain "this task" request resolve to the task centered in the viewport.
- `ui-navigate` moves the app to `/settings` or `/tasks/<id>` from a plain-language request.
- `ui-unreachable` returns `reachable: false`, reason `no_client`, and for navigation an `href` on the web port, when no app is open.
- `ui-clients` targets a given `clientId`, lists the others, drops closed or reloaded tabs within 2 s, and rejects an unknown id with `unknown_client`.
- `ui-catalog` lists both tools next to the actions, with the three routes in the description and as the `to` enum; `GET /_parlor/manifest` carries the same routes under `ui`.
- `ui-policy` hides both tools with `agentUi: { external: false }` and keeps only `ui_screen` with `"read-only"`.
- `ui-activity` shows the app's activity pill while an agent request runs.

## How to get to it (user POV)

- Open the app on any route, connect an agent to `http://localhost:<server>/_parlor/mcp`, and ask "what am I looking at?", "mark this task as done", "where do I change the settings? take me there", or "open the task Write report".
- With the app closed, ask the same navigation question and open the link the agent returns.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline` (or `s30` for `ui-this`), doctor clean, and a page opened with `$H browser <id> open /` so a client is connected. For mac or iOS use `--target mac` or `--target ios`; the app window is the client.
- `claude` is on PATH and logged in.

- **Catalog.** Run `$H mcp <id> tools > $E/tools.json`. It lists every action plus `ui_screen` and `ui_navigate`; `ui_navigate`'s description names `/`, `/tasks/$taskId`, `/settings` with their descriptions and its `to` schema is an enum of exactly those three. `curl -s <web>/_parlor/manifest` has `ui.routes` with the same paths.
- **Screen.** Run `$H mcp <id> call ui_screen '{}'`. `route.path` is `/`, `queries` includes `listTasks`, and `views.task.items` lists `Buy milk`, `Write report`, `Call Amy` in that order; `client.platform` is `web`, `tauri`, or `capacitor` by target.
- **This task.** Load `s30`, open `/`, then `$H browser <id> eval "document.querySelectorAll('li')[14].scrollIntoView({block:'center'})"` so `Task 15` is centered. Run `$H agent <id> --out $E/agent "mark this task as done"`. Read back with `$H mcp <id> call listTasks '{}'`: only `Task 15` is done, and the page shows it checked without a reload.
- **Navigate.** Run `$H agent <id> --out $E/agent "where do I change the app settings? take me there"`. The transcript shows `mcp__hello__ui_navigate` with `to: "/settings"`; `$H browser <id> snapshot` shows heading `Settings` and the URL path `/settings`. For a param route ask "open the task Write report"; the URL path becomes `/tasks/seed-baseline-2`.
- **Unreachable.** Use an instance where no page was opened (skip `$H browser <id> open`), then `$H mcp <id> call ui_navigate '{"to":"/settings"}'`. The result has `reachable: false`, `reason: "no_client"`, and an `href` on the web port; opening that href shows Settings.
- **Clients.** Open a second tab on `/settings` through the axi pass-through, then call `ui_screen` with and without `clientId`. With an id the result's `client.id` matches it; without one `otherClients` lists the rest. Close or reload a tab and call again after 2 s: it is gone. `$H mcp <id> call ui_screen '{"clientId":"does-not-exist"}'` is an error with code `unknown_client` that lists the connected ids.
- **Policy.** Find the snapshot with `$H info <id>`, edit its `examples/hello/server.ts` to pass `agentUi: { external: false }` or `agentUi: { external: "read-only" }` to `createServer`, restart with `$H stop <id> && $H start <id>`, and list tools again. Never edit the checkout itself for this.
- **Activity.** Throttle the page (axi network throttling, Slow 3G), call `ui_navigate` to `/tasks/seed-baseline-1`, and screenshot during the call: the pill reads "Agent is opening a page", then "Agent opened this page", then disappears within 3 s.

## Gotchas

- Headless Chrome sends no `blur` or `visibilitychange` to background tabs, so two open tabs both report focused and `ui_navigate` without `clientId` answers `ambiguous_client`. That is the designed answer to a tie; pass a `clientId`.
- A mac window behind the terminal reports `visible: false`; the screenshot still captures it by window id.
- Navigation to `/settings` finishes within one frame, so the activity pill is only observable on a slowed page.
- The agent may answer in another language; assert on tool calls, results, and the stored state, not on its wording.
